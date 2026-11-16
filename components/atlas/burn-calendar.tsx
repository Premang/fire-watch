"use client";

import { useRef } from "react";
import { anomalyColor, calendarGrid, monthFromIndex, monthIndex, sequentialColor, textColorFor, type MonthAnomaly, type MonthPoint, type RampName, type SeriesKey } from "@/lib/harmonized/analytics";
import { sourceLabels } from "./charts";
import { MONTHS, num, type Lang, ordinal } from "@/lib/harmonized/i18n";

export type ColorMode = "activity" | "anomaly";

/**
 * Year x month grid of buttons (one tab stop; arrow keys move between months that have data, skipping gaps).
 * Colour: log-scaled activity, or the shared anomaly policy (monthAnomaly) — partial months and short histories stay neutral.
 */
export default function BurnCalendar({ points, seriesKey, mode, ramp, anomalies, max, from, to, selected, onSelect, showValues, caption, lang = "en" }: {
  points: MonthPoint[]; seriesKey: SeriesKey; mode: ColorMode; ramp: RampName; anomalies: Map<string, MonthAnomaly | null>; max: number; from: string; to: string;
  selected: string | null; onSelect: (month: string) => void; showValues: boolean; caption: string; lang?: Lang;
}) {
  const es = lang === "es", MN = MONTHS[lang], SL = sourceLabels(lang);
  const fmt = (v: number) => num(lang, v, v >= 10 ? 0 : 1);
  const ref = useRef<HTMLTableElement>(null);
  if (!points.length) return null;
  const firstYear = Number(points[0].month.slice(0, 4)), lastYear = Number(points.at(-1)!.month.slice(0, 4));
  const rows = calendarGrid(points, seriesKey, firstYear, lastYear);
  const has = new Set(points.filter(p => typeof p[seriesKey] === "number").map(p => p.month));
  const latest = [...has].sort().at(-1) ?? null;
  const focusMonth = selected && has.has(selected) ? selected : latest;
  const lo = monthIndex(points[0].month), hi = monthIndex(points.at(-1)!.month);

  function move(e: React.KeyboardEvent<HTMLButtonElement>, month: string) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: 12, ArrowDown: -12, Home: -1, End: 1 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    let i = monthIndex(month), target: string | null = null;
    if (e.key === "Home" || e.key === "End") { // first / last month with data in this row (year)
      const y = Number(month.slice(0, 4)), months = Array.from({ length: 12 }, (_, k) => `${y}-${String(k + 1).padStart(2, "0")}`).filter(m => has.has(m));
      target = (e.key === "Home" ? months[0] : months.at(-1)) ?? null;
    } else {
      // Rows run newest-first, so Up goes to the next (later) year and Down to the previous one. Skip months without data.
      for (i += step; i >= lo && i <= hi; i += step) { const m = monthFromIndex(i); if (has.has(m)) { target = m; break; } }
    }
    if (!target) return;
    // Every month with data is always rendered as a button, so focus can move now (no frame wait); the roving tabIndex follows on re-render.
    ref.current?.querySelector<HTMLButtonElement>(`button[data-month="${target}"]`)?.focus();
    onSelect(target);
  }

  return <div className={`atlas-cal ${showValues ? "show-values" : ""}`}>
    <table ref={ref} aria-label={caption}>
      <caption className="sr-only">{caption}. {es ? "Las filas son años, del más reciente al más antiguo; las columnas son meses. Use las flechas para moverse entre meses con datos; cada celda anuncia su valor, la comparación con el mismo mes de otros años y la fuente." : "Rows are years, newest first; columns are months. Use the arrow keys to move between months with data; each cell announces its value, how it compares with the same month in other years, and its data source."}</caption>
      <thead><tr><th className="year" scope="col">{es ? "Año" : "Year"}</th>{MN.map(m => <th key={m} scope="col">{m}</th>)}<th scope="col" className="era">{es ? "Fuente" : "Source"}</th></tr></thead>
      <tbody>{rows.map((r, ri) => {
        const srcs = r.cells.map(c => c.source).filter(Boolean) as string[];
        const dominant = srcs.sort((a, b) => srcs.filter(s => s === b).length - srcs.filter(s => s === a).length)[0];
        return <tr key={r.year} style={{ "--i": ri } as React.CSSProperties}>
          <th scope="row" className="year">{r.year}</th>
          {r.cells.map((c, i) => {
            if (c.v === null || !has.has(c.month)) return <td key={i}><span className="missing" title={`${MN[i]} ${r.year}: ${es ? "sin registro satelital" : "no satellite record"}`}><span className="sr-only">{MN[i]} {r.year}: {es ? "sin registro satelital" : "no satellite record"}</span></span></td>;
            const an = anomalies.get(c.month) ?? null;
            const bg = mode === "anomaly" ? anomalyColor(an && !an.partial && an.category !== "unknown" ? an.percentileRank : null) : sequentialColor(c.v, max, ramp);
            const out = c.month < from || c.month > to;
            const cmp = an?.partial ? (es ? ", mes parcial (faltan días o falla de un sensor), sin comparar" : ", partial month (days missing or a sensor outage), not compared") : an && an.ratioToMedian !== null ? (es ? `, ${num(lang, an.ratioToMedian, 1)} veces el nivel habitual${an.percentileRank !== null && an.category !== "unknown" ? ` (percentil ${Math.round(an.percentileRank)} de otros años)` : ", poca historia para clasificar"}` : `, ${an.ratioToMedian.toFixed(1)} times the usual level${an.percentileRank !== null && an.category !== "unknown" ? ` (${ordinal(Math.round(an.percentileRank))} percentile of other years)` : ", too little history to rank"}`) : "";
            const label = `${MN[i]} ${r.year}: ${fmt(c.v)} ${seriesKey === "h" ? (es ? "celdas-día armonizadas" : "harmonized cell-days") : (es ? "celdas-día sin armonizar" : "raw cell-days")}${cmp}${c.source ? `${es ? ", fuente " : ", source "}${SL[c.source]}` : ""}${c.provisional ? (es ? ", provisorio" : ", provisional") : ""}${out ? (es ? ", fuera del período elegido" : ", outside the selected period") : ""}`;
            return <td key={i}><button data-month={c.month} className={`${c.partial ? "partial" : ""} ${c.provisional ? "provisional" : ""} ${out ? "out" : ""}`}
              style={{ background: bg, color: showValues ? textColorFor(bg) : "transparent" }} aria-pressed={selected === c.month} aria-label={label} title={label}
              tabIndex={c.month === focusMonth ? 0 : -1} onClick={() => onSelect(c.month)} onKeyDown={e => move(e, c.month)}>{fmt(c.v)}</button></td>;
          })}
          <td className="era">{dominant ? dominant.toUpperCase().replace("SNPP", "S-NPP").replace("NOAA20", "NOAA-20") : ""}</td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}
