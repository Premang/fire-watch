"use client";

import More from "./more";
import { useState } from "react";
import { Radio, Loader2, TriangleAlert } from "lucide-react";
import { type ClimatologyMonth } from "@/lib/harmonized/analytics";
import { maybeGunzip, type Aoi, type HarmonizedMeta } from "@/lib/harmonized/data";
import { fetchHotspots } from "@/lib/harmonized/hotspots-client";
import { daySlot, expectedForDays, paceLabel, parseHotspotCsv, recentDaily, sameDaysComparison, staticSetFromBin, type DailyClim, type RecentResult } from "@/lib/harmonized/recent";
import { locale, num, type Lang } from "@/lib/harmonized/i18n";

let staticPromise: Promise<Set<number>> | null = null;

type Done = { status: "done"; res: RecentResult; range: string; source: string; notes: string[]; aoi: Aoi; daily: DailyClim | null };
const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");
type State = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | Done;

const T = {
  en: { intro: (l: string) => `See whether the last few days over ${l} are burning more or less than usual for this time of year. The first check can take a minute.`, how: "How this works", howText: "Uses NASA FIRMS near-real-time VIIRS (NOAA-20, NOAA-21) on the same harmonized scale. The first check downloads NASA's global 7-day files (about 60 MB); later checks reuse them for 10 minutes.", details: "Details and caveats",
    reading: "Reading the latest NASA FIRMS passes…", unavailable: "Near-real-time data unavailable.", noMask: "The mask of known industrial heat sources could not load, so the comparison would not be vegetation fires only. Please try again.", noFactors: "The NOAA-20 → S-NPP conversion factors are missing from this archive build, so recent days cannot be put on the harmonized scale.",
    keyedRule: "; with the FIRMS key, a platform counts on days NASA lists its data as available and the request succeeded (NASA's table gives date ranges, not proof of every overpass)", feedsWarn: "Some NASA feeds did not answer, so these counts may be low:",
    noDay: (w: string) => `No complete day with VIIRS coverage in the window yet${w}.`, over: (t: string, n: number, a: string, b: string) => `${t} harmonized cell-days over the last ${n} complete day${n === 1 ? "" : "s"} (${a}–${b})`,
    against: (e: string, b0: number, b1: number) => `, against ${e} at the usual pace (the ${b0}–${b1} median for each day's month ÷ its days).`,
    noData: (d: string) => `${d}: no VIIRS platform delivered data; left out`, dayTip: (d: string, v: string, p: string, c: number) => `${d}: ${v} harmonized cell-days (${p}: ${c} cells)`, paceTip: (d: string, v: string) => `Usual pace for ${d}: ${v}`,
    observed: "observed (harmonized)", usual: "usual pace for the day", noViirs: (n: number) => `no VIIRS data that day (${n})`,
    foot: (det: string, st: string, lo: string, checked: boolean, src: string) => `${det} confident detections in the area · ${st} at known industrial heat sources removed · ${lo} low-confidence skipped. Partial first and last UTC days are excluded; days with coverage but no fire count as zero${checked ? "; a platform counts on days it delivered at least half its usual global detections" : ""}. A few days vary far more than a whole month, so treat the pace as an early signal; the calendar above holds the official month-by-month comparison. Source: ${src}.`,
    kicker: "RIGHT NOW · NEAR-REAL-TIME", title: (l: string) => `Is burning in ${l} running above its usual pace?`, refresh: "Refresh", check: "Check the latest passes",
    aria: (l: string, n: number) => `Daily harmonized activity for ${l}, last ${n} complete days, with the usual daily pace`,
    pace: { "much-above": "Well above the usual pace", above: "Above the usual pace", typical: "Close to the usual pace", below: "Below the usual pace", "much-below": "Well below the usual pace", unknown: "No usual pace to compare" } as Record<string, string>,
    same: { "much-above": "Higher than in 90% of past years for these dates", above: "Higher than in 75% of past years for these dates", typical: "Within the usual range for these dates", below: "Lower than in 75% of past years for these dates", "much-below": "Lower than in 90% of past years for these dates" } as Record<string, string>,
    sameDetail: (mean: string, n: number, a: string, b: string, mode: string, b0: number, b1: number, med: string, lo: string, hi: string, years: number) => `${mean} harmonized cell-days per day over the last ${n} complete day${n === 1 ? "" : "s"} (${a}–${b}). ${mode === "mtd" ? "The same days of the month" : "The 7 days ending on the same date"} in ${b0}–${b1} (${years} years) had a median of ${med} per day; the middle half of years ran ${lo}–${hi}.`,
    vsMedian: "× the median for these dates", typicalDay: "median for the same date, past years", sameBasis: (b0: number, b1: number) => ` Compared with the same dates in ${b0}–${b1}, from this place's own harmonized daily record.` },
  es: { intro: (l: string) => `Vea si los últimos días sobre ${l} tienen más o menos quema que lo habitual para esta época del año. La primera consulta puede tardar un minuto.`, how: "Cómo funciona", howText: "Usa VIIRS en tiempo casi real de NASA FIRMS (NOAA-20, NOAA-21) en la misma escala armonizada. La primera consulta descarga los archivos globales de 7 días de la NASA (unos 60 MB); las siguientes los reutilizan durante 10 minutos.", details: "Detalles y advertencias",
    reading: "Leyendo los últimos pasos de NASA FIRMS…", unavailable: "Datos en tiempo casi real no disponibles.", noMask: "No se pudo cargar la máscara de fuentes de calor industriales conocidas, así que la comparación no sería solo de fuegos de vegetación. Intente de nuevo.", noFactors: "Faltan los factores de conversión NOAA-20 → S-NPP en esta versión del archivo, así que los últimos días no pueden llevarse a la escala armonizada.",
    keyedRule: "; con la clave FIRMS, una plataforma cuenta los días en que la NASA declara sus datos disponibles y la consulta respondió (la tabla de la NASA da rangos de fechas, no prueba cada pasada)", feedsWarn: "Algunas fuentes de la NASA no respondieron, así que estos conteos pueden ser bajos:",
    noDay: (w: string) => `Todavía no hay un día completo con cobertura VIIRS en la ventana${w}.`, over: (t: string, n: number, a: string, b: string) => `${t} celdas-día armonizadas en ${n === 1 ? "el último día completo" : `los últimos ${n} días completos`} (${a}–${b})`,
    against: (e: string, b0: number, b1: number) => `, frente a ${e} al ritmo habitual (la mediana ${b0}–${b1} del mes de cada día ÷ sus días).`,
    noData: (d: string) => `${d}: ninguna plataforma VIIRS entregó datos; se excluye`, dayTip: (d: string, v: string, p: string, c: number) => `${d}: ${v} celdas-día armonizadas (${p}: ${c} celdas)`, paceTip: (d: string, v: string) => `Ritmo habitual para ${d}: ${v}`,
    observed: "observado (armonizado)", usual: "ritmo habitual del día", noViirs: (n: number) => `sin datos VIIRS ese día (${n})`,
    foot: (det: string, st: string, lo: string, checked: boolean, src: string) => `${det} detecciones confiables en el área · ${st} en fuentes de calor industriales conocidas eliminadas · ${lo} de baja confianza omitidas. Se excluyen el primer y el último día UTC (parciales); los días con cobertura y sin fuego cuentan como cero${checked ? "; una plataforma cuenta los días en que entregó al menos la mitad de sus detecciones globales habituales" : ""}. Unos pocos días varían mucho más que un mes entero: tome el ritmo como una señal temprana; el calendario de arriba es la comparación oficial mes a mes. Fuente: ${src}.`,
    kicker: "AHORA · TIEMPO CASI REAL", title: (l: string) => `¿Las quemas en ${l} superan su ritmo habitual?`, refresh: "Actualizar", check: "Consultar los últimos pasos",
    aria: (l: string, n: number) => `Actividad diaria armonizada para ${l}, últimos ${n} días completos, con el ritmo diario habitual`,
    pace: { "much-above": "Muy por encima del ritmo habitual", above: "Por encima del ritmo habitual", typical: "Cerca del ritmo habitual", below: "Por debajo del ritmo habitual", "much-below": "Muy por debajo del ritmo habitual", unknown: "Sin ritmo habitual para comparar" } as Record<string, string>,
    same: { "much-above": "Más alto que en el 90% de los años pasados para estas fechas", above: "Más alto que en el 75% de los años pasados para estas fechas", typical: "Dentro del rango habitual para estas fechas", below: "Más bajo que en el 75% de los años pasados para estas fechas", "much-below": "Más bajo que en el 90% de los años pasados para estas fechas" } as Record<string, string>,
    sameDetail: (mean: string, n: number, a: string, b: string, mode: string, b0: number, b1: number, med: string, lo: string, hi: string, years: number) => `${mean} celdas-día armonizadas por día en ${n === 1 ? "el último día completo" : `los últimos ${n} días completos`} (${a}–${b}). ${mode === "mtd" ? "Los mismos días del mes" : "Los 7 días que terminan en la misma fecha"} en ${b0}–${b1} (${years} años) tuvieron una mediana de ${med} por día; la mitad central de los años fue ${lo}–${hi}.`,
    vsMedian: "× la mediana para estas fechas", typicalDay: "mediana para la misma fecha, años pasados", sameBasis: (b0: number, b1: number) => ` Comparado con las mismas fechas en ${b0}–${b1}, a partir del registro diario armonizado de este lugar.` },
};

export default function RecentPanel({ aoi, meta, clim, label, baseline, lang = "en" }: { aoi: Aoi; meta: HarmonizedMeta & { nrt?: { noaa20ToSnppByCalendarMonth: number[]; staticCellsPath: string }; dailyClimatology?: { path: string } }; clim: ClimatologyMonth[]; label: string; baseline: [number, number]; lang?: Lang }) {
  const t = T[lang], fmt = (n: number | null | undefined, d = 0) => num(lang, n, d);
  const short = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(locale(lang), { month: "short", day: "numeric", timeZone: "UTC" });
  const [state, setState] = useState<State>({ status: "idle" });
  const shown = state.status === "done" && state.aoi !== aoi ? { status: "idle" as const } : state;

  async function run() {
    setState({ status: "loading" });
    try {
      const now = new Date(), month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      // The static heat-source mask is required: without it industrial detections would enter the comparison (Astra 15a).
      if (!meta.nrt) throw new Error(t.noMask);
      staticPromise ??= fetch(meta.nrt.staticCellsPath).then(async r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return staticSetFromBin((await maybeGunzip(await r.arrayBuffer())).buffer as ArrayBuffer); });
      staticPromise.catch(() => { staticPromise = null; });
      // Countries and provinces carry a same-dates climatology; drawn areas fall back to the monthly pace.
      const dailyPath = aoi.presetId && meta.dailyClimatology ? `${meta.dailyClimatology.path}${safeId(aoi.presetId)}.json.gz` : null;
      const dailyP = dailyPath ? fetch(dailyPath).then(async r => (r.ok ? JSON.parse(new TextDecoder().decode(await maybeGunzip(await r.arrayBuffer()))) as DailyClim : null)).catch(() => null) : Promise.resolve(null);
      const [hs, staticSet, daily] = await Promise.all([fetchHotspots(aoi, month, month), staticPromise.catch(() => { throw new Error(t.noMask); }), dailyP]);
      const rows = parseHotspotCsv([hs.header, ...hs.lines].join("\n"));
      const factors = meta.nrt.noaa20ToSnppByCalendarMonth;
      if (!Array.isArray(factors) || factors.length !== 12) throw new Error(t.noFactors);
      const res = recentDaily(rows, aoi, staticSet, factors, hs.window, hs.availability);
      setState({ status: "done", res, range: hs.range, source: hs.source, notes: hs.notes, aoi, daily });
    } catch (e) { setState({ status: "error", message: e instanceof Error ? e.message : t.unavailable }); }
  }

  let body: React.ReactNode = null;
  if (shown.status === "idle") body = <><p className="atlas-note">{t.intro(label)}</p><More label={t.how}><p className="atlas-note">{t.howText}</p></More></>;
  if (shown.status === "loading") body = <p className="atlas-note" role="status"><Loader2 size={13} className="spin" /> {t.reading}</p>;
  if (shown.status === "error") body = <p className="atlas-note" role="alert">{shown.message}</p>;
  if (shown.status === "done") {
    const { res } = shown, counted = res.days.filter(d => d.harmonized !== null), skipped = res.days.length - counted.length;
    const total = counted.reduce((s, d) => s + (d.harmonized ?? 0), 0);
    const exp = expectedForDays(counted.map(d => d.date), clim.map(c => c.median));
    const ratio = exp !== null && exp > 0 ? total / exp : null, pace = paceLabel(ratio);
    const sd = sameDaysComparison(res, shown.daily);
    // Reference line per day: the same-date median when the place has a daily climatology, else the monthly pace.
    const perDay = new Map(counted.map(d => { const sl = daySlot(d.date), wq = sl === null ? null : shown.daily?.week[sl]?.[2] ?? null;
      return [d.date, sd && wq !== null ? wq : exp !== null ? (clim[Number(d.date.slice(5, 7)) - 1]?.median ?? 0) / new Date(Date.UTC(Number(d.date.slice(0, 4)), Number(d.date.slice(5, 7)), 0)).getUTCDate() : null]; }));
    const maxV = Math.max(1, ...counted.map(d => Math.max(d.harmonized ?? 0, perDay.get(d.date) ?? 0)));
    const n = res.days.length, bw = 56;
    body = <>
      {shown.notes.length > 0 && <p className="atlas-warn" role="alert"><TriangleAlert size={14} /> {t.feedsWarn} {shown.notes.join("; ")}</p>}
      {counted.length === 0 ? <p className="atlas-note">{t.noDay(res.window ? ` (${res.window.first} → ${res.window.last})` : "")}</p> : <>
        {sd ? <div className="atlas-pace">
          <div className="value">{sd.ratio !== null ? `${fmt(sd.ratio, 1)}×` : fmt(sd.mean, 1)}</div>
          <div><span className={`badge ${sd.tone}`}>{t.same[sd.tone]}</span>
            <p className="atlas-note">{t.sameDetail(fmt(sd.mean, 1), sd.days, short(counted[0].date), short(counted.at(-1)!.date), sd.mode, shown.daily!.baseline[0], shown.daily!.baseline[1], fmt(sd.quantiles[2], 1), fmt(sd.quantiles[1], 1), fmt(sd.quantiles[3], 1), sd.years)}</p></div>
        </div> : <div className="atlas-pace">
          <div className="value">{ratio !== null ? `${fmt(ratio, 1)}×` : fmt(total, 1)}</div>
          <div><span className={`badge ${pace.tone}`}>{t.pace[pace.tone]}</span>
            <p className="atlas-note">{t.over(fmt(total, 1), counted.length, short(counted[0].date), short(counted.at(-1)!.date))}{exp !== null ? t.against(fmt(exp, 1), baseline[0], baseline[1]) : "."}</p></div>
        </div>}
        <svg viewBox={`0 0 ${n * bw + 30} 132`} role="img" aria-label={t.aria(label, n)} style={{ marginTop: 10, maxWidth: n * 90 }}>
          {res.days.map((d, i) => { const x = 24 + i * bw, v = d.harmonized, h = v === null ? 0 : (v / maxV) * 92, e = perDay.get(d.date);
            return <g key={d.date}>
              {v === null ? <rect x={x} y={14} width={40} height={92} fill="url(#nodata)" opacity={0.6}><title>{t.noData(d.date)}</title></rect>
                : <rect x={x} y={106 - h} width={40} height={Math.max(h, v === 0 ? 1.5 : 0)} fill="#f4a46e"><title>{t.dayTip(d.date, fmt(v, 1), d.source === "noaa21" ? "NOAA-21" : "NOAA-20", d.source === "noaa21" ? d.noaa21 : d.noaa20)}</title></rect>}
              {e !== null && e !== undefined && <line x1={x - 4} x2={x + 44} y1={106 - (e / maxV) * 92} y2={106 - (e / maxV) * 92} stroke="#e5e6e8" strokeWidth={1.6} strokeDasharray="4 3"><title>{t.paceTip(d.date, fmt(e, 1))}</title></line>}
              <text className="axis" x={x + 20} y={124} textAnchor="middle">{short(d.date)}</text></g>; })}
          <defs><pattern id="nodata" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="#3c3f44" /></pattern></defs>
        </svg>
        <div className="atlas-cal-foot"><span><span className="sw" style={{ background: "#f4a46e" }} />{t.observed}</span><span><span className="sw dash" />{sd ? t.typicalDay : t.usual}</span>{skipped > 0 && <span><span className="sw" style={{ background: "repeating-linear-gradient(45deg,#3c3f44,#3c3f44 3px,transparent 3px,transparent 6px)" }} />{t.noViirs(skipped)}</span>}</div>
      </>}
      <More label={t.details}><p className="atlas-note">{t.foot(fmt(res.detections), fmt(res.maskedStatic), fmt(res.lowConfidence), res.availabilityChecked && !shown.source.includes("Area API"), shown.source)}{shown.source.includes("Area API") ? t.keyedRule : ""}{sd ? t.sameBasis(shown.daily!.baseline[0], shown.daily!.baseline[1]) : ""}</p></More>
    </>;
  }
  return <section className="panel atlas-chart" id="atlas-now" aria-live="polite">
    <div className="atlas-panel-head"><div><span className="section-kicker"><Radio size={10} /> {t.kicker}</span><h2>{t.title(label)}</h2></div>
      <button className="atlas-button" onClick={() => void run()} disabled={shown.status === "loading"}>{shown.status === "done" ? t.refresh : t.check}</button></div>
    {body}
  </section>;
}
