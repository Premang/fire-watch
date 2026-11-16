// Individual hotspot export for an AOI bounding box (the client trims to the exact shape).
// With FIRMS_MAP_KEY: NASA FIRMS Area API, standard-processing (SP) and near-real-time (NRT) sources, 5-day requests,
//   at most MAX_DAYS per export (long periods belong in the monthly calendar CSV).
// Without a key: NASA FIRMS public global 7-day files (MODIS C6.1, VIIRS NOAA-20, VIIRS NOAA-21), streamed and filtered.
const FIRMS = "https://firms.modaps.eosdis.nasa.gov";
const MAX_DAYS = 62, MAX_ROWS = 200_000, MAX_STREAM_BYTES = 120_000_000;
const OUT_COLUMNS = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "instrument", "confidence", "frp", "daynight", "type", "source_dataset"];
const PUBLIC_7D = [
  { name: "MODIS C6.1 NRT (Terra/Aqua)", platform: "modis", url: `${FIRMS}/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_7d.csv` },
  { name: "VIIRS NOAA-20 NRT", platform: "noaa20", url: `${FIRMS}/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_7d.csv` },
  { name: "VIIRS NOAA-21 NRT", platform: "noaa21", url: `${FIRMS}/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_7d.csv` },
] as const;
type Extra = Record<string, string>;
const cache = new Map<string, { at: number; body: string; source: string; range: string; extra: Extra }>();

/** Compact in-memory copy of one public global 7-day file (~20 bytes per detection), shared by all AOIs for 10 minutes. */
type Columns = { at: number; n: number; lat: Float32Array; lon: Float32Array; day: Uint16Array; time: Uint16Array; frp: Float32Array; text: string[]; perDay: Record<string, number>; first: string | null; last: string | null };
const globalCache = new Map<string, Promise<Columns>>();
const DAY0 = Date.UTC(2000, 0, 1);
async function loadGlobal(url: string, label: string): Promise<Columns> {
  const hit = globalCache.get(url);
  if (hit) { const c = await hit.catch(() => null); if (c && Date.now() - c.at < 10 * 60_000) return c; }
  const task = (async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok || !res.body) throw new Error(`${label}: HTTP ${res.status}`);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "", header: string[] | null = null, bytes = 0, n = 0, cap = 1 << 16;
    let lat = new Float32Array(cap), lon = new Float32Array(cap), day = new Uint16Array(cap), time = new Uint16Array(cap), frp = new Float32Array(cap);
    const text: string[] = [], perDay: Record<string, number> = {};
    const grow = () => { cap *= 2; const g = <T extends Float32Array | Uint16Array>(a: T, C: new (n: number) => T) => { const b = new C(cap); b.set(a); return b; };
      lat = g(lat, Float32Array); lon = g(lon, Float32Array); day = g(day, Uint16Array); time = g(time, Uint16Array); frp = g(frp, Float32Array); };
    const handle = (line: string) => {
      if (!line.trim()) return;
      const v = line.split(",");
      if (!header) { header = v.map(x => x.trim()); if (!["latitude", "longitude", "acq_date"].every(k => header!.includes(k))) throw new Error(`${label}: unexpected response (not a FIRMS CSV)`); return; }
      const get = (k: string) => { const i = header!.indexOf(k); return i < 0 ? "" : (v[i] ?? "").trim(); };
      const la = Number(get("latitude")), lo = Number(get("longitude")), d = Date.parse(`${get("acq_date")}T00:00:00Z`);
      if (!Number.isFinite(la) || !Number.isFinite(lo) || !Number.isFinite(d)) return;
      if (n === cap) grow();
      lat[n] = la; lon[n] = lo; day[n] = Math.round((d - DAY0) / 86400000); time[n] = Number(get("acq_time")) || 0; frp[n] = Number(get("frp")) || 0;
      const ds = get("acq_date"); perDay[ds] = (perDay[ds] ?? 0) + 1;
      text.push([get("satellite"), get("instrument") || (label.includes("MODIS") ? "MODIS" : "VIIRS"), get("confidence"), get("daynight"), get("type")].join(","));
      n++;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > MAX_STREAM_BYTES) throw new Error(`${label} exceeded the processing limit.`);
        buf += dec.decode(value, { stream: true }); const lines = buf.split("\n"); buf = lines.pop() ?? ""; for (const l of lines) handle(l);
      }
      buf += dec.decode(); if (buf) handle(buf);
      if (!header) throw new Error(`${label}: empty response`);
    } catch (e) { await reader.cancel().catch(() => {}); throw e; }
    const days = Object.keys(perDay).sort();
    return { at: Date.now(), n, lat, lon, day, time, frp, text, perDay, first: days[0] ?? null, last: days.at(-1) ?? null };
  })();
  globalCache.set(url, task);
  task.catch(() => globalCache.delete(url));
  return task;
}
function filterGlobal(c: Columns, box: Box, label: string, rows: string[]) {
  for (let i = 0; i < c.n; i++) {
    const la = c.lat[i], lo = c.lon[i];
    if (la < box.south || la > box.north || lo < box.west || lo > box.east) continue;
    if (rows.length >= MAX_ROWS) throw new Error("Too many hotspots for one export; narrow the area or period.");
    const [sat, inst, conf, dn, type] = c.text[i].split(",");
    rows.push([la.toFixed(5), lo.toFixed(5), new Date(DAY0 + c.day[i] * 86400000).toISOString().slice(0, 10), String(c.time[i]).padStart(4, "0"), sat, inst, conf, c.frp[i].toFixed(2), dn, type, label].join(","));
  }
}

type Box = { west: number; south: number; east: number; north: number };
function parseBox(q: URLSearchParams): Box | null {
  const b = { west: Number(q.get("west")), south: Number(q.get("south")), east: Number(q.get("east")), north: Number(q.get("north")) };
  if (!Object.values(b).every(Number.isFinite) || b.west >= b.east || b.south >= b.north || Math.abs(b.south) > 90 || Math.abs(b.north) > 90 || Math.abs(b.west) > 180 || Math.abs(b.east) > 180) return null;
  if ((b.east - b.west) * (b.north - b.south) > 2500) return null; // ~50 x 50 degrees max
  return b;
}
const monthOk = (m: string | null): m is string => !!m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);

async function streamCsv(url: string, box: Box, label: string, rows: string[], dateRange?: [string, string]): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!res.ok || !res.body) return { ok: false, error: `${label}: HTTP ${res.status}` };
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = "", header: string[] | null = null, bytes = 0;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const v = line.split(",");
    if (!header) { header = v.map(s => s.trim()); if (!["latitude", "longitude", "acq_date"].every(k => header!.includes(k))) throw new SchemaError(`${label}: unexpected response "${line.slice(0, 60)}"`); return; }
    const get = (k: string) => { const i = header!.indexOf(k); return i < 0 ? "" : (v[i] ?? "").trim(); };
    const lat = Number(get("latitude")), lon = Number(get("longitude"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < box.south || lat > box.north || lon < box.west || lon > box.east) return;
    const date = get("acq_date");
    if (dateRange && (date < dateRange[0] || date > dateRange[1])) return;
    if (rows.length >= MAX_ROWS) throw new Error("Too many hotspots for one export; narrow the area or period.");
    rows.push([lat, lon, date, get("acq_time"), get("satellite"), get("instrument") || (label.includes("MODIS") ? "MODIS" : "VIIRS"), get("confidence"), get("frp"), get("daynight"), get("type"), label].join(","));
  };
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > MAX_STREAM_BYTES) throw new Error(`${label} exceeded the processing limit.`);
      buf += dec.decode(value, { stream: true }); const lines = buf.split("\n"); buf = lines.pop() ?? ""; for (const l of lines) handle(l);
    }
    buf += dec.decode(); if (buf) handle(buf);
  } catch (e) { await reader.cancel().catch(() => {}); if (e instanceof SchemaError) return { ok: false, error: e.message }; throw e; }
  // FIRMS answers "no fires" with a header-only CSV; an empty body is not a valid answer.
  return header ? { ok: true } : { ok: false, error: `${label}: empty response` };
}
class SchemaError extends Error {}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams, box = parseBox(q), from = q.get("from"), to = q.get("to");
  if (q.get("info") === "1") return Response.json({ archive: !!(process.env.FIRMS_MAP_KEY ?? "").trim(), maxDays: MAX_DAYS }, { headers: { "cache-control": "no-store" } });
  if (!box) return Response.json({ error: "Provide a valid area of at most about 50 x 50 degrees." }, { status: 400 });
  if (!monthOk(from) || !monthOk(to) || from > to) return Response.json({ error: "Provide a valid period (from <= to, YYYY-MM)." }, { status: 400 });
  const key = (process.env.FIRMS_MAP_KEY ?? "").trim();
  const cacheKey = `${key ? "api" : "7d"}|${Object.values(box).map(n => n.toFixed(3)).join(",")}|${from}|${to}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < 10 * 60_000) return csvResponse(hit.body, hit.source, hit.range, hit.extra);
  const rows: string[] = []; const notes: string[] = [];
  try {
    if (key) {
      const start = new Date(`${from}-01T00:00:00Z`), endMonth = new Date(`${to}-01T00:00:00Z`);
      const end = new Date(Date.UTC(endMonth.getUTCFullYear(), endMonth.getUTCMonth() + 1, 0));
      const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
      const stop = end > today ? today : end, days = Math.round((stop.getTime() - start.getTime()) / 86400000) + 1;
      if (days > MAX_DAYS) return Response.json({ error: `Individual hotspots are exported for up to ${MAX_DAYS} days at a time. Narrow the period, or use the monthly calendar CSV for long records.` }, { status: 413 });
      // Route by NASA's own data-availability table, DAY BY DAY: standard processing (SP) where it covers the day, otherwise
      // near-real-time (NRT); never both (no duplicates in the overlap). Consecutive days with the same source are then
      // requested in chunks of up to 5 days, so an SP/NRT boundary inside a chunk loses nothing (Astra 15a).
      const ranges = await dataAvailability(key);
      const area = [box.west, box.south, box.east, box.north].map(n => n.toFixed(4)).join(","), used = new Set<string>(), gaps: string[] = [];
      const has = (id: string | null, day: string) => !!id && !!ranges[id] && ranges[id][0] <= day && ranges[id][1] >= day;
      const dayList: string[] = [];
      for (let d = new Date(start); d <= stop; d = new Date(d.getTime() + 86400000)) dayList.push(d.toISOString().slice(0, 10));
      const coverage: Record<string, Record<string, number>> = { modis: {}, snpp: {}, noaa20: {}, noaa21: {} };
      for (const [sp, nrt] of FAMILIES) {
        const plat = nrt.startsWith("MODIS") ? "modis" : nrt.includes("SNPP") ? "snpp" : nrt.includes("NOAA20") ? "noaa20" : "noaa21";
        const pick = dayList.map(day => (has(sp, day) ? sp : has(nrt, day) ? nrt : null));
        dayList.forEach((day, i) => { coverage[plat][day] = pick[i] ? 1 : 0; });
        for (let i = 0; i < dayList.length;) {
          const src = pick[i];
          let j = i + 1; while (j < dayList.length && pick[j] === src && j - i < 5) j++;
          if (!src) { if (ranges[nrt] || (sp && ranges[sp])) gaps.push(`${nrt.replace("_NRT", "")} ${dayList[i]}`); i = j; continue; }
          const r = await streamCsv(`${FIRMS}/api/area/csv/${encodeURIComponent(key)}/${src}/${area}/${j - i}/${dayList[i]}`, box, src, rows, [from + "-01", stop.toISOString().slice(0, 10)]);
          if (r.ok) used.add(src); else { notes.push(r.error ?? src); for (let k = i; k < j; k++) coverage[plat][dayList[k]] = 0; }
          i = j;
        }
      }
      if (!used.size) return Response.json({ error: `NASA FIRMS did not return data for this period (${[...notes, ...gaps.slice(0, 3)].join("; ") || "no source covers it"}).` }, { status: 502 });
      if (gaps.length) notes.push(`no ${gaps.length > 3 ? `${gaps.length} source-chunks` : gaps.join(", ")} in NASA's availability table`);
      const sources = [...used];
      // Window: the day before the period and the day after it (or today, which is partial) bound the complete days.
      const after = stop < today ? new Date(stop.getTime() + 86400000) : today;
      // Platform-day coverage from NASA's availability table (1 = a source covered the day and answered): the client never
      // assumes a platform observed a day it did not.
      const prev = new Date(start.getTime() - 86400000).toISOString().slice(0, 10), extra: Extra = { "x-hotspot-window": `${prev},${after.toISOString().slice(0, 10)}`, "x-hotspot-availability": JSON.stringify(coverage) };
      if (notes.length) extra["x-hotspot-notes"] = ascii(notes.join("; "));
      const body = toBody(rows, notes), source = `NASA FIRMS Area API (${sources.join(", ")})`, range = `${from}-01_${stop.toISOString().slice(0, 10)}`;
      cache.set(cacheKey, { at: Date.now(), body, source, range, extra }); return csvResponse(body, source, range, extra);
    }
    const loaded = await Promise.allSettled(PUBLIC_7D.map(f => loadGlobal(f.url, f.name)));
    const ok = loaded.flatMap((r, i) => r.status === "fulfilled" ? [{ c: r.value, f: PUBLIC_7D[i] }] : []);
    loaded.forEach((r, i) => { if (r.status === "rejected") notes.push(r.reason instanceof Error ? r.reason.message : PUBLIC_7D[i].name); });
    if (!ok.length) return Response.json({ error: `NASA FIRMS near-real-time files could not be read (${notes.join("; ")}). Try again shortly.` }, { status: 502 });
    for (const { c, f } of ok) filterGlobal(c, box, f.name, rows);
    const firsts = ok.map(x => x.c.first).filter((d): d is string => !!d).sort(), lasts = ok.map(x => x.c.last).filter((d): d is string => !!d).sort();
    const extra: Extra = { "x-hotspot-availability": JSON.stringify(Object.fromEntries(ok.map(({ c, f }) => [f.platform, c.perDay]))) };
    if (firsts.length) extra["x-hotspot-window"] = `${firsts[0]},${lasts.at(-1)}`;
    if (notes.length) extra["x-hotspot-notes"] = ascii(notes.join("; "));
    const body = toBody(rows, notes), source = "NASA FIRMS public global 7-day NRT files (no archive key configured)", range = "latest-7-days";
    cache.set(cacheKey, { at: Date.now(), body, source, range, extra }); return csvResponse(body, source, range, extra);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Hotspot export failed." }, { status: 502 });
  }
}

// (SP source or null, NRT source) per platform family, as named by the FIRMS Area API.
const FAMILIES: [string | null, string][] = [["MODIS_SP", "MODIS_NRT"], ["VIIRS_SNPP_SP", "VIIRS_SNPP_NRT"], ["VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT"], ["VIIRS_NOAA21_SP", "VIIRS_NOAA21_NRT"]];
let availability: { at: number; ranges: Record<string, [string, string]> } | null = null;
/** FIRMS data-availability table (data_id, min_date, max_date), cached for an hour. */
async function dataAvailability(key: string): Promise<Record<string, [string, string]>> {
  if (availability && Date.now() - availability.at < 3600_000) return availability.ranges;
  const res = await fetch(`${FIRMS}/api/data_availability/csv/${encodeURIComponent(key)}/all`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`NASA FIRMS data availability: HTTP ${res.status}`);
  const lines = (await res.text()).trim().split(/\r?\n/), h = lines[0].split(",").map(x => x.trim());
  const [i, a, b] = ["data_id", "min_date", "max_date"].map(k => h.indexOf(k));
  if (i < 0 || a < 0 || b < 0) throw new Error("NASA FIRMS data availability: unexpected format (check the MAP_KEY).");
  const ranges: Record<string, [string, string]> = {};
  for (const l of lines.slice(1)) { const c = l.split(",").map(x => x.trim()); if (c[i] && /^\d{4}-\d{2}-\d{2}$/.test(c[a] ?? "") && /^\d{4}-\d{2}-\d{2}$/.test(c[b] ?? "")) ranges[c[i]] = [c[a], c[b]]; }
  availability = { at: Date.now(), ranges }; return ranges;
}

function toBody(rows: string[], notes: string[]) {
  rows.sort();
  return [OUT_COLUMNS.join(","), ...rows].join("\r\n") + "\r\n" + (notes.length ? `# notes: ${notes.join("; ").replaceAll("\n", " ")}\r\n` : "");
}
function csvResponse(body: string, source: string, range: string, extra: Extra = {}) {
  return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "private, max-age=300", "x-hotspot-source": source, "x-hotspot-range": range,
    "access-control-expose-headers": "x-hotspot-source, x-hotspot-range, x-hotspot-window, x-hotspot-availability, x-hotspot-notes", ...extra } });
}
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, " ").slice(0, 600);
