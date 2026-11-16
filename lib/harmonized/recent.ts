// Near-real-time "recent days vs the usual pace" analysis (pure; tests in tests/harmonized-recent.test.ts).
//
// Comparability rules (Astra review 14):
//  - the comparison covers an explicit window of COMPLETE UTC days (the feed's first and last days are partial);
//  - a day counts if a platform was delivering data globally that day, judged from global detection counts
//    (>= 50% of that platform's median over the window), not from whether it happened to detect fire in the area;
//  - covered days with no detections in the area count as observed zeros;
//  - the expected value is built day by day from each day's own calendar month, so windows that cross a month
//    boundary are handled; it is a PACE (monthly median / days in month), not a historical weekly percentile.
import { containsPoint, lonLatToXY, type Aoi } from "./data";

export interface NrtRow { lat: number; lon: number; date: string; satellite: string; instrument: string; confidence: string; frp: number | null; source: string }

export function parseHotspotCsv(text: string): NrtRow[] {
  const lines = text.split(/\r?\n/).filter(l => l && !l.startsWith("#"));
  if (!lines.length) return [];
  const h = lines[0].split(","), ix = (k: string) => h.indexOf(k);
  const [la, lo, d, sa, ins, co, fr, src] = ["latitude", "longitude", "acq_date", "satellite", "instrument", "confidence", "frp", "source_dataset"].map(ix);
  return lines.slice(1).map(l => { const c = l.split(","); return { lat: Number(c[la]), lon: Number(c[lo]), date: c[d], satellite: (c[sa] ?? "").trim(), instrument: (c[ins] ?? "").trim(), confidence: (c[co] ?? "").trim().toLowerCase(), frp: c[fr] ? Number(c[fr]) : null, source: c[src] ?? "" }; })
    .filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon) && /^\d{4}-\d{2}-\d{2}$/.test(r.date));
}
/** Warning lines the server appends to a CSV ("# notes: ..."). */
export function csvNotes(text: string): string[] {
  return text.split(/\r?\n/).filter(l => l.startsWith("# notes:")).flatMap(l => l.slice(8).split(";").map(s => s.trim()).filter(Boolean));
}

export function cellKey(lon: number, lat: number): number {
  const [x, y] = lonLatToXY(lon, lat);
  return (Math.floor(x / 5) + 4096) * 8192 + (Math.floor(y / 5) + 4096);
}
export function staticSetFromBin(buf: ArrayBuffer): Set<number> {
  const a = new Int16Array(buf), s = new Set<number>();
  for (let i = 0; i + 1 < a.length; i += 2) s.add((a[i] + 4096) * 8192 + (a[i + 1] + 4096));
  return s;
}

export type Platform = "noaa20" | "noaa21" | "snpp" | "modis";
/** The satellite code is authoritative; the dataset label is only a fallback when the code is missing. */
export function platformOf(r: NrtRow): Platform | null {
  const s = r.satellite.toUpperCase(), src = r.source.toUpperCase();
  const bySat: Record<string, Platform> = { N20: "noaa20", "1": "noaa20", N21: "noaa21", "2": "noaa21", N: "snpp", T: "modis", A: "modis", TERRA: "modis", AQUA: "modis" };
  if (bySat[s]) return bySat[s];
  if (r.instrument.toUpperCase() === "MODIS" || src.includes("MODIS")) return "modis";
  if (src.includes("NOAA-21") || src.includes("NOAA21")) return "noaa21";
  if (src.includes("NOAA-20") || src.includes("NOAA20")) return "noaa20";
  if (src.includes("SNPP") || src.includes("S-NPP")) return "snpp";
  return null;
}
export function confident(r: NrtRow, p: Platform): boolean {
  if (p === "modis") { const c = Number(r.confidence); return Number.isFinite(c) && c >= 30; }
  return ["n", "h", "nominal", "high"].includes(r.confidence);
}

/** First and last UTC dates the feed covers; both are partial days. */
export interface RecentWindow { first: string; last: string }
/** Global detections per platform per UTC day (from the whole feed, not just the area). */
export type Availability = Partial<Record<"noaa20" | "noaa21" | "modis", Record<string, number>>>;

const DAY = 86400000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** Complete days strictly between the window's partial first and last days. */
export function windowDates(w: RecentWindow): string[] {
  const out: string[] = [];
  for (let d = addDays(w.first, 1); d < w.last && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}
const medianOf = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
/**
 * Platform-days delivering data: count >= 50% of the platform's median over the window (and > 0). Counts are global
 * detections (public 7-day files) or 1/0 coverage flags from NASA's availability table (keyed path). Without availability
 * information no day is assumed observed: unknown days are left out rather than counted as zero (Astra 15a).
 */
export function availableDays(av: Availability | null, dates: string[]): Record<"noaa20" | "noaa21", Set<string>> {
  const out = { noaa20: new Set<string>(), noaa21: new Set<string>() };
  if (!av) return out;
  for (const p of ["noaa20", "noaa21"] as const) {
    const counts = av[p] ?? {}, med = medianOf(dates.map(d => counts[d] ?? 0));
    for (const d of dates) if ((counts[d] ?? 0) > 0 && (counts[d] ?? 0) >= 0.5 * med) out[p].add(d);
  }
  return out;
}

export interface RecentDay { date: string; noaa20: number; noaa21: number; modis: number; harmonized: number | null; source: "noaa20" | "noaa21" | null }
export interface RecentResult { days: RecentDay[]; detections: number; maskedStatic: number; outsideAoi: number; lowConfidence: number; window: RecentWindow | null; availabilityChecked: boolean }

/**
 * Daily unique 5 km cells per platform inside the AOI over the window's complete days. harmonized = NOAA-20 cells if
 * NOAA-20 delivered data that day, else NOAA-21 (same VIIRS design), times the NOAA-20 -> S-NPP factor of the day's
 * calendar month; null when no VIIRS platform delivered data (the day is then left out of the comparison).
 */
export function recentDaily(rows: NrtRow[], aoi: Aoi, staticCells: Set<number>, noaa20ToSnpp: number[], window: RecentWindow | null, availability: Availability | null): RecentResult {
  const w = window ?? (() => { const ds = [...new Set(rows.map(r => r.date))].sort(); return ds.length ? { first: ds[0], last: ds.at(-1)! } : null; })();
  const dates = w ? windowDates(w) : [], inWindow = new Set(dates);
  const per = new Map<string, Record<Platform, Set<number>>>();
  let detections = 0, maskedStatic = 0, outsideAoi = 0, lowConfidence = 0;
  for (const r of rows) {
    const p = platformOf(r);
    if (!p || !inWindow.has(r.date)) continue;
    if (!containsPoint(aoi, r.lon, r.lat)) { outsideAoi++; continue; }
    if (!confident(r, p)) { lowConfidence++; continue; }
    const k = cellKey(r.lon, r.lat);
    if (staticCells.has(k)) { maskedStatic++; continue; }
    detections++;
    const day = per.get(r.date) ?? { snpp: new Set(), noaa20: new Set(), noaa21: new Set(), modis: new Set() };
    day[p].add(k); per.set(r.date, day);
  }
  const avail = availableDays(availability, dates);
  const days = dates.map(date => {
    const s = per.get(date), cal = Number(date.slice(5, 7)) - 1, fRaw = noaa20ToSnpp[cal], f = typeof fRaw === "number" && Number.isFinite(fRaw) && fRaw > 0 ? fRaw : null;
    const n20 = s?.noaa20.size ?? 0, n21 = s?.noaa21.size ?? 0;
    // No conversion factor for the month: the day cannot be put on the harmonized scale, so it is unknown (never factor 1).
    const source = f === null ? null : avail.noaa20.has(date) ? "noaa20" as const : avail.noaa21.has(date) ? "noaa21" as const : null;
    return { date, noaa20: n20, noaa21: n21, modis: s?.modis.size ?? 0, harmonized: f !== null && source === "noaa20" ? n20 * f : f !== null && source === "noaa21" ? n21 * f : null, source };
  });
  return { days, detections, maskedStatic, outsideAoi, lowConfidence, window: w, availabilityChecked: !!availability };
}

/** Usual harmonized cell-days for the given days: each day's calendar-month median divided by that month's length. */
export function expectedForDays(dates: string[], medianByCalendarMonth: (number | null)[]): number | null {
  let total = 0;
  for (const d of dates) {
    const y = Number(d.slice(0, 4)), cal = Number(d.slice(5, 7)) - 1, med = medianByCalendarMonth[cal];
    if (med === null || med === undefined) return null;
    total += med / new Date(Date.UTC(y, cal + 1, 0)).getUTCDate();
  }
  return total;
}
/** Plain-language pace descriptor for a ratio to the usual pace (descriptive only; not a percentile). */
export function paceLabel(ratio: number | null): { text: string; tone: "much-above" | "above" | "typical" | "below" | "much-below" | "unknown" } {
  if (ratio === null || !Number.isFinite(ratio)) return { text: "No usual pace to compare", tone: "unknown" };
  if (ratio >= 2) return { text: "Well above the usual pace", tone: "much-above" };
  if (ratio >= 1.25) return { text: "Above the usual pace", tone: "above" };
  if (ratio > 0.8) return { text: "Close to the usual pace", tone: "typical" };
  if (ratio > 0.5) return { text: "Below the usual pace", tone: "below" };
  return { text: "Well below the usual pace", tone: "much-below" };
}

// ---- Same-days-of-year comparison (scripts/global/build_daily_climatology.py) ----
/** Per-place climatology: quantiles (q, e.g. 10/25/50/75/90) over the baseline years of the mean daily harmonized value
 *  over the 7 days ending on each day of the year (365 slots; 29 Feb has none), and month-to-date (mtd[month][day-1]). */
export interface DailyClim { id?: string; baseline: [number, number]; q: number[]; window: number; week: (number | null)[][]; n: number[]; mtd: (number | null)[][][] }
const NONLEAP = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** Day-of-year slot 0..364 in a non-leap calendar; null for 29 February. */
export function daySlot(date: string): number | null {
  const mo = Number(date.slice(5, 7)) - 1, d = Number(date.slice(8, 10)) - 1;
  if (!(mo >= 0 && mo < 12) || !(d >= 0 && d < 31) || (mo === 1 && d === 28)) return null;
  let s = 0; for (let i = 0; i < mo; i++) s += NONLEAP[i];
  return s + d;
}
export type Tone = "much-above" | "above" | "typical" | "below" | "much-below";
/** Where a value falls among the baseline quantiles [p10, p25, p50, p75, p90]; null when any is missing. */
export function classifyAgainst(qs: (number | null)[] | undefined, v: number): Tone | null {
  if (!qs || qs.length !== 5 || qs.some(x => x === null || !Number.isFinite(x))) return null;
  const [p10, p25, , p75, p90] = qs as number[];
  if (v > p90) return "much-above";
  if (v > p75) return "above";
  if (v < p10) return "much-below";
  if (v < p25) return "below";
  return "typical";
}
/**
 * Compare the counted recent days with the same dates in the baseline years. Month-to-date when the counted days run
 * from the 1st of one month (keyed exports); otherwise the 7-day window ending on the last counted day. The observed
 * value is the mean daily harmonized activity over the counted days. Null when the place has no climatology.
 */
export function sameDaysComparison(res: RecentResult, clim: DailyClim | null): { mode: "week" | "mtd"; mean: number; quantiles: number[]; tone: Tone; ratio: number | null; years: number; days: number } | null {
  if (!clim) return null;
  const counted = res.days.filter(d => d.harmonized !== null);
  if (!counted.length) return null;
  const mean = counted.reduce((s, d) => s + (d.harmonized ?? 0), 0) / counted.length, last = counted.at(-1)!.date, first = counted[0].date;
  const sameMonth = counted.every(d => d.date.slice(0, 7) === last.slice(0, 7));
  const mtd = sameMonth && first.endsWith("-01") && counted.length === Number(last.slice(8, 10));
  const qs = mtd ? clim.mtd[Number(last.slice(5, 7)) - 1]?.[Number(last.slice(8, 10)) - 1] : (() => { const s = daySlot(last); return s === null ? undefined : clim.week[s]; })();
  const tone = classifyAgainst(qs, mean);
  if (!tone || !qs) return null;
  const s = daySlot(last), years = mtd ? clim.baseline[1] - clim.baseline[0] + 1 : s === null ? 0 : clim.n[s] ?? 0;
  if (years < 5) return null;
  const med = qs[2] as number;
  return { mode: mtd ? "mtd" : "week", mean, quantiles: qs as number[], tone, ratio: med > 0 ? mean / med : null, years, days: counted.length };
}
