"use client";

import More from "@/components/atlas/more";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, BookOpen, ChevronLeft, ChevronRight, Download, FlaskConical, Layers, MapPin, PenLine, RefreshCw, ShieldCheck, X } from "lucide-react";
import { applyFireLines, type FireLine } from "@/lib/fireline-whatif";
import { FIRELINE_MODEL } from "@/lib/fireline-model";
import FireMap, { type FireBounds, type MapGeometryLayer } from "./fire-map";
import { stateForPoint, states } from "@/lib/geography";
import type { OutlookCell, OutlookReplay } from "@/lib/fire-predictor";
import type { FireOutlook } from "@/lib/fire-outlook-types";
import type { PerimeterIndex } from "@/lib/perimeters";
import type { GfsForecast } from "@/lib/prediction-inputs";
import { FIRE_PREDICTOR_CATEGORIES, FIRE_PREDICTOR_RECENT_RESEARCH, FIRE_PREDICTOR_SCOPE, FIRE_PREDICTOR_SOURCES, FIRE_PREDICTOR_VALIDATION_CHECKS } from "@/lib/fire-predictor-research";

type Mode = "test" | "current" | "research" | "validation";
type Score = { prAuc: number | null; brier: number; logLoss: number; precision: number; recall: number; positiveRate: number; predictedPositiveRate: number; threshold: number; cells: number; positives: number };
type PairedComparison = { brierDelta: number; brierDelta95: number[]; prAucDelta: number; prAucDelta95: number[] };
type Evaluation = {
  modelId: string; modelSha256: string; modelType: string; target: string; featureNames: string[];
  source: { title: string; url: string; license: string; selectedEvents: number };
  splits: Record<string, { years: number[]; events: number; cells: number; positives: number; positiveEvents?: number; ids: string[] }>;
  test: Record<string, Score>; weighting: string; limitations: string[];
  confidenceIntervals: { method: string; prAuc: number[]; brier: number[] };
  reliability: { low: number; meanPredicted: number; observedRate: number; cells: number }[];
  timing: Record<string, string>; excludedBands: Record<string, string>;
  pairedComparisons?: Record<string, PairedComparison>;
  protocol?: { chosen: { treeWeight: number; calibration: string; leaves: number; offset: number } };
  sourceAvailabilityDiagnostics?: {
    sourceUrl: string; fetchedAt: string; scope: string;
    eligibleTestInputGapEvents: string[]; eligibleTestTargetGapEvents: string[];
    knownInputGapExcluded: { events: number; cells: number; positives: number; test: Record<string, Score> };
  };
};
const MODES: { id: Mode; label: string }[] = [{ id: "test", label: "Past fires (test)" }, { id: "current", label: "Live fire" }, { id: "research", label: "What it uses" }, { id: "validation", label: "Accuracy" }];
// One heat ramp, pale to red. `o` is the fill strength; the lowest bin stays almost clear so the ground shows through.
// Ways crews hold a fire. All are treated as a barrier in the route rule; the name and colour travel with the line.
const TACTICS = [
  { id: "dozer", label: "Dozer line (cut by machine)", color: "#2f9bff", dash: undefined as string | undefined },
  { id: "hand", label: "Hand line (dug by crews)", color: "#6ee7f9", dash: undefined },
  { id: "road", label: "Road or river used as a line", color: "#e5e7eb", dash: undefined },
  { id: "burnout", label: "Burnout (burned on purpose)", color: "#a78bfa", dash: undefined },
  { id: "drop", label: "Retardant or water drop", color: "#f472b6", dash: "8 6" },
] as const;
type TacticId = typeof TACTICS[number]["id"];
type DrawnLine = { kind: TacticId; points: FireLine };
const tacticOf = (id: string) => TACTICS.find(t => t.id === id) ?? TACTICS[0];
const BINS = [{ low: 0, high: .01, color: "#9aa3ab", o: .1 }, { low: .01, high: .05, color: "#f6e7a6", o: .2 }, { low: .05, high: .15, color: "#f4c85c", o: .34 }, { low: .15, high: .3, color: "#f29a3c", o: .46 }, { low: .3, high: .6, color: "#ea642b", o: .56 }, { low: .6, high: 1.01, color: "#d92f1e", o: .66 }];
const number = (value: number | null | undefined, digits = 3) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "Not available";
const percent = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "Not available";
const count = (value: number | undefined) => typeof value === "number" ? value.toLocaleString("en-US") : "—";
// Test fires in the dataset have no names, only identifiers; describe each by place, date and size.
const fireSize = (r: OutlookReplay) => r.cells.reduce((n, c) => n + (c.previous ? 1 : 0), 0);
const fireName = (r: OutlookReplay) => { const code = stateForPoint(r.center[1], r.center[0]); const state = states.find(f => f.properties.code === code)?.properties.name ?? "U.S."; return `${state} fire · ${new Date(`${r.targetDate}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" })}`; };
// A copy of the shared lines is kept in this browser, so they can be put back if the server restarts and forgets them.
const backupKey = (key: string) => `ember-atlas:lines:${key}`;
function saveBackup(key: string, lines: { kind: string; points: [number, number][] }[]) { try { const kept = lines.filter(l => l.points.length > 1); if (kept.length) localStorage.setItem(backupKey(key), JSON.stringify(kept)); else localStorage.removeItem(backupKey(key)); } catch { /* storage unavailable: lines still work for this visit */ } }
function readBackup(key: string): { kind: string; points: [number, number][] }[] { try { const v = JSON.parse(localStorage.getItem(backupKey(key)) ?? "[]"); return Array.isArray(v) ? v.filter(l => Array.isArray(l?.points) && l.points.length > 1 && l.points.length <= 200 && l.points.every((pt: unknown) => Array.isArray(pt) && pt.length === 2 && pt.every(Number.isFinite))).slice(0, 20) : []; } catch { return []; } }
const localTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const utc = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " UTC" : "Not supplied";
async function readJson<T>(url: string, signal: AbortSignal): Promise<T> { const r = await fetch(url, { signal, cache: "no-store" }); if (!r.ok) { const body = await r.json().catch(() => null) as { error?: unknown } | null; throw new Error(typeof body?.error === "string" ? body.error : `Data unavailable (HTTP ${r.status}).`); } return r.json() as Promise<T>; }
function geometry(cells: (OutlookCell & { p0?: number })[]) { return { type: "FeatureCollection", features: cells.map(cell => ({ type: "Feature", geometry: { type: "Polygon", coordinates: [cell.polygon] }, properties: { id: cell.id, p: cell.p, p0: cell.p0, previous: cell.previous, observed: cell.observed } })) }; }
function cellLabel(p: Record<string, unknown>) { return `Cell ${p.id} · Experimental model score ${number(typeof p.p === "number" ? p.p : null)}${typeof p.p0 === "number" ? ` (was ${number(p.p0)} before the line)` : ""} · Previous detected activity: ${p.previous ? "yes" : "no"}${p.observed === undefined ? "" : ` · Target-day detected activity: ${p.observed ? "yes" : "no retained detection"}`}. Live probability calibration is not established. 1.5 km cell; not a flame perimeter.`; }
function extent(cells: OutlookCell[], lat: number, lon: number): FireBounds { if (!cells.length) return { west: lon - .2, east: lon + .2, south: lat - .15, north: lat + .15 }; const xy = cells.flatMap(cell => cell.polygon); const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]); return { west: Math.min(...xs) - .015, east: Math.max(...xs) + .015, south: Math.min(...ys) - .015, north: Math.max(...ys) + .015 }; }
function SourceLink({ id }: { id: string }) { const source = FIRE_PREDICTOR_SOURCES.find(s => s.id === id); return source ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}<ArrowUpRight size={11} /></a> : null; }

function EvaluationSummary({ report }: { report: Evaluation }) {
  const previous = report.test.previousVersion, baseline = report.test.smoothedPersistence;
  const compared = previous ?? baseline;
  const comparison = report.pairedComparisons?.previousVersion;
  const improves = !!compared && report.test.model.brier < compared.brier;
  return <div className="prediction-evidence-note"><strong>{previous ? improves ? "More accurate than the previous version on the test fires." : "The new test does not establish lower probability error." : "Research evidence, with important limits."}</strong>
    <More label="The numbers"><p>{report.splits.test?.events ?? "—"} held-out fires · {count(report.splits.test?.positives)} detected positive cells. Model Brier {number(report.test.model.brier, 5)}{compared ? ` versus ${number(compared.brier, 5)} for ${previous ? "the previous release" : "smoothed persistence"}` : ""}; lower is better. {comparison ? `The paired 95% interval for this difference is ${comparison.brierDelta95.map(v => number(v, 5)).join(" to ")}. ${comparison.brierDelta95[1] < 0 ? "This comparison favors the new model on these test fires." : comparison.brierDelta95[0] > 0 ? "This comparison favors the previous release." : "The interval does not rule out no improvement."}` : "These results do not establish operational calibration."}</p></More>
    {baseline && report.test.model.brier >= baseline.brier && <p>Smoothed persistence still has lower probability error ({number(baseline.brier, 5)}).</p>}
    <span>Research threshold {number(report.test.model.threshold, 3)}: recall {percent(report.test.model.recall)} · precision {percent(report.test.model.precision)}. This is not an official warning threshold.</span>
  </div>;
}

function ReliabilityPlot({ bins }: { bins: Evaluation["reliability"] }) {
  return <figure className="prediction-calibration-chart"><svg viewBox="0 0 360 270" role="img" aria-label="Calibration plot: mean model score on the horizontal axis and observed detection frequency on the vertical axis. The dashed diagonal shows perfect agreement.">
    <path d="M44 16V226H340" fill="none" stroke="#61646b" />
    {[0, .25, .5, .75, 1].map(value => <g key={value}><path d={`M44 ${226 - value * 210}H340`} stroke="#2f3136" /><text x="34" y={230 - value * 210} textAnchor="end">{value * 100}%</text><text x={44 + value * 296} y="244" textAnchor="middle">{value * 100}%</text></g>)}
    <path d="M44 226L340 16" stroke="#898d94" strokeDasharray="5 5" />
    {bins.map(bin => <circle key={bin.low} cx={44 + bin.meanPredicted * 296} cy={226 - bin.observedRate * 210} r="5" fill="#e6be88" stroke="#1a1b1e" strokeWidth="1.5"><title>Predicted {percent(bin.meanPredicted)}; observed {percent(bin.observedRate)}; {count(bin.cells)} cells</title></circle>)}
    <text x="192" y="265" textAnchor="middle">Mean model score</text>
    <text x="48" y="12">Observed frequency</text>
  </svg><figcaption>Dots summarize populated score bins. Above the diagonal: underprediction. Below: overprediction. Bin counts and values appear below.</figcaption></figure>;
}

function ForecastContext({ forecast, targetDate }: { forecast: GfsForecast; targetDate: string }) {
  const hours = forecast.hourly.filter(hour => hour.validAt.slice(0, 10) === targetDate);
  const daily = forecast.daily.find(day => day.date === targetDate);
  function extreme(key: "temperatureK" | "relativeHumidityPct" | "windSpeedMs" | "windGustMs", kind: "min" | "max", offset = 0) {
    const values = hours.map(hour => hour[key]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return { value: values.length === 24 ? (kind === "min" ? Math.min(...values) : Math.max(...values)) + offset : null, coverage: values.length };
  }
  const high = extreme("temperatureK", "max", -273.15), humidity = extreme("relativeHumidityPct", "min"), wind = extreme("windSpeedMs", "max"), gust = extreme("windGustMs", "max");
  const vectorCoverage = Math.min(daily?.coverageHours.uMs ?? 0, daily?.coverageHours.vMs ?? 0);
  const direction = vectorCoverage === 24 ? daily?.windDirectionDeg ?? null : null;
  // Hourly precipitation covers the preceding hour: use endpoints 01Z through
  // the following 00Z for this calendar day's 00Z–24Z accumulation.
  const targetStart = Date.parse(`${targetDate}T00:00:00Z`);
  const rainHours = forecast.hourly.filter(hour => Date.parse(hour.validAt) > targetStart && Date.parse(hour.validAt) <= targetStart + 86400000);
  const rainValues = rainHours.map(hour => hour.precipMm).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const rainCoverage = rainValues.length;
  const rain = rainCoverage === 24 ? rainValues.reduce((sum, value) => sum + value, 0) : null;
  const compass = direction === null ? "" : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(direction / 45) % 8];
  const cards = [
    { label: "Maximum temperature", value: high.value, units: "°C", coverage: high.coverage, note: "Hourly maximum" },
    { label: "Minimum humidity", value: humidity.value, units: "% RH", coverage: humidity.coverage, note: "Hourly minimum" },
    { label: "Maximum wind", value: wind.value, units: "m/s", coverage: wind.coverage, note: "10 m wind · hourly maximum" },
    { label: "Peak gust", value: gust.value, units: "m/s", coverage: gust.coverage, note: "10 m gust · hourly maximum" },
    { label: "Prevailing direction", value: direction, units: `° ${compass}`, coverage: vectorCoverage, note: "Wind from · vector mean" },
    { label: "Daily precipitation", value: rain, units: "mm", coverage: rainCoverage, note: "Complete 24-hour total" },
  ];
  return <section className="prediction-weather-context"><div className="prediction-weather-heading"><div><span className="section-kicker">FORECAST CONTEXT · EXCLUDED FROM MODEL SCORE</span><h2>{targetDate} · 00:00–24:00 UTC</h2></div><a href={forecast.sourceUrl} target="_blank" rel="noreferrer">GFS via Open-Meteo <ArrowUpRight size={12} /></a></div><p>Run initialized {utc(forecast.runInitializedAt)} · retrieved {utc(forecast.fetchedAt)}. Point forecast at {forecast.gridPoint.lat.toFixed(3)}°, {forecast.gridPoint.lon.toFixed(3)}°.</p><div className="prediction-weather-cards">{cards.map(card => <div key={card.label}><span>{card.label}</span><strong>{card.value === null || !Number.isFinite(card.value) ? "Unavailable" : <>{number(card.value, 1)} <small>{card.units}</small></>}</strong><p>{card.note}</p><small>{card.coverage}/24 hours available</small></div>)}</div><p className="prediction-small">A daily summary requires all 24 hourly values. Missing or partial precipitation is never reported as zero. Direction can be undefined for a calm vector mean. These target-day weather summaries provide context; the fitted GFS features describe the earlier issue day.</p></section>;
}

export default function PredictionPanel() {
  const [mode, setMode] = useState<Mode>("test");
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null), [replays, setReplays] = useState<OutlookReplay[]>([]), [artifactError, setArtifactError] = useState(""), [artifactLoading, setArtifactLoading] = useState(true), [retry, setRetry] = useState(0);
  const [eventId, setEventId] = useState("");
  const [showProbability, setShowProbability] = useState(true), [showObserved, setShowObserved] = useState(false), [showPrevious, setShowPrevious] = useState(true), [satellite, setSatellite] = useState(true);
  const [latText, setLatText] = useState("39.75"), [lonText, setLonText] = useState("-121.5");
  const [incidents, setIncidents] = useState<PerimeterIndex | null>(null), [incidentError, setIncidentError] = useState("");
  const [outlook, setOutlook] = useState<FireOutlook | null>(null), [liveLoading, setLiveLoading] = useState(false), [liveError, setLiveError] = useState("");
  const [request, setRequest] = useState<{ lat: number; lon: number; seq: number } | null>(null);
  const liveAbort = useRef<AbortController | null>(null), sequence = useRef(0);

  useEffect(() => {
    const abort = new AbortController(); let active = true;
    Promise.all([readJson<Evaluation>("/data/ml/evaluation.json", abort.signal), readJson<OutlookReplay[]>("/data/ml/replays.json", abort.signal)]).then(([report, cases]) => {
      if (!report.test?.model || !Array.isArray(cases) || !cases.length) throw new Error("The fitted evaluation artifact is not ready. No example scores are substituted.");
      if (active) { setEvaluation(report); setReplays([...cases].sort((a, b) => a.id.localeCompare(b.id))); }
    }).catch(e => { if (active) { setEvaluation(null); setReplays([]); setArtifactError(e instanceof Error ? e.message : "Evaluation data unavailable."); } }).finally(() => { if (active) setArtifactLoading(false); });
    return () => { active = false; abort.abort(); };
  }, [retry]);
  useEffect(() => {
    if (mode !== "current" || incidents) return;
    const abort = new AbortController(); let active = true;
    readJson<PerimeterIndex>("/api/perimeters", abort.signal).then(data => { if (active) { setIncidents(data); setIncidentError(""); } }).catch(e => { if (active) setIncidentError(e instanceof Error ? e.message : "Incident list unavailable."); });
    return () => { active = false; abort.abort(); };
  }, [mode, incidents]);
  useEffect(() => {
    if (!request) return;
    const abort = new AbortController(); liveAbort.current = abort; let active = true;
    readJson<FireOutlook>(`/api/prediction?${new URLSearchParams({ lat: String(request.lat), lon: String(request.lon) })}`, abort.signal).then(data => {
      if (!["experimental", "abstained"].includes(data.status) || !Array.isArray(data.cells)) throw new Error("The outlook response was incomplete.");
      if (active) setOutlook(data);
    }).catch(e => { if (active && !abort.signal.aborted) setLiveError(e instanceof Error ? e.message : "Outlook unavailable."); }).finally(() => { if (active) setLiveLoading(false); });
    return () => { active = false; abort.abort(); };
  }, [request]);

  // Opens on the largest fire by squares already burning (known before the forecast, so not picked for model success).
  const replay = replays.find(r => r.id === eventId) ?? replays.reduce<OutlookReplay | null>((best, r) => !best || fireSize(r) > fireSize(best) ? r : best, null);
  const replayIndex = replay ? replays.findIndex(r => r.id === replay.id) : -1;
  const liveMatches = !!outlook && outlook.point.lat === Number(latText) && outlook.point.lon === Number(lonText) && !liveLoading;
  const current = liveMatches ? outlook : null;
  const catchUp = (current as (FireOutlook & { catchUp?: { used: boolean; earliestNextUpdate: string } }) | null)?.catchUp;
  const baseCells = useMemo(() => mode === "test" ? replay?.cells ?? [] : mode === "current" && current?.status === "experimental" ? current.cells : [], [mode, replay, current]);
  const lat = mode === "test" ? replay?.center[0] ?? 39.75 : Number.isFinite(Number(latText)) ? Number(latText) : 39.75;
  const lon = mode === "test" ? replay?.center[1] ?? -121.5 : Number.isFinite(Number(lonText)) ? Number(lonText) : -121.5;
  // What-if fire lines the user draws. They belong to one fire, so they are stored with its key.
  // Lines are shared per fire, so the key must be the same for every viewer of that fire.
  const scenarioKey = mode === "test" ? `test:${replay?.id ?? ""}` : `live:${lat.toFixed(2)},${lon.toFixed(2)}`;
  const [drawn, setDrawn] = useState<{ key: string; lines: DrawnLine[] }>({ key: "", lines: [] });
  const [tactic, setTactic] = useState<TacticId>("dozer");
  const sync = useRef({ key: "", version: 0, busy: 0 });
  const [drawing, setDrawing] = useState(false);
  // Deep link: ?event=<test fire id>&actual=1&line=lon,lat;lon,lat opens a held-out fire, optionally with what really burned and a what-if fire line.
  useEffect(() => { const t = setTimeout(() => { const q = new URLSearchParams(window.location.search); const e = q.get("event"); if (e) setEventId(e); if (q.get("actual") === "1") setShowObserved(true); const l = (q.get("line") ?? "").split(";").map(pt => pt.split(",").map(Number)).filter(pt => pt.length === 2 && pt.every(Number.isFinite)) as [number, number][]; if (e && l.length > 1) { sync.current.key = `test:${e}`; sync.current.version = Number.MAX_SAFE_INTEGER; setDrawn({ key: `test:${e}`, lines: [{ kind: tacticOf(q.get("tactic") ?? "").id, points: l }] }); } }, 0); return () => clearTimeout(t); }, []);
  const lines = useMemo(() => drawn.key === scenarioKey ? drawn.lines : [], [drawn, scenarioKey]);
  const whatIf = useMemo(() => applyFireLines(baseCells, lines.map(l => l.points)), [baseCells, lines]);
  const cells = whatIf.cells;
  const change = useMemo(() => { const likely = (list: { p: number; previous: number }[]) => list.filter(c => !c.previous && c.p >= .2).length, expected = (list: { p: number; previous: number }[]) => list.reduce((sum, c) => sum + (c.previous ? 0 : c.p), 0); return { likelyBefore: likely(baseCells), likelyAfter: likely(cells), expectedBefore: expected(baseCells), expectedAfter: expected(cells) }; }, [baseCells, cells]);
  // Save locally and send to the server, so other screens showing this fire pick the change up.
  const commit = (next: DrawnLine[]) => {
    setDrawn({ key: scenarioKey, lines: next }); saveBackup(scenarioKey, next);
    const s = sync.current, key = scenarioKey; s.busy++;
    fetch("/api/firelines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, lines: next.filter(l => l.points.length > 1).map(l => l.points), kinds: next.filter(l => l.points.length > 1).map(l => l.kind) }) })
      .then(r => r.ok ? r.json() as Promise<{ version: number }> : null).then(d => { if (d && s.key === key) s.version = Math.max(s.version, d.version); }).catch(() => undefined).finally(() => { s.busy--; });
  };
  // Check every few seconds for lines someone else added, moved or cleared.
  useEffect(() => {
    const s = sync.current;
    if (s.key !== scenarioKey) { s.key = scenarioKey; s.version = 0; }
    if (!baseCells.length || drawing) return;
    let stop = false;
    const poll = () => { fetch(`/api/firelines?${new URLSearchParams({ key: scenarioKey })}`).then(r => r.ok ? r.json() as Promise<{ lines: FireLine[]; kinds?: string[]; version: number }> : null).then(d => { if (stop || !d || s.busy || s.key !== scenarioKey) return;
      // The server's counter went backwards (or it has nothing): it restarted and lost the lines. Put this browser's copy back.
      if (s.version !== Number.MAX_SAFE_INTEGER && (d.version < s.version || (d.version === 0 && s.version === 0))) { const kept = readBackup(scenarioKey); s.version = d.version; if (kept.length) { s.busy++; fetch("/api/firelines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: scenarioKey, lines: kept.map(l => l.points), kinds: kept.map(l => tacticOf(l.kind).id) }) }).then(r => r.ok ? r.json() as Promise<{ version: number }> : null).then(v => { if (v && s.key === scenarioKey) { s.version = v.version; setDrawn({ key: scenarioKey, lines: kept.map(l => ({ kind: tacticOf(l.kind).id, points: l.points })) }); } }).catch(() => undefined).finally(() => { s.busy--; }); } return; }
      if (d.version <= s.version) return; s.version = d.version; const next = d.lines.map((points, i) => ({ kind: tacticOf(d.kinds?.[i] ?? "").id, points })); saveBackup(scenarioKey, next); setDrawn({ key: scenarioKey, lines: next }); }).catch(() => undefined); };
    poll(); const timer = setInterval(poll, 4000);
    return () => { stop = true; clearInterval(timer); };
  }, [scenarioKey, baseCells.length, drawing]);
  const addPoint = (pointLat: number, pointLon: number) => { if (!drawing) return; const last = lines[lines.length - 1] ?? { kind: tactic, points: [] }; commit([...lines.slice(0, -1), { kind: last.kind, points: [...last.points, [pointLon, pointLat] as [number, number]] }]); };
  const toggleDrawing = () => { const kept = lines.filter(l => l.points.length > 1); if (drawing) commit(kept); else setDrawn({ key: scenarioKey, lines: [...kept, { kind: tactic, points: [] }] }); setDrawing(!drawing); };
  const bounds = useMemo(() => extent(baseCells.some(c => c.p >= .01 || c.previous) ? baseCells.filter(c => c.p >= .01 || c.previous || c.observed) : baseCells, Math.max(25, Math.min(49.5, lat)), Math.max(-125, Math.min(-66, lon))), [baseCells, lat, lon]);
  const layers = useMemo(() => {
    const result: MapGeometryLayer[] = [];
    if (showProbability) for (const bin of BINS) { const subset = cells.filter(c => c.p >= bin.low && c.p < bin.high); if (subset.length) result.push({ id: `prob-${bin.low}`, label: `Model score ${bin.low.toFixed(2)}–${Math.min(1, bin.high).toFixed(2)}`, data: geometry(subset), color: bin.color, fillOpacity: bin.o, weight: bin.low === 0 ? 0 : .35, featureLabel: cellLabel }); }
    if (showPrevious) result.push({ id: "previous", label: "Previous observed activity", data: geometry(cells.filter(c => c.previous)), color: "#7fe3ff", fillOpacity: 0, weight: 1.3, dashArray: "4 3", featureLabel: cellLabel });
    if (mode === "test" && showObserved) result.push({ id: "observed", label: "Target-day detected activity", data: geometry(cells.filter(c => c.observed)), color: "#ffffff", fillOpacity: 0, weight: 2.2, featureLabel: cellLabel });
    const shielded = cells.filter(c => (c as { p0?: number }).p0 !== undefined);
    if (shielded.length) result.push({ id: "shielded", label: "Re-scored: behind a line", data: geometry(shielded), color: "#8fd0ff", fillOpacity: 0, weight: 1.1, featureLabel: cellLabel });
    for (const t of TACTICS) {
      const mine = lines.filter(l => l.kind === t.id && l.points.length);
      if (mine.length) result.push({ id: `tactic-${t.id}`, label: `${t.label} (entered on this map)`, data: { type: "FeatureCollection", features: mine.map(l => ({ type: "Feature", geometry: { type: "LineString", coordinates: l.points.length > 1 ? l.points : [l.points[0], [l.points[0][0] + 1e-5, l.points[0][1]]] }, properties: {} })) }, color: t.color, fillOpacity: 0, weight: 4.5, dashArray: t.dash });
    }
    return result;
  }, [cells, lines, mode, showProbability, showPrevious, showObserved]);
  const candidates = (incidents?.incidents ?? []).filter(i => i.containment !== 100 && !["AK", "HI"].includes(i.state));
  function changeLocation(a: string, b: string) { liveAbort.current?.abort(); sequence.current++; setRequest(null); setLatText(a); setLonText(b); setOutlook(null); setLiveError(""); setLiveLoading(false); }
  function runOutlook() { const a = Number(latText), b = Number(lonText); if (!latText.trim() || !lonText.trim() || !Number.isFinite(a) || !Number.isFinite(b) || a < 24 || a > 50 || b < -126 || b > -66) { setLiveError("Choose a valid location in the contiguous United States."); setOutlook(null); return; } setOutlook(null); setLiveError(""); setLiveLoading(true); setRequest({ lat: a, lon: b, seq: ++sequence.current }); }
  function retryArtifacts() { setArtifactLoading(true); setArtifactError(""); setRetry(v => v + 1); }

  return <section className="prediction-panel">
    <header className="prediction-heading"><div><span className="section-kicker">RESEARCH / NEXT-DAY ACTIVITY</span><h2>Where a fire may be seen tomorrow.</h2><p>Replay it on past fires, or try it on a fire burning now.</p></div><span className="prediction-badge"><FlaskConical size={13} /> Experimental model</span></header>
    <nav className="prediction-tabs" aria-label="Prediction views">{MODES.map(item => <button key={item.id} onClick={() => setMode(item.id)} aria-current={mode === item.id ? "page" : undefined} className={mode === item.id ? "active" : ""}>{item.label}</button>)}</nav>

    {(mode === "test" || mode === "current") && <>
      <div className="prediction-contract"><ShieldCheck size={17} /><div><p><strong>Each 1.5 km square shows how likely satellites are to detect fire there tomorrow.</strong> Experimental, not an official warning.</p><More label="Fine print"><p>Next UTC-day detected activity near an existing fire. 1.5 km cells aggregate NOAA-20 detections; the model was trained on S-NPP. Current outputs are experimental model scores; live probability calibration is not established. They do not describe flame fronts or issue official warnings.</p></More></div></div>
      {evaluation && <EvaluationSummary report={evaluation} />}
      {mode === "test" && <>
        <div className="prediction-stats">{[{ label: "HELD-OUT PR-AUC", value: number(evaluation?.test.model.prAuc), sub: "Precision–recall area, not accuracy" }, { label: "BRIER SCORE", value: number(evaluation?.test.model.brier), sub: "Probability error · lower is better" }, { label: "TEST EVENTS", value: count(evaluation?.splits.test?.events), sub: `${evaluation?.splits.test?.years.join(", ") ?? "Awaiting artifact"} · every event is browseable` }, { label: "CELL SIZE", value: "1.5 km", sub: "Not the weather data resolution" }].map(item => <div key={item.label}><span>{item.label}</span><strong>{item.value}</strong><small>{item.sub}</small></div>)}</div>
        {artifactLoading && <div className="prediction-message" role="status">Loading the fitted model’s held-out test cases…</div>}
        {artifactError && <div className="prediction-message error" role="alert">{artifactError}<button onClick={retryArtifacts}>Retry artifacts</button></div>}
      </>}
      {mode === "current" && <>
        <div className="prediction-sensor-note"><strong>Sensor transition</strong><p>S-NPP delivery ended November 2, 2026 at 13:00 UTC. Inputs now come from NOAA-20. The unchanged model passed a one-shot retrospective NOAA-20 test on 35 untouched 2021 fires: it ranks cells clearly better than persistence, but its probability-error gains are not statistically resolved and live calibration is unproven. The NOAA-20 near-real-time feed has no fire-type field, so industrial heat sources are not removed. The outlook abstains when NOAA-20 observations are missing or a NASA-listed NOAA-20 outage overlaps a required day.</p><SourceLink id="snpp-cessation" /><SourceLink id="noaa20-outages" /></div>
        <form className="prediction-location" onSubmit={e => { e.preventDefault(); runOutlook(); }}>
          <label className="prediction-incident">Reported incident location<select value={candidates.find(i => i.lat === Number(latText) && i.lon === Number(lonText))?.id ?? ""} onChange={e => { const item = candidates.find(i => i.id === e.target.value); if (item) changeLocation(String(item.lat), String(item.lon)); }}><option value="">Choose an incident, or enter coordinates</option>{candidates.map(i => <option key={i.id} value={i.id}>{i.name} · {i.state}</option>)}</select></label>
          <label>Latitude<input type="number" step="any" value={latText} onChange={e => changeLocation(e.target.value, lonText)} /></label><label>Longitude<input type="number" step="any" value={lonText} onChange={e => changeLocation(latText, e.target.value)} /></label>
          <button className="prediction-run" disabled={liveLoading} type="submit"><RefreshCw size={14} className={liveLoading ? "prediction-spin" : ""} />{liveLoading ? "Checking inputs…" : "Run outlook"}</button>
        </form>
        <p className="prediction-small">A reported incident location does not confirm active flames. Manual coordinates select a location, not a named fire.{incidentError ? ` Incident list: ${incidentError}` : incidents?.partial ? " The incident index is partial." : ""}</p>
        {liveError && <div className="prediction-message error" role="alert">{liveError} No previous forecast is displayed.</div>}
        {(current as (FireOutlook & { olderDrought?: { pdsiDate: string; ageDays: number } }) | null)?.olderDrought && <div className="prediction-message abstained" role="status"><strong>Using older dryness data</strong><span>The drought index is dated {(current as FireOutlook & { olderDrought: { pdsiDate: string; ageDays: number } }).olderDrought.pdsiDate} ({(current as FireOutlook & { olderDrought: { pdsiDate: string; ageDays: number } }).olderDrought.ageDays} days old; the tested limit is 5). Scores with older dryness data have not been evaluated.</span></div>}
        {catchUp?.used && current && <div className="prediction-message abstained" role="status"><strong>Showing the outlook made from {current.issueDate} data</strong><span>Today’s weather data are not published yet, so this map is for {current.targetDate} (UTC) using fire seen on {current.recentFireDate}. A fresh outlook can be made from about {localTime(catchUp.earliestNextUpdate)} your time, once today’s data arrive. This catch-up path has not been tested separately.</span></div>}
        {current?.status === "abstained" && catchUp && !catchUp.used && <div className="prediction-message abstained" role="status"><strong>Too early in the day for a new outlook</strong><span>Today’s weather data are not published yet, and yesterday’s outlook could not be built for this spot either (see the reasons below). Try again from about {localTime(catchUp.earliestNextUpdate)} your time.</span></div>}
        {current?.status === "abstained" && <div className="prediction-message abstained" role="status"><strong>No outlook issued</strong><ul>{current.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul><span>Missing evidence is not a low-risk forecast.</span></div>}
      </>}

      <div className="prediction-map-card">
        <div className="prediction-map-heading"><div><span className="section-kicker">{mode === "test" ? "HELD-OUT TEST CASE" : "SELECTED LOCATION"}</span><h2>{mode === "test" ? replay ? fireName(replay) : "Awaiting test cases" : `${Number(latText).toFixed(3)}°, ${Number(lonText).toFixed(3)}°`}</h2>{mode !== "test" && latText.trim() !== "" && Number.isFinite(Number(latText)) && Number.isFinite(Number(lonText)) && <a className="text-link" href={`/scene?lat=${Number(latText).toFixed(4)}&lon=${Number(lonText).toFixed(4)}`}>See the latest satellite pass in 3D →</a>}</div>
          {mode === "test" ? <div className="prediction-case-picker"><button aria-label="Previous test event" disabled={replayIndex <= 0} onClick={() => setEventId(replays[replayIndex - 1].id)}><ChevronLeft size={17} /></button><select aria-label="Held-out event" value={replay?.id ?? ""} onChange={e => setEventId(e.target.value)}>{replays.map((r, i) => <option key={r.id} value={r.id}>{i + 1} / {replays.length} · {fireName(r)} · {fireSize(r)} {fireSize(r) === 1 ? "square" : "squares"} burning</option>)}</select><button aria-label="Next test event" disabled={replayIndex < 0 || replayIndex >= replays.length - 1} onClick={() => setEventId(replays[replayIndex + 1].id)}><ChevronRight size={17} /></button></div> : <span className={`prediction-badge ${current?.status === "abstained" ? "warning" : ""}`}>{liveLoading ? "Retrieving evidence" : current?.status === "experimental" ? "Experimental transfer" : current?.status === "abstained" ? "Abstained" : "Not requested"}</span>}
        </div>
        <div className="prediction-dates"><span>Issue day <strong>{mode === "test" ? replay?.issueDate ?? "—" : current?.issueDate ?? "—"}</strong></span><span>Fire observed <strong>{mode === "test" ? replay?.recentFireDate ?? "—" : current?.recentFireDate ?? "—"}</strong></span><span>Target UTC day <strong>{mode === "test" ? replay?.targetDate ?? "—" : current?.targetDate ?? "—"}</strong></span></div>
        <div className="prediction-layer-controls"><button aria-pressed={showProbability} onClick={() => setShowProbability(v => !v)}>Model score</button><button aria-pressed={showPrevious} onClick={() => setShowPrevious(v => !v)}><i className="previous" />Previous detections</button>{mode === "test" && <button aria-pressed={showObserved} onClick={() => setShowObserved(v => !v)}><i className="observed" />Target-day observations</button>}<select className="prediction-tactic" aria-label="What crews did" value={tactic} disabled={drawing || !baseCells.length} onChange={e => setTactic(e.target.value as TacticId)}>{TACTICS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select><button className="prediction-draw" aria-pressed={drawing} disabled={!baseCells.length} onClick={toggleDrawing}><PenLine size={12} />{drawing ? "Finish" : "Draw it"}</button>{lines.some(l => l.points.length) && <button onClick={() => { commit([]); setDrawing(false); }}><X size={12} />Clear lines</button>}<button className="prediction-basemap" aria-pressed={satellite} onClick={() => setSatellite(v => !v)}><Layers size={12} />{satellite ? "Satellite view" : "Plain map"}</button></div>
        <div className="prediction-map"><FireMap className={drawing ? "drawing" : ""} onMapClick={addPoint} points={[]} satellite={satellite} bounds={bounds} geometryLayers={layers} fitKey={mode === "test" ? replay?.id ?? "test-empty" : `${latText}:${lonText}:${current?.fetchedAt ?? "empty"}`} />{!cells.length && <div className="prediction-map-empty"><MapPin size={18} /><span>{mode === "test" ? "Test data will appear when the fitted artifacts are available." : liveLoading ? "Checking the required observations and forecast run…" : current?.status === "abstained" ? (catchUp ? `No map yet: today’s weather data are not published. Try again from about ${localTime(catchUp.earliestNextUpdate)}.` : "No map: a required data source is unavailable. See the reasons above.") : "Run an outlook for this location."}</span></div>}</div>
        <div className="prediction-legend"><span>Experimental score</span>{BINS.map(bin => <span key={bin.low}><i style={{ background: bin.color }} />{bin.low === 0 ? "<0.01" : bin.low === .6 ? "≥0.60" : `${bin.low.toFixed(2)}–${bin.high.toFixed(2)}`}</span>)}</div>
        {(drawing || lines.some(l => l.points.length)) && <div className="prediction-whatif" role="status"><p><strong>What if this holds?</strong> {drawing && !lines.some(l => l.points.length > 1) ? `Click the map to place points along the ${tacticOf(tactic).label.toLowerCase()}. The map updates with every click.` : `The model re-scored ${count(whatIf.cutOff + whatIf.lowered)} squares behind it (${count(whatIf.cutOff)} fully cut off). New ground likely to burn tomorrow (20%+ chance): ${count(change.likelyBefore)} → ${count(change.likelyAfter)} squares. Expected new burning: ${change.expectedBefore.toFixed(1)} → ${change.expectedAfter.toFixed(1)} squares.`} Lines are shared: every screen showing this fire picks them up within a few seconds.</p>{lines.some(l => l.points.length > 1) && <span className="prediction-tactic-key">{TACTICS.filter(t => lines.some(l => l.kind === t.id && l.points.length > 1)).map(t => <span key={t.id}><i style={{ background: t.color }} />{t.label}</span>)}</span>}<More label="How the model re-scores"><p>A second, small model takes each square’s original score and where it sits behind the line (1–2, 3–5 or 6+ squares from the fire, and whether it is fully cut off) and returns a lower score. It was fitted on {FIRELINE_MODEL.fires} fires from 2020 where crews recorded completed lines: {count(FIRELINE_MODEL.squaresBehindLine)} squares behind a line, of which {count(FIRELINE_MODEL.burnedBehindLine)} burned the next day. <strong>Tested on {FIRELINE_MODEL.test2021.fires} fires from 2021, it did not make the forecast more accurate</strong>: there, {count(FIRELINE_MODEL.test2021.burnedBehindLine)} of {count(FIRELINE_MODEL.test2021.squaresBehindLine)} squares behind a line burned, and lowering their scores made the forecast slightly worse, not better. So read this as a what-if for a line that holds, not as a tested forecast. Every tactic uses the same weights. It never raises a score. Embers can jump a line.</p></More></div>}<p className="prediction-map-note">Hover a square for its score. “No detection” does not mean “no fire”: clouds, smoke or a missed pass can hide one.</p>
      </div>
      {mode === "test" && <div className="prediction-below"><More label="About these test fires"><p>All held-out events are listed, with no selection for model success. The dataset gives fires identifiers, not names{replay ? ` (this one is ${replay.id})` : ""}; the page opens on the one with the most squares already burning. The model uses two earlier fire days, lagged weather and issue-day GFS conditions. Historical final data does not prove live operational performance.</p></More><button onClick={() => setMode("validation")}>Inspect validation <ArrowUpRight size={14} /></button></div>}
      {mode === "current" && <>
        {current && <div className="prediction-current-summary"><span>Fetched {utc(current.fetchedAt)}</span><span>Complete features: {current.featureCoverage.completeCells} / {current.featureCoverage.totalCells} cells</span><span>NOAA-20 previous-day detections: {current.fireSource?.recentCount ?? "unavailable"}</span></div>}
        {current?.satelliteHealth && <section className="prediction-card prediction-health-card"><span className="section-kicker">SATELLITE OBSERVATION HEALTH</span><h2>{current.satelliteHealth.status === "no-reported-gap" ? "No listed outage overlaps the required days" : current.satelliteHealth.status === "reported-gap" ? "Known satellite data gap — outlook withheld" : "Satellite health could not be verified"}</h2><p>Required fire days: {current.satelliteHealth.requiredDates.join(" and ")}. Catalogue retrieved {utc(current.satelliteHealth.fetchedAt)} · editorial update {current.satelliteHealth.sourceUpdatedDate ?? "not supplied"}.</p>{current.satelliteHealth.error && <p>{current.satelliteHealth.error}</p>}{current.satelliteHealth.overlappingOutages.length > 0 && <ul>{current.satelliteHealth.overlappingOutages.map(gap => <li key={`${gap.start}/${gap.end}`}><strong>{utc(gap.start)} to {utc(gap.end)}</strong><br />{gap.description}</li>)}</ul>}<p className="prediction-small">This checks NASA’s reported outages. It cannot establish cloud-free coverage or rule out unreported gaps. When an outage overlaps an input day and its local impact is unknown, no model grid is issued.</p><a href={current.satelliteHealth.sourceUrl} target="_blank" rel="noreferrer">NASA NOAA-20 outage catalogue <ArrowUpRight size={12} /></a></section>}
        {current?.inputs?.gfs && <ForecastContext forecast={current.inputs.gfs} targetDate={current.targetDate} />}
        <div className="prediction-live-grid"><section className="prediction-card"><span className="section-kicker">OFFICIAL / NWS</span><h2>Fire weather alerts</h2>{!current ? <p>Run the outlook to retrieve official alerts for the selected location.</p> : !current.inputs || current.inputs.officialAlerts === null ? <p className="prediction-unavailable">Official alert status is unavailable. This does not mean no alerts are in effect.</p> : current.inputs.officialAlerts.length === 0 ? <p>No active fire-weather alert was returned for this point at retrieval. That does not establish low fire risk.</p> : current.inputs.officialAlerts.map(alert => <article className="prediction-alert" key={alert.id}><strong>{alert.event}</strong><p>{alert.headline}</p><small>Issued {utc(alert.sent)} · expires {utc(alert.expires)}</small><a href={alert.url} target="_blank" rel="noreferrer">Read official alert <ArrowUpRight size={12} /></a></article>)}<p className="prediction-small">Official alerts use local fuel/weather criteria and forecaster judgment. They are separate from this experimental model.</p></section>
          <section className="prediction-card"><span className="section-kicker">SOURCE AVAILABILITY</span><h2>Inputs and freshness</h2>{!current?.inputs ? <p>Input status will appear after retrieval. A source failure never receives a fabricated value.</p> : <div className="prediction-source-list">{current.inputs.sources.map(source => <details key={source.id}><summary><strong>{source.id}</strong><span className={`prediction-status ${source.status}`}>{source.status}</span></summary><p>Source date: {source.sourceDate ?? "Not supplied"}<br />Fetched: {utc(source.fetchedAt)}</p>{source.error && <p>{source.error}</p>}{source.warnings.map((warning, i) => <p key={i}>{warning}</p>)}<a href={source.url} target="_blank" rel="noreferrer">Source <ArrowUpRight size={11} /></a></details>)}</div>}</section></div>
        {current && <details className="prediction-notes"><summary>Transfer limitations and source notes</summary><ul>{[...new Set([...current.warnings, ...(current.inputs?.warnings ?? [])])].map((warning, i) => <li key={i}>{warning}</li>)}</ul><p>Forecast weather for tomorrow, when shown elsewhere, is context. The fitted GFS inputs describe issue-day antecedent conditions.</p></details>}
      </>}
    </>}

    {mode === "research" && <div className="prediction-research"><div className="prediction-intro"><BookOpen size={22} /><div><h2>Variables and data gaps</h2><p>Modeled variables are represented in the released feature manifest. Context lists additional information and source candidates; some are not connected to the live view. Missing processes remain unresolved.</p></div></div>
      {FIRE_PREDICTOR_CATEGORIES.map(category => <details className="prediction-category" key={category.id}><summary><div><h3>{category.title}</h3><p>{category.summary}</p></div><span>{category.variables.length} variables</span></summary><div className="prediction-variable-list">{category.variables.map(variable => <article key={variable.id}><div className="prediction-variable-title"><h4>{variable.label}</h4><span className={`prediction-coverage ${variable.coverage}`}>{variable.coverage}</span></div><p>{variable.influence}</p><p><strong>Freshness:</strong> {variable.freshness}</p><ul>{variable.limitations.map((limitation, i) => <li key={i}>{limitation}</li>)}</ul><div className="prediction-links">{variable.sourceIds.map(id => <SourceLink key={id} id={id} />)}</div></article>)}</div></details>)}
      <h2 className="prediction-subheading">Recent research behind the approach</h2><div className="prediction-paper-grid">{FIRE_PREDICTOR_RECENT_RESEARCH.map(paper => <article className="prediction-card" key={paper.sourceId}><span className="section-kicker">{paper.status}</span><h3><SourceLink id={paper.sourceId} /></h3><p>{paper.takeaway}</p><p><strong>Application:</strong> {paper.application}</p><p className="prediction-small">{paper.limitation}</p></article>)}</div>
    </div>}

    {mode === "validation" && <div className="prediction-validation"><div className="prediction-intro"><ShieldCheck size={23} /><div><h2>Evidence before confidence.</h2><p>These numbers come from the saved fitted-model evaluation. Research-paper scores are never substituted for this model’s results.</p></div></div>
      {artifactLoading ? <div className="prediction-message" role="status">Loading evaluation…</div> : artifactError || !evaluation ? <div className="prediction-message error" role="alert">{artifactError || "Evaluation unavailable."}<button onClick={retryArtifacts}>Retry</button></div> : <>
        <div className="prediction-card"><span className="section-kicker">FITTED ARTIFACT</span><h2>{evaluation.modelType}</h2><p>{evaluation.target}</p>{evaluation.protocol?.chosen && <p><strong>Selected score blend:</strong> {percent(evaluation.protocol.chosen.treeWeight)} learned trees + {percent(1 - evaluation.protocol.chosen.treeWeight)} persistence baseline. {evaluation.protocol.chosen.calibration === "identity" ? "Tree scores retain their original scale; no calibration offset is applied." : "The tree scores use a conservative calibration offset fitted on separate fires."}{evaluation.protocol.chosen.treeWeight === 0 ? " The selected predictor uses persistence alone; weather and terrain do not affect its scores." : ""}</p>}<div className="prediction-split-grid">{Object.entries(evaluation.splits).sort(([a], [b]) => ["train", "calibration", "selection", "validation", "test"].indexOf(a) - ["train", "calibration", "selection", "validation", "test"].indexOf(b)).map(([name, split]) => <div key={name}><strong>{name === "selection" ? "Model selection" : name}</strong><span>{split.years.join(", ")}</span><small>{count(split.events)} events · {count(split.cells)} cells · {count(split.positives)} positives{split.positiveEvents !== undefined ? ` across ${count(split.positiveEvents)} fires` : ""}</small></div>)}</div><p className="prediction-small">{evaluation.weighting}</p><div className="prediction-links"><SourceLink id="independent-calibration" /><SourceLink id="selection-bias" /></div></div>
        <div className="prediction-downloads" aria-label="Download model and evaluation"><a href="/data/ml/model.json" download><Download size={14} /> Fitted model JSON</a><a href="/data/ml/evaluation.json" download><Download size={14} /> Evaluation JSON</a><a href="/data/ml/reproducible-model.zip" download><Download size={14} /> Reproducible model bundle</a></div>
        <div className="prediction-table-wrap"><table><caption>Held-out test · compare methods on the same retained cells</caption><thead><tr><th>Method</th><th>PR-AUC ↑</th><th>Brier ↓</th><th>Precision</th><th>Recall</th><th>Threshold</th></tr></thead><tbody>{["model", "previousVersion", "smoothedPersistence", "persistence", "logistic"].filter(key => evaluation.test[key]).map(key => { const score = evaluation.test[key]; return <tr key={key}><th>{({ model: "Fitted model", previousVersion: "Previous release (v1)", smoothedPersistence: "Smoothed persistence", persistence: "Persistence", logistic: "Logistic baseline" })[key]}</th><td>{number(score.prAuc)}</td><td>{number(score.brier)}</td><td>{percent(score.precision)}</td><td>{percent(score.recall)}</td><td>{number(score.threshold, 3)}</td></tr>; })}</tbody></table></div>
        {evaluation.pairedComparisons && <div className="prediction-comparison-card prediction-card"><span className="section-kicker">PAIRED COMPARISON / SAME TEST FIRES</span><h2>What changed, and how certain is it?</h2><p>Each difference is the fitted model minus its comparator. Negative Brier differences favor this model; positive PR-AUC differences favor this model. Intervals resample geographic groups of test fires together, preserving each comparison.</p><div className="prediction-table-wrap"><table><caption>Difference and 95% interval · an interval crossing zero is inconclusive</caption><thead><tr><th>Compared with</th><th>Brier difference ↓</th><th>95% interval</th><th>PR-AUC difference ↑</th><th>95% interval</th></tr></thead><tbody>{Object.entries(evaluation.pairedComparisons).map(([key, pair]) => <tr key={key}><th>{key === "previousVersion" ? "Previous release (v1)" : key === "smoothedPersistence" ? "Smoothed persistence" : key}</th><td>{number(pair.brierDelta, 5)}</td><td>{pair.brierDelta95.map(v => number(v, 5)).join(" to ")}</td><td>{number(pair.prAucDelta, 4)}</td><td>{pair.prAucDelta95.map(v => number(v, 4)).join(" to ")}</td></tr>)}</tbody></table></div><p className="prediction-small">A favorable historical comparison does not establish live calibration or operational readiness.</p></div>}
        <p className="prediction-small">PR-AUC measures precision–recall ranking; it is not percent accuracy. Threshold metrics depend on the reported operating point. Test prevalence: {percent(evaluation.test.model.positiveRate)}.</p>
        <div className="prediction-live-grid"><section className="prediction-card"><h2>Uncertainty across test fires</h2><p>PR-AUC interval: {evaluation.confidenceIntervals.prAuc.map(v => number(v)).join(" – ")}<br />Brier interval: {evaluation.confidenceIntervals.brier.map(v => number(v)).join(" – ")}</p><p className="prediction-small">{evaluation.confidenceIntervals.method}</p>{evaluation.test.newActivity && <p>Previously unoccupied cells: PR-AUC {number(evaluation.test.newActivity.prAuc)}, recall {percent(evaluation.test.newActivity.recall)} across {count(evaluation.test.newActivity.cells)} cells.</p>}</section><section className="prediction-card"><h2>Reliability</h2><p className="prediction-small">Mean predicted probability compared with observed frequency in each populated bin.</p><ReliabilityPlot bins={evaluation.reliability} /><div className="prediction-reliability">{evaluation.reliability.map(bin => <div key={bin.low}><span>{percent(bin.meanPredicted)}</span><div><i style={{ width: `${Math.max(0, Math.min(100, bin.observedRate * 100))}%` }} /></div><strong>{percent(bin.observedRate)}</strong><small>{count(bin.cells)} cells</small></div>)}</div><p className="prediction-small">Left: predicted · bar/right: observed. Historical calibration does not establish live calibration.</p></section></div>
        {evaluation.sourceAvailabilityDiagnostics && <details className="prediction-notes"><summary>Satellite outages in the historical test</summary><p>{evaluation.sourceAvailabilityDiagnostics.eligibleTestInputGapEvents.length} test events have a listed outage on a required input day; {evaluation.sourceAvailabilityDiagnostics.eligibleTestTargetGapEvents.length} have a listed outage on their target day. These are source-level reports, not local clear-sky coverage masks.</p><p>Excluding only the known input-gap events leaves {count(evaluation.sourceAvailabilityDiagnostics.knownInputGapExcluded.events)} fires, {count(evaluation.sourceAvailabilityDiagnostics.knownInputGapExcluded.cells)} cells and {count(evaluation.sourceAvailabilityDiagnostics.knownInputGapExcluded.positives)} positive detections.</p><p>Model Brier: {number(evaluation.sourceAvailabilityDiagnostics.knownInputGapExcluded.test.model?.brier, 5)} · Previous release: {number(evaluation.sourceAvailabilityDiagnostics.knownInputGapExcluded.test.previousVersion?.brier, 5)} · Smoothed persistence: {number(evaluation.sourceAvailabilityDiagnostics.knownInputGapExcluded.test.smoothedPersistence?.brier, 5)}.</p><p>{evaluation.sourceAvailabilityDiagnostics.scope}</p><a href={evaluation.sourceAvailabilityDiagnostics.sourceUrl} target="_blank" rel="noreferrer">NASA outage history <ArrowUpRight size={12} /></a></details>}
        <details className="prediction-notes"><summary>Feature manifest, timing and provenance</summary><p>Model {evaluation.modelId}</p><code>{evaluation.modelSha256}</code><p>{evaluation.featureNames.join(", ")}</p><dl>{Object.entries(evaluation.timing).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl><p>Excluded fields:</p><ul>{Object.entries(evaluation.excludedBands).map(([key, value]) => <li key={key}>{key}: {value}</li>)}</ul><a href={evaluation.source.url} target="_blank" rel="noreferrer">{evaluation.source.title} · {evaluation.source.license}<ArrowUpRight size={12} /></a></details>
        <div className="prediction-card"><h2>Limits of this evaluation</h2><ul>{evaluation.limitations.map((item, i) => <li key={i}>{item}</li>)}</ul></div>
      </>}
      <h2 className="prediction-subheading">Release checks</h2><div className="prediction-checks">{FIRE_PREDICTOR_VALIDATION_CHECKS.map(check => <details key={check.id}><summary>{check.label}</summary><p>{check.requirement}</p></details>)}</div><p className="prediction-small">These are review requirements, not a claim that every check has passed. {FIRE_PREDICTOR_SCOPE.warningBoundary}</p>
    </div>}
  </section>;
}
