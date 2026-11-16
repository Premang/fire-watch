// Browser client for /api/hotspots: splits areas at the antimeridian, keeps the server's warnings and coverage headers.
import { aoiBoxes, containsPoint, type Aoi } from "./data";
import { csvNotes, type Availability, type RecentWindow } from "./recent";

export interface HotspotInfo { archive: boolean; maxDays: number }
let info: Promise<HotspotInfo> | null = null;
/** Whether the server has a FIRMS key (archive export for any period up to maxDays) or only the public 7-day files. */
export function hotspotInfo(): Promise<HotspotInfo> {
  info ??= fetch("/api/hotspots?info=1").then(r => r.json() as Promise<HotspotInfo>).catch(() => { info = null; return { archive: false, maxDays: 62 }; });
  return info;
}

export interface HotspotResult { header: string; lines: string[]; notes: string[]; source: string; range: string; window: RecentWindow | null; availability: Availability | null }

/** Fetch individual detections for the AOI's bounding box(es); `lines` keeps only rows inside the exact AOI shape. */
export async function fetchHotspots(aoi: Aoi, from: string, to: string): Promise<HotspotResult> {
  const parts = await Promise.all(aoiBoxes(aoi).map(async b => {
    const q = new URLSearchParams({ west: b.west.toFixed(4), south: b.south.toFixed(4), east: b.east.toFixed(4), north: b.north.toFixed(4), from, to });
    const res = await fetch(`/api/hotspots?${q}`);
    if (!res.ok) { const e = await res.json().catch(() => ({})) as { error?: string }; throw new Error(e.error ?? `The hotspot service failed (HTTP ${res.status}).`); }
    return { text: await res.text(), h: res.headers };
  }));
  const first = parts[0], all = parts.flatMap(p => p.text.split(/\r?\n/).filter(l => l && !l.startsWith("#")));
  const header = all[0] ?? "", hi = header.split(","), li = hi.indexOf("latitude"), oi = hi.indexOf("longitude");
  const lines = parts.flatMap(p => p.text.split(/\r?\n/).filter(l => l && !l.startsWith("#")).slice(1))
    .filter(l => { const c = l.split(","); return containsPoint(aoi, Number(c[oi]), Number(c[li])); });
  const notes = [...new Set(parts.flatMap(p => csvNotes(p.text)))];
  const w = first.h.get("x-hotspot-window")?.split(",");
  // Coverage must hold for EVERY box of the area: a platform-day counts only if each box reports it (minimum across boxes).
  let availability: Availability | null = null;
  try {
    const per = parts.map(p => { const a = p.h.get("x-hotspot-availability"); return a ? JSON.parse(a) as Availability : null; });
    if (per.every(Boolean)) {
      const out: Availability = {};
      for (const k of ["noaa20", "noaa21", "modis"] as const) {
        const days = new Set(per.flatMap(a => Object.keys(a![k] ?? {})));
        out[k] = Object.fromEntries([...days].map(d => [d, Math.min(...per.map(a => a![k]?.[d] ?? 0))]));
      }
      availability = out;
    }
  } catch { availability = null; }
  return { header, lines, notes, source: first.h.get("x-hotspot-source") ?? "NASA FIRMS", range: first.h.get("x-hotspot-range") ?? `${from}_${to}`,
    window: w && w.length === 2 && /^\d{4}-\d{2}-\d{2}$/.test(w[0]) && /^\d{4}-\d{2}-\d{2}$/.test(w[1]) ? { first: w[0], last: w[1] } : null, availability };
}
