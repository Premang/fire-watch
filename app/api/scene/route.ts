// Data for the 3D fire view: VIIRS detections around a point (NASA FIRMS) and the wind at the time of the satellite pass (Open-Meteo).
// Modes: ?lat&lon[&date=YYYY-MM-DD][&time=ISO]  ·  ?month=YYYY-MM&west&south&east&north (finds the busiest day and place of that month).
import { assembleScene, parseDetections, peakOfMonth, type Detection, type SceneResponse } from "@/lib/scene-data";

const FIRMS = "https://firms.modaps.eosdis.nasa.gov", RADIUS_KM = 45, DAY = 86400000;
const FAMILIES: [string | null, string][] = [["VIIRS_SNPP_SP", "VIIRS_SNPP_NRT"], ["VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT"], ["VIIRS_NOAA21_SP", "VIIRS_NOAA21_NRT"]];
const cache = new Map<string, { at: number; body: SceneResponse }>();
let availability: { at: number; ranges: Record<string, [string, string]> } | null = null;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10), fail = (error: string, status: number) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

async function dataAvailability(key: string) {
  if (availability && Date.now() - availability.at < 3600_000) return availability.ranges;
  const res = await fetch(`${FIRMS}/api/data_availability/csv/${encodeURIComponent(key)}/all`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`NASA FIRMS data availability: HTTP ${res.status}`);
  const lines = (await res.text()).trim().split(/\r?\n/), h = lines[0].split(",").map(x => x.trim()), [i, a, b] = ["data_id", "min_date", "max_date"].map(k => h.indexOf(k));
  if (i < 0 || a < 0 || b < 0) throw new Error("NASA FIRMS data availability: unexpected format.");
  const ranges: Record<string, [string, string]> = {};
  for (const l of lines.slice(1)) { const c = l.split(",").map(x => x.trim()); if (c[i] && /^\d{4}-\d{2}-\d{2}$/.test(c[a] ?? "") && /^\d{4}-\d{2}-\d{2}$/.test(c[b] ?? "")) ranges[c[i]] = [c[a], c[b]]; }
  availability = { at: Date.now(), ranges }; return ranges;
}
/** Detections for a list of consecutive days. Standard-processing data where NASA has it for the day, near-real-time otherwise, never both. */
async function fetchDays(key: string, box: [number, number, number, number], days: string[], families: [string | null, string][], notes: string[]) {
  const ranges = await dataAvailability(key), has = (id: string | null, day: string) => !!id && !!ranges[id] && ranges[id][0] <= day && ranges[id][1] >= day, area = box.map(n => n.toFixed(4)).join(","), jobs: Promise<Detection[]>[] = [];
  for (const [sp, nrt] of families) {
    const pick = days.map(d => (has(sp, d) ? sp : has(nrt, d) ? nrt : null));
    for (let i = 0; i < days.length;) {
      const src = pick[i]; let j = i + 1; while (j < days.length && pick[j] === src && j - i < 5) j++;
      if (src) { const url = `${FIRMS}/api/area/csv/${encodeURIComponent(key)}/${src}/${area}/${j - i}/${days[i]}`;
        jobs.push(fetch(url, { signal: AbortSignal.timeout(45000) }).then(async r => { const t = await r.text(); if (!r.ok || !t.startsWith("latitude")) { notes.push(`${src}: ${r.ok ? "unexpected response" : `HTTP ${r.status}`}`); return []; } return parseDetections(t); }).catch(() => { notes.push(`${src}: request failed`); return []; })); }
      i = j;
    }
  }
  return (await Promise.all(jobs)).flat();
}
/** Wind at the hour of the pass: ERA5 reanalysis for past dates, the weather model's recent analysis for the last few days. Null if unavailable. */
async function windAt(lat: number, lon: number, t: number): Promise<SceneResponse["wind"]> {
  try {
    const old = Date.now() - t > 6 * DAY, day = iso(t), v = old ? "100m" : "80m";
    const url = `${old ? "https://archive-api.open-meteo.com/v1/archive" : "https://api.open-meteo.com/v1/forecast"}?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&hourly=wind_speed_${v},wind_direction_${v}&wind_speed_unit=ms&timezone=UTC&${old ? `start_date=${day}&end_date=${day}` : "past_days=7&forecast_days=1"}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) }); if (!res.ok) return null;
    const j = await res.json() as { hourly?: Record<string, (number | string | null)[]> }, times = (j.hourly?.time ?? []) as string[];
    let k = -1, best = Infinity; times.forEach((s, i) => { const d = Math.abs(Date.parse(`${s}:00Z`) - t); if (d < best) { best = d; k = i; } });
    const speed = Number(j.hourly?.[`wind_speed_${v}`]?.[k]), dir = Number(j.hourly?.[`wind_direction_${v}`]?.[k]);
    if (k < 0 || best > 2 * 3600000 || !Number.isFinite(speed) || !Number.isFinite(dir)) return null;
    return { speed, dirFrom: dir, source: old ? "ERA5 reanalysis, wind at 100 m, via Open-Meteo" : "Weather-model analysis, wind at 80 m, via Open-Meteo" };
  } catch { return null; }
}

export async function GET(request: Request) {
  const url = new URL(request.url), q = url.searchParams, key = (process.env.FIRMS_MAP_KEY ?? "").trim(), notes: string[] = [];
  const name = (q.get("name") ?? "").replace(/[<>]/g, "").slice(0, 80) || undefined, month = q.get("month");
  let lat = Number(q.get("lat")), lon = Number(q.get("lon")), date = q.get("date"), time = q.get("time") ? Date.parse(q.get("time")!) : undefined;
  if (time !== undefined && !Number.isFinite(time)) return fail("Provide the time as an ISO date-time.", 400);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail("Provide the date as YYYY-MM-DD.", 400);
  const cacheKey = q.toString(), hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < 10 * 60_000) return Response.json(hit.body, { headers: { "cache-control": "private, max-age=300" } });
  try {
    if (month) { // find the busiest day and place of a calendar month inside a box
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return fail("Provide the month as YYYY-MM.", 400);
      const box = ["west", "south", "east", "north"].map(k => Number(q.get(k))) as [number, number, number, number];
      if (!box.every(Number.isFinite) || box[0] >= box[2] || box[1] >= box[3]) return fail("Provide the area as west, south, east, north.", 400);
      if ((box[2] - box[0]) * (box[3] - box[1]) > 200) return fail("That area is too large to search for a single fire. Pick a province or a smaller area.", 413);
      if (!key) return fail("Searching a past month needs the NASA FIRMS archive key on the server.", 501);
      const start = Date.parse(`${month}-01T00:00:00Z`), end = Math.min(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() + 1, 0), Date.now()), days: string[] = [];
      for (let t = start; t <= end; t += DAY) days.push(iso(t));
      const ranges = await dataAvailability(key), fam = FAMILIES.find(([sp, nrt]) => [sp, nrt].some(id => id && ranges[id] && ranges[id][0] <= days[0] && ranges[id][1] >= days[0])) ?? FAMILIES[1];
      const peak = peakOfMonth(await fetchDays(key, box, days, [fam], notes));
      if (!peak) return fail(`No VIIRS fire detections in this area in ${month}.`, 404);
      lat = peak.lat; lon = peak.lon; date = peak.day; time = undefined;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180 || (!q.get("lat") && !month)) return fail("Provide a latitude and longitude.", 400);
    const today = Date.parse(`${iso(Date.now())}T00:00:00Z`), last = Math.min(time !== undefined ? Date.parse(`${iso(time)}T00:00:00Z`) : date ? Date.parse(`${date}T00:00:00Z`) : today, today);
    const days = [3, 2, 1, 0].map(k => iso(last - k * DAY)), dLat = RADIUS_KM / 111.2 * 1.15, dLon = dLat / Math.max(0.2, Math.cos(lat * Math.PI / 180)), box: [number, number, number, number] = [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
    let dets: Detection[];
    if (key) dets = await fetchDays(key, box, days, FAMILIES, notes);
    else { // without the archive key only NASA's public 7-day files are available, through this site's own hotspot export
      if (today - last > 6 * DAY) return fail("Dates more than a week back need the NASA FIRMS archive key on the server.", 501);
      const months = [...new Set(days.map(d => d.slice(0, 7)))].sort(), res = await fetch(new URL(`/api/hotspots?west=${box[0].toFixed(4)}&south=${box[1].toFixed(4)}&east=${box[2].toFixed(4)}&north=${box[3].toFixed(4)}&from=${months[0]}&to=${months[months.length - 1]}`, url.origin));
      if (!res.ok) return fail("NASA FIRMS near-real-time files could not be read. Try again shortly.", 502);
      dets = parseDetections(await res.text()).filter(d => d.time >= last - 3 * DAY); notes.push("NASA public 7-day files (no archive key)");
    }
    const scene = assembleScene(dets, { lat, lon }, RADIUS_KM, { wantTime: time, wantDay: date ?? undefined });
    if (!scene) return fail(`No VIIRS fire detections within ${RADIUS_KM} km of this point between ${days[0]} and ${days[3]}.`, 404);
    const wind = await windAt(scene.center.lat, scene.center.lon, Date.parse(scene.timeUTC));
    if (!wind) notes.push("No wind record was available; the smoke direction is a placeholder.");
    const body: SceneResponse = { ...scene, wind, place: name, notes };
    cache.set(cacheKey, { at: Date.now(), body }); if (cache.size > 60) cache.delete(cache.keys().next().value!);
    return Response.json(body, { headers: { "cache-control": "private, max-age=300" } });
  } catch (e) { return fail(e instanceof Error ? e.message : "The fire data could not be loaded.", 502); }
}
