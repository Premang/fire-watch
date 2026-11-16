"use client";

import { MONTH_NAMES, type AnnualTotal, type ClimatologyMonth, type MonthPoint, type Platform } from "@/lib/harmonized/analytics";
import { MONTHS, type Lang } from "@/lib/harmonized/i18n";

const fmt = (n: number) => n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n >= 10 ? Math.round(n).toString() : n.toFixed(1);
export const SOURCE_COLORS: Record<Platform, string> = { terra: "#b9a3e3", aqua: "#7fb3d5", snpp: "#f4a46e", noaa20: "#e6d47a" };
export const SOURCE_LABELS: Record<Platform, string> = { terra: "MODIS Terra (bridged)", aqua: "MODIS Aqua (bridged)", snpp: "VIIRS Suomi NPP (reference)", noaa20: "VIIRS NOAA-20 (bridged)" };
export const SOURCE_LABELS_ES: Record<Platform, string> = { terra: "MODIS Terra (convertido)", aqua: "MODIS Aqua (convertido)", snpp: "VIIRS Suomi NPP (referencia)", noaa20: "VIIRS NOAA-20 (convertido)" };
export const sourceLabels = (lang: Lang = "en") => (lang === "es" ? SOURCE_LABELS_ES : SOURCE_LABELS);

/** SVG path through the points, broken wherever a value is missing (never bridges a gap in the record). */
export function gapPath(pts: ([number, number] | null)[]): string {
  let d = "", pen = false;
  for (const p of pts) { if (!p) { pen = false; continue; } d += `${pen ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`; pen = true; }
  return d;
}

function niceMax(v: number) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }

/** Seasonal profile: median and p10-p90 band per calendar month, with one highlighted year. */
export function SeasonalChart({ clim, highlight, highlightYear, title, lang = "en" }: { clim: ClimatologyMonth[]; highlight: (number | null)[]; highlightYear: number | null; title: string; lang?: Lang }) {
  const W = 560, H = 220, L = 42, Rr = 12, T = 14, B = 26, iw = W - L - Rr, ih = H - T - B;
  const max = niceMax(Math.max(1, ...clim.map(c => c.p90 ?? 0), ...highlight.map(v => v ?? 0)));
  const x = (i: number) => L + (iw * (i + 0.5)) / 12, y = (v: number) => T + ih - (ih * v) / max;
  const band = clim.every(c => c.p10 !== null) ? [...clim.map((c, i) => `${x(i)},${y(c.p90!)}`), ...[...clim].reverse().map((c, k) => `${x(11 - k)},${y(c.p10!)}`)].join(" ") : "";
  const med = gapPath(clim.map((c, i) => c.median === null ? null : [x(i), y(c.median)]));
  const hl = gapPath(highlight.map((v, i) => v === null ? null : [x(i), y(v)]));
  return <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
    <title>{title}</title>
    {[0, 0.25, 0.5, 0.75, 1].map(t => <g key={t}><line className="grid" x1={L} x2={W - Rr} y1={y(max * t)} y2={y(max * t)} /><text className="axis" x={L - 6} y={y(max * t) + 3} textAnchor="end">{fmt(max * t)}</text></g>)}
    {MONTHS[lang].map((m, i) => <text key={m} className="axis" x={x(i)} y={H - 8} textAnchor="middle">{m}</text>)}
    {band && <polygon points={band} fill="#787c85" opacity={0.28}><title>10th to 90th percentile across baseline years</title></polygon>}
    {med && <path d={med} fill="none" stroke="#c4c6ca" strokeWidth={2} />}
    {hl && <path d={hl} fill="none" stroke="#f4a46e" strokeWidth={2.4} />}
    {highlight.map((v, i) => v === null ? null : <circle key={i} cx={x(i)} cy={y(v)} r={3} fill="#f4a46e"><title>{`${MONTH_NAMES[i]} ${highlightYear}: ${fmt(v)}`}</title></circle>)}
    <g transform={`translate(${L + 6},${T + 4})`} className="axis"><rect width={10} height={3} y={-2} fill="#c4c6ca" /><text x={14} y={2}>{lang === "es" ? "mediana" : "median"}</text><rect x={70} width={10} height={8} y={-5} fill="#787c85" opacity={0.5} /><text x={84} y={2}>p10–p90</text>{highlightYear !== null && <><rect x={138} width={10} height={3} y={-2} fill="#f4a46e" /><text x={152} y={2}>{highlightYear}</text></>}</g>
  </svg>;
}

/** Annual totals coloured by the dominant data source, with uncertainty whiskers and the Theil-Sen trend. */
export function AnnualChart({ totals, sources, bands, trendLine, title, onSelectYear, selectedYear }: {
  totals: AnnualTotal[]; sources: Map<number, Platform | null>; bands: Map<number, [number, number]>; trendLine: { slope: number; intercept: number } | null; title: string; onSelectYear?: (y: number) => void; selectedYear?: number | null;
}) {
  const W = 560, H = 220, L = 42, Rr = 10, T = 14, B = 26, iw = W - L - Rr, ih = H - T - B;
  const data = totals.filter(t => t.total !== null);
  if (!data.length) return <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}><text className="axis" x={W / 2} y={H / 2} textAnchor="middle">No data</text></svg>;
  const max = niceMax(Math.max(...data.map(t => Math.max(t.total!, bands.get(t.year)?.[1] ?? 0))));
  const n = data.length, bw = iw / n, y = (v: number) => T + ih - (ih * v) / max, x0 = (i: number) => L + i * bw;
  return <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
    <title>{title}</title>
    {[0, 0.5, 1].map(t => <g key={t}><line className="grid" x1={L} x2={W - Rr} y1={y(max * t)} y2={y(max * t)} /><text className="axis" x={L - 6} y={y(max * t) + 3} textAnchor="end">{fmt(max * t)}</text></g>)}
    {data.map((t, i) => {
      const src = sources.get(t.year) ?? "snpp", b = bands.get(t.year), sel = selectedYear === t.year;
      const desc = `${t.year}: ${fmt(t.total!)}${b ? ` (range ${fmt(b[0])}–${fmt(b[1])})` : ""}${t.complete ? "" : ", incomplete year"}${t.provisional ? ", provisional" : ""}`;
      return <g key={t.year} onClick={() => onSelectYear?.(t.year)} style={{ cursor: onSelectYear ? "pointer" : "default" }} className="bar"
        {...(onSelectYear ? { role: "button", tabIndex: 0, "aria-label": `${desc}. Show this year`, "aria-pressed": sel, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectYear(t.year); } } } : {})}>
        <rect x={x0(i) + bw * 0.12} width={bw * 0.76} y={y(t.total!)} height={Math.max(0, y(0) - y(t.total!))} fill={src ? SOURCE_COLORS[src] : "#888"} opacity={t.complete ? (sel ? 1 : 0.85) : 0.45} stroke={sel ? "#fff0c8" : "none"} strokeWidth={1.5}>
          <title>{desc}</title>
        </rect>
        {b && b[1] > b[0] && <line x1={x0(i) + bw / 2} x2={x0(i) + bw / 2} y1={y(b[0])} y2={y(b[1])} stroke="#ebeced" strokeWidth={1} opacity={0.7} />}
        {(i % Math.ceil(n / 12) === 0 || i === n - 1) && <text className="axis" x={x0(i) + bw / 2} y={H - 8} textAnchor="middle">{String(t.year).slice(2)}</text>}
      </g>;
    })}
    {trendLine && <line x1={x0(0) + bw / 2} x2={x0(n - 1) + bw / 2} y1={y(Math.max(0, trendLine.intercept + trendLine.slope * data[0].year))} y2={y(Math.max(0, trendLine.intercept + trendLine.slope * data[n - 1].year))} stroke="#ebeced" strokeDasharray="4 4" strokeWidth={1.3}><title>Theil–Sen trend</title></line>}
  </svg>;
}

/** Raw MODIS vs raw VIIRS vs harmonized, monthly — shows the discontinuity the harmonization removes. */
export function SensorChart({ points, title, start = "2008-01", lang = "en" }: { points: MonthPoint[]; title: string; start?: string; lang?: Lang }) {
  const W = 1120, H = 250, L = 46, Rr = 14, T = 26, B = 26, iw = W - L - Rr, ih = H - T - B;
  const pts = points.filter(p => p.month >= start);
  if (pts.length < 2) return null;
  const vals = pts.flatMap(p => [p.h ?? 0, p.modis ?? 0, p.snpp ?? 0]);
  const max = niceMax(Math.max(1, ...vals)), n = pts.length;
  const x = (i: number) => L + (iw * i) / (n - 1), y = (v: number) => T + ih - (ih * v) / max;
  const line = (k: "h" | "modis" | "snpp") => gapPath(pts.map((p, i) => (p[k] === null || p[k] === undefined) ? null : [x(i), y(p[k] as number)]));
  const i2012 = pts.findIndex(p => p.month === "2012-01");
  return <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
    <title>{title}</title>
    {[0, 0.5, 1].map(t => <g key={t}><line className="grid" x1={L} x2={W - Rr} y1={y(max * t)} y2={y(max * t)} /><text className="axis" x={L - 6} y={y(max * t) + 3} textAnchor="end">{fmt(max * t)}</text></g>)}
    {pts.map((p, i) => p.month.endsWith("-01") && Number(p.month.slice(0, 4)) % 2 === 0 ? <text key={p.month} className="axis" x={x(i)} y={H - 8} textAnchor="middle">{p.month.slice(0, 4)}</text> : null)}
    {i2012 >= 0 && <g><line x1={x(i2012)} x2={x(i2012)} y1={T + 18} y2={T + ih} stroke="#f4a46e" strokeDasharray="3 4" opacity={0.6} /><text className="axis" x={x(i2012) + 5} y={T + ih - 6}>{lang === "es" ? "comienza VIIRS S-NPP (ene 2012)" : "VIIRS S-NPP begins (Jan 2012)"}</text></g>}
    <path d={line("modis")} fill="none" stroke="#7fb3d5" strokeWidth={1.4} opacity={0.85} />
    <path d={line("snpp")} fill="none" stroke="#e08214" strokeWidth={1.4} opacity={0.85} />
    <path d={line("h")} fill="none" stroke="#efeff0" strokeWidth={2} />
    <g transform={`translate(${L + 8},${T + 4})`} className="axis">
      <rect width={12} height={3} y={-2} fill="#7fb3d5" /><text x={16} y={2}>{lang === "es" ? "MODIS crudo (Terra+Aqua), celdas-día" : "raw MODIS (Terra+Aqua) cell-days"}</text>
      <rect x={270} width={12} height={3} y={-2} fill="#e08214" /><text x={286} y={2}>{lang === "es" ? "VIIRS S-NPP crudo, celdas-día" : "raw VIIRS S-NPP cell-days"}</text>
      <rect x={490} width={12} height={3} y={-2} fill="#efeff0" /><text x={506} y={2}>{lang === "es" ? "armonizado (equivalente S-NPP)" : "harmonized (S-NPP-equivalent)"}</text>
    </g>
  </svg>;
}

/** Fire-season window per fire year: bar from onset (10% of the year's activity) to end (90%), dot at the midpoint (50%). */
export function SeasonTimingChart({ windows, startMonth, title, selectedYear, onSelectYear, lang = "en" }: {
  windows: { year: number; onset: number; mid: number; end: number }[]; startMonth: number; title: string; selectedYear?: number | null; onSelectYear?: (y: number) => void; lang?: Lang;
}) {
  const MN = MONTHS[lang];
  if (windows.length < 2) return <p className="atlas-note">{lang === "es" ? "No hay suficientes años de fuego completos para mostrar el calendario de la temporada." : "Not enough complete fire years to show season timing."}</p>;
  const rowH = 10, W = 560, L = 44, Rr = 10, T = 22, B = 24, n = windows.length, H = T + n * rowH + B, iw = W - L - Rr;
  const x = (t: number) => L + (iw * t) / 12, y = (i: number) => T + i * rowH + rowH / 2;
  const rows = [...windows].sort((a, b) => b.year - a.year);
  return <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
    <title>{title}</title>
    {Array.from({ length: 13 }, (_, k) => <line key={k} className="grid" x1={x(k)} x2={x(k)} y1={T - 4} y2={T + n * rowH} />)}
    {Array.from({ length: 12 }, (_, k) => <text key={k} className="axis" x={x(k + 0.5)} y={H - 8} textAnchor="middle">{MN[(startMonth + k) % 12]}</text>)}
    {rows.map((w, i) => { const sel = selectedYear === w.year, mm = (t: number) => MN[(startMonth + Math.min(11, Math.floor(t))) % 12], label = lang === "es" ? `Año de fuego desde ${MN[startMonth]} ${w.year}: inicio ${mm(w.onset)}, punto medio ${mm(w.mid)}, fin ${mm(w.end)}` : `Fire year starting ${MN[startMonth]} ${w.year}: onset ${mm(w.onset)}, midpoint ${mm(w.mid)}, end ${mm(w.end)}`;
      return <g key={w.year} onClick={() => onSelectYear?.(w.year)} style={{ cursor: onSelectYear ? "pointer" : "default" }} className="bar"
        {...(onSelectYear ? { role: "button", tabIndex: 0, "aria-label": label, "aria-pressed": sel, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectYear(w.year); } } } : {})}>
        <title>{label}</title>
        {(i % 5 === 0 || sel) && <text className="axis" x={L - 6} y={y(i) + 3.5} textAnchor="end" style={sel ? { fill: "#fff0c8" } : undefined}>{w.year}</text>}
        <line x1={x(w.onset)} x2={x(w.end)} y1={y(i)} y2={y(i)} stroke={sel ? "#ffd3a6" : "#f4a46e"} strokeWidth={sel ? 6 : 4.5} strokeLinecap="round" opacity={sel ? 1 : 0.75} />
        <circle cx={x(w.mid)} cy={y(i)} r={2.6} fill="#f3f4f5" />
      </g>; })}
    <g transform={`translate(${L + 4},${T - 8})`} className="axis"><rect width={14} height={4} y={-2} fill="#f4a46e" /><text x={18} y={2}>{lang === "es" ? "10%–90% de la actividad del año" : "10%–90% of the year’s activity"}</text><circle cx={244} cy={0} r={2.6} fill="#f3f4f5" /><text x={250} y={2}>{lang === "es" ? "punto medio (50%)" : "midpoint (50%)"}</text></g>
  </svg>;
}
