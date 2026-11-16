"use client";

import More from "./more";
import { Fragment, useEffect, useState } from "react";
import { ArrowRight, Database, Filter, Grid3x3, Layers, Scale, ShieldCheck, Sigma, Split } from "lucide-react";

type Err = { bias: number; nae: number; mae: number };
type ScaleRow = { label: string; units: number; refCellDays: number; raw: Err; pred: Err; pred_global: Err };
type PR = { precision: number; recall: number };
type Trio = { harmonized: number; naiveSplice: number; raw: number };
type SplitRes = { anomalyClassChance320km?: Trio; label: string; design?: string; scales: Record<string, ScaleRow>; anomalySpearman320km?: { harmonized: number; naiveSplice?: number; raw: number }; anomalyClassAgreement320km?: Trio; aboveNormalRecall320km?: Trio; anomalyClassTest?: { units: number; trainingYears: number }; topDecileAnomaly320km_pred?: PR; topDecileAnomaly320km_naive?: PR; topDecileAnomaly320km_raw?: PR; globalMonthly?: { month: string; reference: number; harmonized: number; raw: number }[] };
type Pair = { status?: string; lambda?: number; matchedDays?: number; years?: Record<string, [number, number] | null>; test?: SplitRes; stress?: SplitRes; testSpatialCV?: SplitRes; testFallbackFactors?: SplitRes; backcast?: SplitRes & { years?: [number, number] }; switchTest?: { switchMonth: string; logStepHarmonized: number; logStepRaw: number; blocks: number } | null };
type Report = { reference: string; filter: string; availabilityRule: string; pairs: Record<string, Pair> };

const PAIRS: { id: string; title: string; role: string }[] = [
  { id: "aqua_to_snpp", title: "MODIS Aqua → VIIRS Suomi NPP", role: "Carries 2002–2011 onto the VIIRS scale; same afternoon overpass family." },
  { id: "noaa20_to_snpp", title: "VIIRS NOAA-20 → VIIRS Suomi NPP", role: "Carries the record past Suomi NPP's end of mission (2 Nov 2026) and fills S-NPP outages." },
  { id: "terra_to_aqua", title: "MODIS Terra → MODIS Aqua", role: "Bridges Nov 2000 – Jun 2002, before Aqua (provisional)." },
];
const pct = (v: number | undefined, d = 0) => v === undefined || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(d)}%`;
const step = (log: number | undefined) => log === undefined ? "—" : `${((Math.exp(log) - 1) * 100).toFixed(0)}%`;

const ES = {
  kicker: "CÓMO FUNCIONA LA ARMONIZACIÓN", h2: "Satélites distintos, un mismo conteo.",
  intro: <>MODIS (Terra 2000–, Aqua 2002–) ve píxeles de 1 km; VIIRS (Suomi NPP 2012–2026, NOAA-20 2018–) ve píxeles de 375 m en otros horarios. Por eso los conteos crudos de focos saltan cuando cambia el sensor. Fire Watch lleva todos los sensores a una misma escala — <strong>celdas-día de 5 km equivalentes a VIIRS Suomi NPP</strong> — y evalúa el resultado en años y regiones que el método nunca vio.</>,
  flow: [["Archivos de NASA FIRMS", "MODIS C6.1 + VIIRS 375 m, todos los países"], ["Fuegos de vegetación, filtrados por calidad", "tipo 0 · confianza MODIS ≥ 30 · VIIRS nominal/alta"], ["Celdas-día de 5 km de igual área", "un conteo por celda por día, por satélite"], ["Factores puente", "por región de 320 km × mes calendario, con contracción hacia regiones más amplias"], ["Empalme día a día", "S-NPP › NOAA-20 › Aqua › Terra"], ["Incertidumbre", "a partir de errores en años de prueba, por escala"]],
  limitsKicker: "QUÉ SIGNIFICAN LOS NÚMEROS — Y QUÉ NO", measured: "Medido, no supuesto",
  measuredP: "Los factores se ajustan solo en días en que ambos satélites entregaban datos, con años de entrenamiento; un año de ajuste define cuánto se apoyan las regiones con pocos datos en regiones más amplias. Todos los números de esta página vienen de años de prueba que el ajuste nunca vio; la prueba dejando regiones afuera además quita los datos propios de cada región de todos los niveles del ajuste.",
  limits: "Límites honestos", limitsP: "La coincidencia entre satélites no es verdad de campo: nubes, humo y horario de paso ocultan fuegos a todos los sensores. Las celdas-día cuentan celdas de 5 km ocupadas, no área quemada ni incendios individuales. Las detecciones incluyen quemas agrícolas y prescritas. Las órbitas de Terra y Aqua derivan después de ~2020–2022, por eso los años recientes usan VIIRS. Los datos en tiempo casi real no traen la marca de vegetación, así que se enmascaran las fuentes de calor industriales conocidas con el archivo.",
};

export default function EvidencePage({ lang = "en" }: { lang?: "en" | "es" }) {
  const es = lang === "es";
  const [report, setReport] = useState<Report | null>(null), [err, setErr] = useState("");
  useEffect(() => {
    fetch("/data/harmonized/meta.json").then(r => r.json() as Promise<{ validation?: Report }>).then(m => (m.validation ? setReport(m.validation) : setErr("Validation report not available yet.")))
      .catch(() => setErr("Validation report not available."));
  }, []);
  return <div className="atlas">
    <section className="panel method-intro">
      <span className="section-kicker">{es ? ES.kicker : "HOW THE HARMONIZATION WORKS"}</span>
      <h2>{es ? ES.h2 : "Different satellites, one consistent count."}</h2>
      <p>{es ? ES.intro : <>MODIS (Terra 2000–, Aqua 2002–) sees 1 km pixels; VIIRS (Suomi NPP 2012–2026, NOAA-20 2018–) sees 375 m pixels at different times. Raw hotspot counts therefore jump when a sensor changes. Fire Watch puts every sensor on one scale — <strong>Suomi NPP VIIRS-equivalent 5 km cell-days</strong> — and tests the result on years and regions the method never saw.</>}</p>
      <div className="method-flow">
        {([[Database, "NASA FIRMS archives", "MODIS C6.1 + VIIRS 375 m, all countries"], [Filter, "Vegetation fires, quality-filtered", "type 0 · MODIS conf ≥ 30 · VIIRS nominal/high"], [Grid3x3, "5 km equal-area cell-days", "one count per cell per day, per satellite"], [Scale, "Bridging factors", "per 320 km region × calendar month, shrunk to broader regions"], [Layers, "Day-by-day splice", "S-NPP › NOAA-20 › Aqua › Terra"], [Sigma, "Uncertainty", "from held-out-year errors at each scale"]] as const).map(([Icon, t, d], i) =>
          <Fragment key={t}>{i > 0 && <ArrowRight />}<span><Icon />{es ? ES.flow[i][0] : t}<small>{es ? ES.flow[i][1] : d}</small></span></Fragment>)}
      </div>
    </section>
    {err && <div className="notice" role="status">{err}</div>}
    {report && <Headline report={report} es={es} />}
    {report && <Summary report={report} />}
    {report && PAIRS.map(p => <PairCard key={p.id} title={p.title} role={p.role} pair={report.pairs[p.id]} />)}
    <section className="panel method-intro">
      <span className="section-kicker">{es ? ES.limitsKicker : "WHAT THE NUMBERS MEAN — AND DON’T"}</span>
      <div className="method-columns" style={{ marginTop: 10 }}>
        {es ? <><div className="prose-card" style={{ padding: 0 }}><h3>{ES.measured}</h3><p>{ES.measuredP}</p></div><div className="prose-card" style={{ padding: 0 }}><h3>{ES.limits}</h3><p>{ES.limitsP}</p></div></> : <>
        <div className="prose-card" style={{ padding: 0 }}><h3>Measured, not assumed</h3>
          <p>Factors are fitted only on <em>matched days</em> when both satellites were delivering data, using training years. A tuning year picks how strongly sparse regions borrow from broader ones. All numbers on this page come from later <em>test</em> years the fit never saw; the leave-region-out test also removes each region&apos;s own data from every level of the fit before scoring it.</p>
          <p>“Error” is the normalized absolute difference between the bridged series and what the reference satellite actually recorded. It shrinks with area: small areas are noisy, countries are stable.</p></div>
        <div className="prose-card" style={{ padding: 0 }}><h3>Honest limits</h3>
          <p>Agreement between satellites is not ground truth: clouds, smoke and overpass timing hide fires from every sensor. Cell-days count occupied 5 km cells, not burned area or individual fires. Detections include agricultural and prescribed burning. Terra and Aqua orbits drift after ~2020–2022, which is why recent years use VIIRS. Near-real-time data lack the vegetation flag, so known industrial heat sources are masked using the archive.</p></div></>}
      </div>
      <More label="Data filters"><p className="atlas-note">Reference: {report?.reference ?? "Suomi NPP VIIRS-equivalent 5 km cell-days"} · Filter: {report?.filter ?? ""} · Availability: {report?.availabilityRule ?? ""}</p></More>
    </section>
  </div>;
}

function PairCard({ title, role, pair }: { title: string; role: string; pair?: Pair }) {
  if (!pair || pair.status) return <section className="panel atlas-chart"><span className="section-kicker">{title.toUpperCase()}</span><p className="atlas-note">Validation pending: {pair?.status ?? "no overlap data"}.</p></section>;
  const t = pair.test, s320 = t?.scales["320km"], g = t?.scales.global, cv = pair.testSpatialCV, geo = cv?.scales["320km"];
  const an = t?.anomalySpearman320km, naive = an?.naiveSplice;
  const yrs = (k: string) => pair.years?.[k] ? `${pair.years[k]![0]}–${pair.years[k]![1]}` : "—";
  return <section className="panel atlas-chart">
    <div className="atlas-panel-head"><div><span className="section-kicker">BRIDGE · {title.toUpperCase()}</span><h2>{title}</h2><p>{role} <strong>Tested on {yrs("test")}</strong>, years the method never saw.</p></div><ShieldCheck size={20} color="#a3a6ac" /></div>
    <More label="Fitting details"><p className="atlas-note">Fitted on {yrs("train")}, tuned on {yrs("tune")}, tested on {yrs("test")}{pair.years?.stress ? `, with an extra check on ${yrs("stress")} for satellite orbit drift` : ""}. Uses {pair.matchedDays?.toLocaleString("en-US")} days when both satellites delivered data. Borrowing strength from broader regions (shrinkage λ): {pair.lambda}.</p></More>
    <div className="atlas-kpis" style={{ marginBottom: 14 }}>
      <Kpi label="Monthly error · 320 km regions" value={pct(s320?.pred.nae)} detail={`raw ${pct(s320?.raw.nae)} → harmonized`} />
      <Kpi label="Monthly error · global" value={pct(g?.pred.nae, 1)} detail={`raw ${pct(g?.raw.nae)} · bias ${pct(g?.pred.bias, 1)}`} />
      <Kpi label="Regions left out of the fit" value={pct(geo?.pred.nae)} detail={`320 km error when a region's own data are removed from every factor level (raw ${pct(geo?.raw.nae)})`} />
      {t?.anomalyClassAgreement320km ? <Kpi label="Above / typical / below agree" value={pct(t.anomalyClassAgreement320km.harmonized)} detail={`months classed like the reference satellite (320 km); splicing raw counts: ${pct(t.anomalyClassAgreement320km.naiveSplice)}. Above-normal months found: ${pct(t.aboveNormalRecall320km?.harmonized)} vs ${pct(t.aboveNormalRecall320km?.naiveSplice)}`} />
        : <Kpi label="Unusual months agree" value={an ? an.harmonized.toFixed(2) : "—"} detail={an ? `rank agreement with the reference record${naive !== undefined ? `; splicing raw counts gives ${naive.toFixed(2)}` : ""}` : "Spearman, vs reference"} />}
      <Kpi label="Staged sensor switch" value={step(pair.switchTest?.logStepHarmonized)} detail={`level before vs after a staged switch at ${pair.switchTest?.switchMonth ?? "—"}; with raw counts the earlier satellite sits ${step(pair.switchTest?.logStepRaw)} relative to the reference`} />
    </div>
    {t?.globalMonthly && t.globalMonthly.length > 2 && <ValidationChart rows={t.globalMonthly} title={`${title}: global monthly cell-days in held-out test years`} />}
    <table className="atlas-table" style={{ marginTop: 12 }}><caption className="sr-only">Errors by aggregation scale</caption>
      <thead><tr><th scope="col">Aggregation scale (test years)</th><th scope="col">Raw error</th><th scope="col">One global factor</th><th scope="col">Fire Watch</th><th scope="col">Bias</th></tr></thead>
      <tbody>{["40km", "320km", "1280km", "global"].map(k => { const r = t?.scales[k]; return r ? <tr key={k}><td>{k === "global" ? "Global monthly total" : `${k.replace("km", " km")} regions`}</td><td>{pct(r.raw.nae)}</td><td>{pct(r.pred_global.nae)}</td><td><strong>{pct(r.pred.nae)}</strong></td><td>{pct(r.pred.bias, 1)}</td></tr> : null; })}</tbody></table>
    <More label="More tests for this bridge"><>{cv && <p className="atlas-note"><strong>Leave-region-out test:</strong> {cv.design ?? "held-out regions excluded from every factor level"}. Error by scale: {["40km", "320km", "1280km", "global"].map(k => cv.scales[k] ? `${k === "global" ? "global" : k.replace("km", " km")} ${pct(cv.scales[k].pred.nae)}` : null).filter(Boolean).join(" · ")}. The gap to the test-year error shows how much the local factors add where a region has its own overlap years — which every region in the product does.</p>}
    {pair.backcast && <p className="atlas-note"><strong>Backward in time:</strong> {pair.backcast.design}. Error at 320 km {pct(pair.backcast.scales["320km"]?.pred.nae)} (raw {pct(pair.backcast.scales["320km"]?.raw.nae)}), global monthly {pct(pair.backcast.scales.global?.pred.nae, 1)}. The app&apos;s uncertainty ranges use the larger of the forward and backward errors.</p>}
    {pair.stress && <p className="atlas-note">Drift stress test ({yrs("stress")}): 320 km error {pct(pair.stress.scales["320km"]?.pred.nae)}, global bias {pct(pair.stress.scales.global?.pred.bias, 1)} — MODIS orbits drift after ~2020–2022, which is why recent years use VIIRS directly.</p>}</></More>
  </section>;
}

/** Three numbers for the hardest bridge (MODIS Aqua -> VIIRS S-NPP), from held-out data; the full table follows. */
function Headline({ report, es }: { report: Report; es: boolean }) {
  const a = report.pairs.aqua_to_snpp;
  if (!a || a.status || !a.test) return null;
  const s320 = a.test.scales["320km"], cv = a.testSpatialCV?.scales["320km"], cls = a.test.anomalyClassAgreement320km, ch = a.test.anomalyClassChance320km, rec = a.test.aboveNormalRecall320km;
  const items: [string, string, string][] = [
    [`${pct(s320?.raw.nae)} → ${pct(s320?.pred.nae)}`, es ? "error mensual en regiones de 320 km" : "monthly error, 320 km regions", es ? `MODIS Aqua → VIIRS en años de prueba ${a.years?.test?.join("–")}` : `MODIS Aqua → VIIRS, held-out years ${a.years?.test?.join("–")}`],
    [pct(cv?.pred.nae), es ? "en regiones excluidas del ajuste" : "in regions left out of the fit", es ? "sus propios datos se quitaron de todos los niveles" : "their own data removed from every level of the fit"],
    [`${pct(cls?.naiveSplice)} → ${pct(cls?.harmonized)}`, es ? "meses clasificados como el satélite de referencia" : "months classed like the reference satellite", es ? `debajo / típico / encima del mismo mes; azar ${pct(ch?.harmonized)} · meses anómalos altos detectados ${pct(rec?.naiveSplice)} → ${pct(rec?.harmonized)}` : `below / typical / above the same month; chance ${pct(ch?.harmonized)} · above-normal months caught ${pct(rec?.naiveSplice)} → ${pct(rec?.harmonized)}`],
  ];
  return <section className="panel atlas-headline" aria-label={es ? "Resultados principales" : "Headline results"}>
    {items.map(([v, l, d]) => <div key={l}><div className="value">{v}</div><div className="label">{l}</div><p>{d}</p></div>)}
  </section>;
}

/** One table, every bridge: the numbers a reviewer needs first. Errors are normalized absolute errors of monthly totals. */
function Summary({ report }: { report: Report }) {
  const used: Record<string, string> = { aqua_to_snpp: "2002–2011 and S-NPP gaps", noaa20_to_snpp: "S-NPP gaps; after Nov 2026", terra_to_aqua: "Nov 2000 – Jun 2002 and Aqua gaps" };
  return <section className="panel atlas-chart">
    <span className="section-kicker">VALIDATION AT A GLANCE · HELD-OUT DATA ONLY</span>
    <div className="atlas-table-wrap" style={{ marginTop: 10, maxHeight: "none" }}><table className="atlas-table"><caption className="sr-only">Validation summary for each sensor bridge</caption>
      <thead><tr><th scope="col">Bridge</th><th scope="col">Used for</th><th scope="col">Test years</th><th scope="col">320 km error: raw → harmonized</th><th scope="col">Regions left out (320 km)</th><th scope="col">Backward in time (320 km)</th><th scope="col">Global monthly error · bias</th><th scope="col">Sensor-switch step: raw → harmonized</th><th scope="col">Above / typical / below agreement: raw splice → harmonized</th></tr></thead>
      <tbody>{PAIRS.map(({ id, title }) => { const q = report.pairs[id]; if (!q || q.status) return <tr key={id}><td>{title}</td><td colSpan={8}>{q?.status ?? "pending"}</td></tr>;
        const t = q.test?.scales; return <tr key={id}><td>{title}</td><td>{used[id]}</td><td>{q.years?.test ? `${q.years.test[0]}–${q.years.test[1]}` : "—"}</td>
          <td>{pct(t?.["320km"]?.raw.nae)} → <strong>{pct(t?.["320km"]?.pred.nae)}</strong></td><td>{pct(q.testSpatialCV?.scales["320km"]?.pred.nae)}</td><td>{pct(q.backcast?.scales["320km"]?.pred.nae)}</td>
          <td>{pct(t?.global?.pred.nae, 1)} · {pct(t?.global?.pred.bias, 1)}</td><td>{step(q.switchTest?.logStepRaw)} → <strong>{step(q.switchTest?.logStepHarmonized)}</strong></td><td>{pct(q.test?.anomalyClassAgreement320km?.naiveSplice)} → <strong>{pct(q.test?.anomalyClassAgreement320km?.harmonized)}</strong></td></tr>; })}</tbody></table></div>
    <More label="How to read this table"><p className="atlas-note">Raw = the source satellite&apos;s counts used as if they were the reference&apos;s. Harmonized = after the bridge. Every number is computed on years (or regions) excluded from fitting. The switch test splices the two satellites mid-way through the test years and compares the level before and after (−75% means the earlier satellite&apos;s raw counts sit 75% below the reference, i.e. a 4× jump at the handover); a good bridge leaves no step. The class test asks the app&apos;s own question — is this month below, near or above the same month in other years? — for every 320 km region with regular burning (at least 50 reference cell-days in the test years) and test month, and scores how often the answer matches the reference satellite; chance, from the observed class frequencies, is about a third (31–35%). The shrinkage strength λ was tuned once on all regions, so the leave-region-out and backward-in-time checks are conditional on it. Error envelopes in the app are these held-out errors at the matching scale — empirical, not confidence intervals.</p></More>
  </section>;
}

function Kpi({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="panel atlas-kpi"><div className="label">{label}<Split size={11} /></div><div className="value">{value}</div><p>{detail}</p></div>;
}

function ValidationChart({ rows, title }: { rows: { month: string; reference: number; harmonized: number; raw: number }[]; title: string }) {
  const W = 1120, H = 220, L = 54, R = 14, T = 16, B = 26, iw = W - L - R, ih = H - T - B;
  const max = Math.max(1, ...rows.flatMap(r => [r.reference, r.harmonized, r.raw])) * 1.05;
  const x = (i: number) => L + (iw * i) / Math.max(1, rows.length - 1), y = (v: number) => T + ih - (ih * v) / max;
  const line = (k: "reference" | "harmonized" | "raw") => rows.map((r, i) => `${x(i)},${y(r[k])}`).join(" ");
  const fmtK = (v: number) => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(Math.round(v));
  return <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}><title>{title}</title>
    {[0, 0.5, 1].map(t => <g key={t}><line className="grid" x1={L} x2={W - R} y1={y(max * t)} y2={y(max * t)} /><text className="axis" x={L - 6} y={y(max * t) + 3} textAnchor="end">{fmtK(max * t)}</text></g>)}
    {rows.map((r, i) => r.month.endsWith("-01") || i === 0 ? <text key={r.month} className="axis" x={x(i)} y={H - 8} textAnchor="middle">{r.month}</text> : null)}
    <polyline points={line("raw")} fill="none" stroke="#7fb3d5" strokeWidth={1.4} strokeDasharray="4 3" />
    <polyline points={line("reference")} fill="none" stroke="#e08214" strokeWidth={2.4} />
    <polyline points={line("harmonized")} fill="none" stroke="#efeff0" strokeWidth={1.6} />
    <g transform={`translate(${L + 8},${T + 6})`} className="axis"><rect width={12} height={3} y={-2} fill="#e08214" /><text x={16} y={2}>reference satellite (actual)</text><rect x={240} width={12} height={3} y={-2} fill="#efeff0" /><text x={256} y={2}>bridged from the other satellite</text><rect x={500} width={12} height={3} y={-2} fill="#7fb3d5" /><text x={516} y={2}>raw, unharmonized</text></g>
  </svg>;
}
