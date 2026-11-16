// Pure analytics for the harmonized burning-activity calendar. No I/O; unit-tested in tests/harmonized-analytics.test.ts.

export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const MONTH_NAMES_ES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"] as const;

export type Platform = "terra" | "aqua" | "snpp" | "noaa20";
/** h = harmonized (Suomi NPP VIIRS-equivalent 5 km cell-days). Raw values are each platform's own cell-days. */
export type SeriesKey = "h" | "modis" | "terra" | "aqua" | "snpp" | "noaa20";

export interface MonthPoint {
  /** YYYY-MM */
  month: string;
  h: number | null;
  /** Uncertainty band for h (same units); equals h when the reference sensor observed the month. */
  lo?: number | null;
  hi?: number | null;
  /** Platform that supplied most of the harmonized month. */
  source?: Platform | null;
  modis?: number | null;
  terra?: number | null;
  aqua?: number | null;
  snpp?: number | null;
  noaa20?: number | null;
  /** Raw satellite detections (all retained platforms), for "number of hotspots detected". */
  detections?: number | null;
  /** True when sensor availability did not cover the whole month. */
  partial?: boolean;
  /** True when built from a provisional bridge (e.g. Terra-only years) or near-real-time data. */
  provisional?: boolean;
  /** Days of the month with at least one satellite delivering data globally, and the month's length. */
  coveredDays?: number;
  days?: number;
}

export interface ClimatologyMonth { calendarMonth: number; n: number; median: number | null; mean: number | null; p10: number | null; p25: number | null; p75: number | null; p90: number | null; values: number[] }
export interface Anomaly { value: number; median: number | null; ratioToMedian: number | null; percentOfMedian: number | null; mean: number | null; ratioToMean: number | null; percentileRank: number | null; logZ: number | null; category: AnomalyCategory }
export type AnomalyCategory = "much-below" | "below" | "typical" | "above" | "much-above" | "unknown";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function monthIndex(month: string): number {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new RangeError(`Invalid month ${month}`);
  return (Number(month.slice(0, 4)) - 2000) * 12 + Number(month.slice(5, 7)) - 1;
}
export function monthFromIndex(i: number): string {
  const y = 2000 + Math.floor(i / 12), m = ((i % 12) + 12) % 12;
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}
export function value(p: MonthPoint | undefined, key: SeriesKey): number | null {
  if (!p) return null;
  const v = p[key];
  return finite(v) ? v : null;
}

export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Per-calendar-month statistics over complete (non-partial) months in [startYear, endYear]. */
export function climatology(points: MonthPoint[], key: SeriesKey, startYear: number, endYear: number, exclude?: string): ClimatologyMonth[] {
  const buckets: number[][] = Array.from({ length: 12 }, () => []);
  for (const p of points) {
    const y = Number(p.month.slice(0, 4));
    if (y < startYear || y > endYear || p.partial || p.month === exclude) continue;
    const v = value(p, key);
    if (v !== null) buckets[Number(p.month.slice(5, 7)) - 1].push(v);
  }
  return buckets.map((vals, calendarMonth) => statsOf(calendarMonth, [...vals].sort((a, b) => a - b)));
}
function statsOf(calendarMonth: number, s: number[]): ClimatologyMonth {
  return { calendarMonth, n: s.length, median: quantile(s, 0.5), mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null,
    p10: quantile(s, 0.1), p25: quantile(s, 0.25), p75: quantile(s, 0.75), p90: quantile(s, 0.9), values: s };
}
/** The same calendar-month baseline with one occurrence of v removed (leave-one-out). */
export function climWithout(c: ClimatologyMonth, v: number): ClimatologyMonth {
  const i = c.values.indexOf(v);
  return i < 0 ? c : statsOf(c.calendarMonth, [...c.values.slice(0, i), ...c.values.slice(i + 1)]);
}

/** Percentile rank in [0,100] with mid-rank ties ("what share of past same-months were lower"). */
export function percentileRank(sortedValues: number[], v: number): number | null {
  if (!sortedValues.length) return null;
  let below = 0, equal = 0;
  for (const x of sortedValues) { if (x < v) below++; else if (x === v) equal++; }
  return (100 * (below + equal / 2)) / sortedValues.length;
}

export function anomaly(v: number, c: ClimatologyMonth): Anomaly {
  const median = c.median;
  const ratio = median !== null && median > 0 ? v / median : median === 0 ? (v === 0 ? 1 : null) : null;
  const logs = c.values.map(x => Math.log1p(x)), mu = logs.length ? logs.reduce((a, b) => a + b, 0) / logs.length : 0;
  const sd = logs.length > 2 ? Math.sqrt(logs.reduce((a, b) => a + (b - mu) ** 2, 0) / (logs.length - 1)) : 0;
  const logZ = logs.length > 2 && sd > 0 ? (Math.log1p(v) - mu) / sd : null;
  const pr = percentileRank(c.values, v);
  const category: AnomalyCategory = pr === null || c.n < 5 ? "unknown" : pr >= 90 ? "much-above" : pr >= 70 ? "above" : pr <= 10 ? "much-below" : pr <= 30 ? "below" : "typical";
  const ratioToMean = c.mean !== null && c.mean > 0 ? v / c.mean : null;
  return { value: v, median, ratioToMedian: ratio, percentOfMedian: ratio === null ? null : ratio * 100, mean: c.mean, ratioToMean, percentileRank: pr, logZ, category };
}

export type MonthAnomaly = Anomaly & { partial: boolean };
/**
 * THE baseline policy, shared by the KPIs, calendar, month detail, CSV, PNG and near-real-time panel:
 *  - baseline = the same calendar month, complete (non-partial) months only, within the baseline years;
 *  - a month inside the baseline is left out of its own baseline (leave-one-out), so it is compared with the other years;
 *  - partial months (a sensor outage) are not compared at all, and fewer than 5 baseline years gives "unknown".
 * `clim` must be climatology(points, key, baseline[0], baseline[1]).
 */
export function monthAnomaly(p: MonthPoint, key: SeriesKey, clim: ClimatologyMonth[], baseline: [number, number]): MonthAnomaly | null {
  const v = value(p, key);
  if (v === null) return null;
  const cal = Number(p.month.slice(5, 7)) - 1, y = Number(p.month.slice(0, 4));
  if (p.partial) return { value: v, median: clim[cal]?.median ?? null, ratioToMedian: null, percentOfMedian: null, mean: clim[cal]?.mean ?? null, ratioToMean: null, percentileRank: null, logZ: null, category: "unknown", partial: true };
  const c = y >= baseline[0] && y <= baseline[1] ? climWithout(clim[cal], v) : clim[cal];
  return { ...anomaly(v, c), partial: false };
}
export function anomalyMap(points: MonthPoint[], key: SeriesKey, baseline: [number, number], clim = climatology(points, key, baseline[0], baseline[1])): Map<string, MonthAnomaly | null> {
  return new Map(points.map(p => [p.month, monthAnomaly(p, key, clim, baseline)]));
}

/** Years x 12 matrix for the calendar; null = no data (sensor not operating / outside record). */
export function calendarGrid(points: MonthPoint[], key: SeriesKey, startYear: number, endYear: number): { year: number; cells: (MonthPoint & { v: number | null })[] }[] {
  const by = new Map(points.map(p => [p.month, p]));
  const rows = [];
  for (let y = endYear; y >= startYear; y--) {
    rows.push({ year: y, cells: Array.from({ length: 12 }, (_, i) => {
      const month = `${y}-${String(i + 1).padStart(2, "0")}`, p = by.get(month);
      return { ...(p ?? { month, h: null }), month, v: value(p, key) };
    }) });
  }
  return rows;
}

export interface AnnualTotal { year: number; total: number | null; months: number; complete: boolean; provisional: boolean }
export function annualTotals(points: MonthPoint[], key: SeriesKey): AnnualTotal[] {
  const by = new Map<number, { total: number; months: number; partial: boolean; provisional: boolean }>();
  for (const p of points) {
    const y = Number(p.month.slice(0, 4)), v = value(p, key);
    const r = by.get(y) ?? { total: 0, months: 0, partial: false, provisional: false };
    if (v !== null) { r.total += v; r.months++; }
    r.partial ||= !!p.partial; r.provisional ||= !!p.provisional; by.set(y, r);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([year, r]) => ({ year, total: r.months ? r.total : null, months: r.months, complete: r.months === 12 && !r.partial, provisional: r.provisional }));
}

export function rangeSummary(points: MonthPoint[], key: SeriesKey, start: string, end: string) {
  const a = monthIndex(start), b = monthIndex(end);
  const sel = points.filter(p => { const i = monthIndex(p.month); return i >= a && i <= b; });
  const vals = sel.map(p => ({ p, v: value(p, key) })).filter((x): x is { p: MonthPoint; v: number } => x.v !== null);
  const total = vals.reduce((s, x) => s + x.v, 0);
  const peak = vals.reduce<{ p: MonthPoint; v: number } | null>((best, x) => (!best || x.v > best.v ? x : best), null);
  const detections = sel.reduce((s, p) => s + (finite(p.detections) ? p.detections : 0), 0);
  return { months: sel.length, monthsWithData: vals.length, total, mean: vals.length ? total / vals.length : null, peakMonth: peak?.p.month ?? null, peakValue: peak?.v ?? null,
    detections, partialMonths: sel.filter(p => p.partial).length, provisionalMonths: sel.filter(p => p.provisional).length };
}

export function topMonths(points: MonthPoint[], key: SeriesKey, n = 5): { month: string; v: number }[] {
  return points.flatMap(p => { const v = value(p, key); return v === null || p.partial ? [] : [{ month: p.month, v }]; }).sort((a, b) => b.v - a.v || a.month.localeCompare(b.month)).slice(0, n);
}

/** Calendar months ranked by median activity (the "fire season" for this area). */
export function seasonRanking(clim: ClimatologyMonth[]): number[] {
  return clim.map(c => c.calendarMonth).sort((a, b) => (clim[b].median ?? -1) - (clim[a].median ?? -1));
}

/** Theil-Sen slope (units per year) and Mann-Kendall test on annual totals. */
export function trend(series: { x: number; y: number }[]): { slopePerYear: number | null; tau: number | null; p: number | null; n: number } {
  const s = series.filter(d => finite(d.x) && finite(d.y)), n = s.length;
  if (n < 5) return { slopePerYear: null, tau: null, p: null, n };
  const slopes: number[] = []; let S = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (s[j].x !== s[i].x) slopes.push((s[j].y - s[i].y) / (s[j].x - s[i].x));
    S += Math.sign(s[j].y - s[i].y);
  }
  slopes.sort((a, b) => a - b);
  const varS = (n * (n - 1) * (2 * n + 5)) / 18;
  const z = S > 0 ? (S - 1) / Math.sqrt(varS) : S < 0 ? (S + 1) / Math.sqrt(varS) : 0;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  return { slopePerYear: quantile(slopes, 0.5), tau: S / ((n * (n - 1)) / 2), p, n };
}
function normalCdf(x: number): number {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * x / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return 0.5 * (1 + y);
}

/** Latest complete month and how it compares with the same calendar month in the other baseline years (monthAnomaly policy). */
export function latestVsMedian(points: MonthPoint[], key: SeriesKey, baseline: [number, number], clim = climatology(points, key, baseline[0], baseline[1])) {
  const latest = points.filter(p => !p.partial && value(p, key) !== null).at(-1);
  if (!latest) return null;
  const a = monthAnomaly(latest, key, clim, baseline)!;
  return { month: latest.month, ...a };
}

/**
 * Fire-season timing per "fire year". The fire year starts the month after the quietest calendar month (by median), so a
 * season that spans December-January (southern summers) is not cut in two. For each complete fire year (12 months with
 * data, none partial) the cumulative activity is interpolated within months to find when 10%, 50% and 90% of the year's
 * activity had occurred: onset, midpoint and end, in months since the fire-year start (0-12).
 */
export interface SeasonWindow { year: number; onset: number; mid: number; end: number; total: number }
export function seasonWindows(points: MonthPoint[], key: SeriesKey, clim: ClimatologyMonth[]): { startMonth: number; years: SeasonWindow[] } {
  const med = clim.map(c => c.median ?? Infinity), quiet = med.indexOf(Math.min(...med)), startMonth = (quiet + 1) % 12;
  const by = new Map(points.map(p => [p.month, p])), years: SeasonWindow[] = [];
  const ys = [...new Set(points.map(p => Number(p.month.slice(0, 4))))].sort((a, b) => a - b);
  for (const y of ys) {
    const vals: number[] = [];
    for (let k = 0; k < 12; k++) {
      const m = startMonth + k, p = by.get(`${y + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`), v = value(p, key);
      if (!p || p.partial || v === null) break;
      vals.push(v);
    }
    const total = vals.reduce((a, b) => a + b, 0);
    if (vals.length < 12 || total <= 0) continue;
    const at = (q: number) => { let cum = 0; for (let k = 0; k < 12; k++) { const next = cum + vals[k] / total; if (next >= q) return k + (vals[k] > 0 ? (q - cum) / (vals[k] / total) : 0); cum = next; } return 12; };
    years.push({ year: y, onset: at(0.1), mid: at(0.5), end: at(0.9), total });
  }
  return { startMonth, years };
}

/** Share of the typical year's activity that falls in the given calendar months (by median). */
export function seasonShare(clim: ClimatologyMonth[], months: number[]): number | null {
  const total = clim.reduce((s, c) => s + (c.median ?? 0), 0);
  return total > 0 ? months.reduce((s, m) => s + (clim[m]?.median ?? 0), 0) / total : null;
}

// ---- Accessible color ramps (perceptually uniform, colour-vision-deficiency friendly) ----
const CIVIDIS = ["#00224e", "#123570", "#3b496c", "#575d6d", "#707173", "#8a8678", "#a59c74", "#c3b369", "#e1cc55", "#fee838"];
const VIRIDIS = ["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"];
const INFERNO = ["#000004", "#1b0c41", "#4a0c6b", "#781c6d", "#a52c60", "#cf4446", "#ed6925", "#fb9b06", "#f7d13d", "#fcffa4"];
/** Blue-white-orange diverging (anomalies); distinguishable for common colour-vision deficiencies. */
const BUOR = ["#2166ac", "#4393c3", "#92c5de", "#d1e5f0", "#f7f7f7", "#fee0b6", "#fdb863", "#e08214", "#b35806"];
export const RAMPS = { cividis: CIVIDIS, viridis: VIRIDIS, inferno: INFERNO } as const;
export type RampName = keyof typeof RAMPS;

function hexToRgb(h: string): [number, number, number] { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function interp(stops: readonly string[], t: number): string {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const a = hexToRgb(stops[i]), b = hexToRgb(stops[i + 1]);
  return `rgb(${a.map((c, k) => Math.round(c + (b[k] - c) * f)).join(",")})`;
}
/** Sequential colour on a log scale; t in [0,1] maps from the ramp's 15% stop so low values stay visible on dark backgrounds. */
export function sequentialColor(v: number, max: number, ramp: RampName = "cividis"): string {
  if (v <= 0) return "var(--atlas-zero)";
  const t = Math.log1p(v) / Math.log1p(Math.max(1, max));
  return interp(RAMPS[ramp], 0.15 + 0.85 * t);
}
/** Legend ticks for the log-scaled activity ramp: up to 5 round values in (0, max], with their position t in [0, 1]. */
export function activityTicks(max: number): { v: number; t: number }[] {
  const m = Math.max(1, max), nice: number[] = [];
  for (let p = 1; p <= m * 1.0001; p *= 10) for (const f of [1, 2, 5]) if (f * p <= m) nice.push(f * p);
  const pick = nice.length <= 5 ? nice : [0, 0.25, 0.5, 0.75, 1].map(q => nice[Math.round(q * (nice.length - 1))]);
  return [...new Set(pick)].map(v => ({ v, t: Math.log1p(v) / Math.log1p(m) }));
}
/** Diverging colour from a percentile rank (50 = typical). */
export function anomalyColor(percentile: number | null): string {
  if (percentile === null) return "var(--atlas-missing)";
  return interp(BUOR, percentile / 100);
}
export function textColorFor(bg: string): string {
  const m = bg.match(/rgb\((\d+),(\d+),(\d+)\)/);
  if (!m) return "#e8ece1";
  const [r, g, b] = m.slice(1).map(Number), lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 140 ? "#121a14" : "#eef2e8";
}
