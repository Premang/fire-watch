// Export and share helpers for the harmonized calendar (pure where possible; DOM helpers are isolated).
import { activityTicks, anomalyColor, anomalyMap, MONTH_NAMES, sequentialColor, type MonthPoint, type RampName, type SeriesKey } from "./analytics";
import type { Aoi } from "./data";

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
export function toCsv(rows: unknown[][]): string { return rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n"; }

/** Monthly calendar for [from, to]. Anomalies follow the shared policy (analytics.monthAnomaly): same calendar month in the
 *  other complete baseline years; partial months are not compared. Units: harmonized = Suomi NPP VIIRS-equivalent 5 km cell-days. */
export function calendarCsv(points: MonthPoint[], aoiLabel: string, from: string, to: string, baseline: [number, number], provenance = "NASA FIRMS MODIS C6.1 + VIIRS 375 m active fire archives; harmonized by Fire Watch"): string {
  const an = anomalyMap(points, "h", baseline);
  const header = ["month", "area", "harmonized_snpp_equivalent_cell_days", "bridge_error_envelope_low", "bridge_error_envelope_high", "ratio_to_median_same_month_other_years",
    "ratio_to_mean_same_month_other_years", "percentile_vs_same_month_other_years", "anomaly_class", "baseline_years", "source_platform", "raw_modis_terra_aqua_cell_days", "raw_modis_terra_cell_days", "raw_modis_aqua_cell_days",
    "raw_viirs_snpp_cell_days", "raw_viirs_noaa20_cell_days", "hotspot_detections_all_platforms", "covered_days", "days_in_month", "partial_month", "provisional", "provenance"];
  const rows = points.filter(p => p.month >= from && p.month <= to).map(p => {
    const a = an.get(p.month) ?? null;
    return [p.month, aoiLabel, p.h?.toFixed(1), p.lo?.toFixed(1), p.hi?.toFixed(1), a?.ratioToMedian?.toFixed(2), a?.ratioToMean?.toFixed(2), a && a.category !== "unknown" ? a.percentileRank?.toFixed(0) : null,
      a ? (a.partial ? "not compared (partial month)" : a.category) : null, `${baseline[0]}-${baseline[1]}`, p.source,
      p.modis, p.terra, p.aqua, p.snpp, p.noaa20, p.detections, p.coveredDays, p.days, p.partial ? "yes" : "no", p.provisional ? "yes" : "no", provenance];
  });
  return toCsv([header, ...rows]);
}

// ---- share links ----
export interface ViewState { aoi: Aoi | null; presetId?: string; from: string; to: string; key: SeriesKey; mode: "activity" | "anomaly"; ramp: RampName; month?: string | null; lang?: "en" | "es" }
const r3 = (n: number) => Math.round(n * 1000) / 1000;
export function encodeView(v: ViewState): string {
  const q = new URLSearchParams();
  if (v.presetId) q.set("place", v.presetId);
  else if (v.aoi?.kind === "circle") q.set("circle", [r3(v.aoi.lon), r3(v.aoi.lat), Math.round(v.aoi.radiusKm)].join(","));
  else if (v.aoi?.kind === "polygon" && v.aoi.rings.length === 1) q.set("poly", v.aoi.rings[0][0].map(([x, y]) => `${r3(x)},${r3(y)}`).join(";"));
  q.set("from", v.from); q.set("to", v.to);
  if (v.key !== "h") q.set("series", v.key);
  if (v.mode !== "activity") q.set("color", v.mode);
  if (v.ramp !== "inferno") q.set("ramp", v.ramp);
  if (v.month) q.set("month", v.month);
  if (v.lang === "es") q.set("lang", "es");
  return q.toString();
}
export function decodeView(search: string): Partial<ViewState> {
  const q = new URLSearchParams(search), out: Partial<ViewState> = {};
  const month = /^\d{4}-(0[1-9]|1[0-2])$/;
  const place = q.get("place"); if (place && /^(country|admin1):[A-Za-z0-9_.\- ]{1,60}$/.test(place)) out.presetId = place;
  const circle = q.get("circle")?.split(",").map(Number);
  if (circle && circle.length === 3 && circle.every(Number.isFinite) && Math.abs(circle[1]) <= 90 && Math.abs(circle[0]) <= 180 && circle[2] > 0 && circle[2] <= 2000)
    out.aoi = { kind: "circle", lon: circle[0], lat: circle[1], radiusKm: circle[2], label: `Circle ${circle[2]} km around ${circle[1]}, ${circle[0]}` };
  const poly = q.get("poly")?.split(";").map(s => s.split(",").map(Number) as [number, number]);
  if (poly && poly.length >= 4 && poly.length <= 200 && poly.every(p => p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90))
    out.aoi = { kind: "polygon", rings: [[poly]], label: "Shared area" };
  for (const k of ["from", "to"] as const) { const v = q.get(k); if (v && month.test(v)) out[k] = v; }
  const s = q.get("series"); if (s && ["h", "modis", "snpp", "noaa20"].includes(s)) out.key = s as SeriesKey;
  const c = q.get("color"); if (c === "anomaly" || c === "activity") out.mode = c;
  const r = q.get("ramp"); if (r === "cividis" || r === "viridis" || r === "inferno") out.ramp = r;
  const m = q.get("month"); if (m && month.test(m)) out.month = m;
  const l = q.get("lang"); if (l === "es" || l === "en") out.lang = l;
  return out;
}

// ---- browser-only helpers ----
export function download(name: string, content: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** Draw the calendar for the selected period to a PNG (independent of CSS) with a quantitative legend, for reports and slides. */
export async function calendarPng(o: { points: MonthPoint[]; key: SeriesKey; mode: "activity" | "anomaly"; ramp: RampName; title: string; subtitle: string; baseline: [number, number]; from: string; to: string; max: number }): Promise<Blob> {
  const { points, key, mode, ramp, baseline, from, to, max } = o;
  const an = anomalyMap(points, key, baseline);
  const y0 = Number(from.slice(0, 4)), y1 = Number(to.slice(0, 4));
  const years = [...new Set(points.map(p => Number(p.month.slice(0, 4))))].filter(y => y >= y0 && y <= y1).sort((a, b) => b - a);
  const cw = 50, ch = 24, gap = 3, left = 64, top = 104, right = 24, bottom = 128;
  const W = Math.max(left + 12 * (cw + gap) + right, 720), H = top + years.length * (ch + gap) + bottom;
  const canvas = document.createElement("canvas"); canvas.width = W * 2; canvas.height = H * 2;
  const g = canvas.getContext("2d")!; g.scale(2, 2);
  const solid = (c: string) => c.startsWith("var(") ? (c.includes("zero") ? "#1d2a22" : "#2a332c") : c;
  g.fillStyle = "#0d1310"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#eef2e6"; g.font = "24px Georgia, serif"; g.fillText(o.title, left, 40);
  g.fillStyle = "#a9b8a3"; g.font = "13px Arial, sans-serif"; g.fillText(o.subtitle, left, 63);
  g.fillText(`${MONTH_NAMES[Number(from.slice(5, 7)) - 1]} ${y0} – ${MONTH_NAMES[Number(to.slice(5, 7)) - 1]} ${y1}`, left, 82);
  g.font = "11px monospace"; g.fillStyle = "#b2bfa5"; MONTH_NAMES.forEach((m, i) => g.fillText(m, left + i * (cw + gap) + 13, top - 8));
  const by = new Map(points.map(p => [p.month, p]));
  years.forEach((y, r) => {
    g.fillStyle = "#c6d1ba"; g.font = "11px monospace"; g.fillText(String(y), 16, top + r * (ch + gap) + 16);
    for (let i = 0; i < 12; i++) {
      const month = `${y}-${String(i + 1).padStart(2, "0")}`, p = by.get(month), v = p ? (p[key] as number | null | undefined) : null, a = an.get(month) ?? null;
      const x = left + i * (cw + gap), yy = top + r * (ch + gap), inside = month >= from && month <= to;
      g.globalAlpha = inside ? 1 : 0.25;
      if (v === null || v === undefined) { g.fillStyle = "#29332b"; g.fillRect(x, yy, cw, ch); g.strokeStyle = "#161e18"; g.beginPath(); for (let k = -ch; k < cw; k += 6) { g.moveTo(x + k, yy + ch); g.lineTo(x + k + ch, yy); } g.save(); g.rect(x, yy, cw, ch); g.clip(); g.stroke(); g.restore(); }
      else { g.fillStyle = solid(mode === "anomaly" ? anomalyColor(a && !a.partial && a.category !== "unknown" ? a.percentileRank : null) : sequentialColor(v, max, ramp)); g.fillRect(x, yy, cw, ch); }
      if (p?.partial) { g.fillStyle = "#d8dfcc"; g.beginPath(); g.moveTo(x + cw, yy + ch); g.lineTo(x + cw - 7, yy + ch); g.lineTo(x + cw, yy + ch - 7); g.fill(); }
      if (p?.provisional) { g.fillStyle = "#f7e3c4"; g.beginPath(); g.arc(x + 4, yy + 4, 1.8, 0, 7); g.fill(); }
      g.globalAlpha = 1;
    }
  });
  // Legend with numeric ticks.
  const ly = top + years.length * (ch + gap) + 22, lw = 300;
  g.font = "11px Arial, sans-serif"; g.fillStyle = "#c6d1ba";
  if (mode === "activity") {
    g.fillText(`${key === "h" ? "Harmonized" : "Raw"} cell-days per month (log scale)`, left, ly);
    for (let k = 0; k < lw; k++) { const t = k / (lw - 1); g.fillStyle = solid(sequentialColor(Math.expm1(t * Math.log1p(Math.max(1, max))), max, ramp)); g.fillRect(left + k, ly + 8, 1, 12); }
    g.fillStyle = "#c6d1ba"; for (const tk of activityTicks(max)) { g.fillRect(left + tk.t * (lw - 1), ly + 20, 1, 4); g.fillText(tk.v >= 1000 ? `${tk.v / 1000}k` : String(tk.v), left + tk.t * (lw - 1) - 6, ly + 36); }
    g.fillStyle = "#1d2a22"; g.fillRect(left + lw + 24, ly + 8, 14, 12); g.fillStyle = "#c6d1ba"; g.fillText("0 (no detections)", left + lw + 44, ly + 18);
  } else {
    g.fillText(`Percentile vs the same month in other years, ${baseline[0]}–${baseline[1]}`, left, ly);
    for (let k = 0; k < lw; k++) { g.fillStyle = solid(anomalyColor((k / (lw - 1)) * 100)); g.fillRect(left + k, ly + 8, 1, 12); }
    g.fillStyle = "#c6d1ba"; for (const q of [0, 10, 30, 50, 70, 90, 100]) { g.fillRect(left + (q / 100) * (lw - 1), ly + 20, 1, 4); g.fillText(String(q), left + (q / 100) * (lw - 1) - 5, ly + 36); }
    g.fillStyle = "#2a332c"; g.fillRect(left + lw + 24, ly + 8, 14, 12); g.fillStyle = "#c6d1ba"; g.fillText("not compared (partial month or < 5 years)", left + lw + 44, ly + 18);
  }
  g.fillStyle = "#29332b"; g.fillRect(left, ly + 48, 14, 12); g.fillStyle = "#c6d1ba"; g.fillText("no satellite record", left + 20, ly + 58);
  g.fillStyle = "#d8dfcc"; g.beginPath(); g.moveTo(left + 160, ly + 60); g.lineTo(left + 153, ly + 60); g.lineTo(left + 160, ly + 53); g.fill(); g.fillStyle = "#c6d1ba"; g.fillText("partial month (sensor outage)", left + 166, ly + 58);
  g.fillStyle = "#f7e3c4"; g.beginPath(); g.arc(left + 360, ly + 54, 2, 0, 7); g.fill(); g.fillStyle = "#c6d1ba"; g.fillText("provisional (Terra-only bridge)", left + 368, ly + 58);
  g.fillStyle = "#93a38f"; g.font = "10px Arial, sans-serif";
  g.fillText("Cell-day = one 5 km grid cell with at least one satellite hotspot on a day; not a count of individual fires.", left, H - 34);
  g.fillText(`Source: NASA FIRMS MODIS C6.1 + VIIRS 375 m archives, harmonized to Suomi NPP VIIRS-equivalent cell-days · Fire Watch · ${new Date().toISOString().slice(0, 10)}`, left, H - 18);
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error("PNG export failed"))), "image/png"));
}
