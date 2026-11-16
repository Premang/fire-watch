// Builds the data for the 3D fire view from NASA FIRMS VIIRS detections and a wind record.
// Pure helpers (parsing, grouping into satellite passes) are separate from the fetching so they can be tested.
import type { SceneData, SceneFire } from "./scene3d/types";

export interface Detection { lat: number; lon: number; frp: number; time: number; satellite: string; night: boolean }
export interface PassInfo { time: string; satellite: string; count: number; night: boolean }
export interface SceneResponse extends SceneData { passes: PassInfo[]; radiusKm: number; notes: string[] }

const SAT: Record<string, string> = { N: "Suomi NPP", N20: "NOAA-20", "1": "NOAA-20", N21: "NOAA-21", "2": "NOAA-21" };

/** Parse a FIRMS CSV (Area API or the site's own hotspot export) into VIIRS detections. Other instruments are skipped: MODIS pixels are about 1 km, too coarse to place flames. */
export function parseDetections(csv: string): Detection[] {
  const lines = csv.split(/\r?\n/).filter(l => l && !l.startsWith("#")); if (lines.length < 2) return [];
  const h = lines[0].split(",").map(s => s.trim()), col = (k: string) => h.indexOf(k), [la, lo, d, t, s, f, dn, ins] = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "frp", "daynight", "instrument"].map(col);
  if (la < 0 || lo < 0 || d < 0 || t < 0) return [];
  const out: Detection[] = [];
  for (const line of lines.slice(1)) {
    const v = line.split(","), lat = Number(v[la]), lon = Number(v[lo]), hm = (v[t] ?? "").trim().padStart(4, "0"), time = Date.parse(`${(v[d] ?? "").trim()}T${hm.slice(0, 2)}:${hm.slice(2)}:00Z`);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(time)) continue;
    if (ins >= 0 && v[ins] && !/VIIRS/i.test(v[ins])) continue;
    const sat = (v[s] ?? "").trim();
    out.push({ lat, lon, frp: Number(v[f]) || 0, time, satellite: SAT[sat] ?? (sat || "VIIRS"), night: (v[dn] ?? "").trim() === "N" });
  }
  return out;
}
export const distKm = (aLat: number, aLon: number, bLat: number, bLon: number) => Math.hypot((aLat - bLat) * 111.2, (aLon - bLon) * 111.2 * Math.cos((aLat + bLat) / 2 * Math.PI / 180));

/** Group detections into satellite passes: same satellite, no gap longer than 15 minutes. Newest first. */
export function groupPasses(dets: Detection[]): { info: PassInfo; dets: Detection[] }[] {
  const by = new Map<string, Detection[]>(); for (const d of dets) { if (!by.has(d.satellite)) by.set(d.satellite, []); by.get(d.satellite)!.push(d); }
  const out: { info: PassInfo; dets: Detection[] }[] = [];
  for (const [satellite, list] of by) {
    list.sort((a, b) => a.time - b.time); let cur: Detection[] = [];
    const flush = () => { if (cur.length) { const mid = cur[Math.floor(cur.length / 2)]; out.push({ info: { time: new Date(mid.time).toISOString(), satellite, count: cur.length, night: cur.filter(c => c.night).length * 2 > cur.length }, dets: cur }); cur = []; } };
    for (const d of list) { if (cur.length && d.time - cur[cur.length - 1].time > 15 * 60000) flush(); cur.push(d); }
    flush();
  }
  return out.sort((a, b) => Date.parse(b.info.time) - Date.parse(a.info.time));
}
/**
 * Choose the pass to show and assemble the scene. `wantTime` picks the nearest pass; `wantDay` (YYYY-MM-DD) picks the busiest pass of that UTC day;
 * otherwise the newest pass with at least three detections is used (or the newest of any size).
 */
export function assembleScene(all: Detection[], center: { lat: number; lon: number }, radiusKm: number, opts: { wantTime?: number; wantDay?: string } = {}): Omit<SceneResponse, "wind" | "notes"> | null {
  const near = all.filter(d => distKm(d.lat, d.lon, center.lat, center.lon) <= radiusKm), passes = groupPasses(near); if (!passes.length) return null;
  let pick = passes.find(p => p.dets.length >= 3) ?? passes[0];
  if (opts.wantTime !== undefined) pick = passes.reduce((a, b) => (Math.abs(Date.parse(b.info.time) - opts.wantTime!) < Math.abs(Date.parse(a.info.time) - opts.wantTime!) ? b : a));
  else if (opts.wantDay) { const day = passes.filter(p => p.info.time.slice(0, 10) === opts.wantDay); if (day.length) pick = day.reduce((a, b) => (b.dets.length > a.dets.length ? b : a)); }
  const t0 = Date.parse(pick.info.time), active = new Set(pick.dets);
  const fires: SceneFire[] = [];
  for (const d of near) { const age = active.has(d) ? 0 : (t0 - d.time) / 3600000; if (age < 0 || age > 96) continue; fires.push({ lat: d.lat, lon: d.lon, frp: d.frp, ageHours: Math.round(Math.max(age, active.has(d) ? 0 : 0.6) * 100) / 100 }); }
  let w = 0, lat = 0, lon = 0; for (const d of pick.dets) { const k = Math.sqrt(Math.max(d.frp, 1)); w += k; lat += d.lat * k; lon += d.lon * k; }
  return { center: { lat: lat / w, lon: lon / w }, timeUTC: pick.info.time, fires, satellite: `VIIRS ${pick.info.satellite}`, passes: passes.map(p => p.info), radiusKm };
}
/** Busiest day and place in a month of detections: the 0.25 degree cell-day with the most detections. */
export function peakOfMonth(dets: Detection[]): { day: string; lat: number; lon: number; count: number } | null {
  const cells = new Map<string, Detection[]>();
  for (const d of dets) { const k = `${new Date(d.time).toISOString().slice(0, 10)}|${Math.floor(d.lat * 4)}|${Math.floor(d.lon * 4)}`; if (!cells.has(k)) cells.set(k, []); cells.get(k)!.push(d); }
  let best: Detection[] | null = null, key = ""; for (const [k, v] of cells) if (!best || v.length > best.length) { best = v; key = k; }
  if (!best) return null;
  return { day: key.split("|")[0], lat: best.reduce((s, d) => s + d.lat, 0) / best.length, lon: best.reduce((s, d) => s + d.lon, 0) / best.length, count: best.length };
}
