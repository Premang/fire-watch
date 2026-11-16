"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, Box, CalendarRange, Circle, Crosshair, Flame, Hexagon, Image as ImageIcon, Link2, Loader2, MapPin, RotateCcw, Search, Square, Table2, TrendingUp, X } from "lucide-react";
import dynamic from "next/dynamic";
import { activityTicks, anomalyColor, anomalyMap, annualTotals, climatology, latestVsMedian, MONTH_NAMES, rangeSummary, seasonRanking, seasonShare, seasonWindows, sequentialColor, topMonths, trend, type MonthAnomaly, type MonthPoint, type Platform, type RampName, type SeriesKey } from "@/lib/harmonized/analytics";
import { aggregateTiles, aoiAreaKm2, aoiBounds, cellCenter, chooseLevel, containsPoint, maybeGunzip, parseTile, presetToMonthPoints, tilesForAoi, toMonthPoints, type Aoi, type HarmonizedMeta, type PresetSeries, type Tile } from "@/lib/harmonized/data";
import { calendarCsv, calendarPng, decodeView, download, encodeView } from "@/lib/harmonized/exports";
import { fetchHotspots, hotspotInfo, type HotspotInfo } from "@/lib/harmonized/hotspots-client";
import { monthLabelL, MONTHS, MONTHS_LONG, num, STR, type Lang, type Strings } from "@/lib/harmonized/i18n";
import BurnCalendar, { type ColorMode } from "./burn-calendar";
import WorldSeasons from "./world-seasons";
import More from "./more";
import { AnnualChart, SeasonalChart, SeasonTimingChart, SensorChart, SOURCE_COLORS, sourceLabels } from "./charts";
import RecentPanel from "./recent-panel";
import type { ActivityCell, DrawMode } from "./aoi-map";

const AoiMap = dynamic(() => import("./aoi-map"), { ssr: false, loading: () => <div className="atlas-empty">Loading map…</div> });

type Preset = { id: string; kind: "country" | "admin1"; code: string; country?: string; name: string; nameEs?: string; bbox: [number, number, number, number] };
const DEFAULT_PLACE = "admin1:AR-X"; // Córdoba, Argentina: a fire-prone province with a pronounced late-winter season
const QUICK: { id: string; label: string }[] = [
  { id: "admin1:AR-X", label: "Córdoba, AR" }, { id: "country:ARG", label: "Argentina" }, { id: "admin1:AR-W", label: "Corrientes, AR" },
  { id: "admin1:BR-MT", label: "Mato Grosso, BR" }, { id: "admin1:US-CA", label: "California, US" }, { id: "admin1:AU-NSW", label: "New South Wales, AU" },
];
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");
const tick = (v: number) => v >= 1000 ? `${v / 1000}k` : String(v);

const tileCache = new Map<string, Promise<Tile>>();
/** Tiles are cached while they load or after they succeed; a failure is never cached, so a retry refetches it. */
function loadTile(path: string, tx: number, ty: number): Promise<Tile> {
  const url = `${path}${tx}_${ty}.bin.gz`;
  let p = tileCache.get(url);
  if (!p) {
    p = fetch(url).then(async r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return parseTile(await maybeGunzip(await r.arrayBuffer())); });
    tileCache.set(url, p); p.catch(() => tileCache.delete(url));
  }
  return p;
}

function presetAoi(p: Preset, geometry: { type: string; coordinates: unknown } | null): Aoi {
  if (geometry?.type === "Polygon") return { kind: "polygon", rings: [geometry.coordinates as [number, number][][]], label: p.name, presetId: p.id };
  if (geometry?.type === "MultiPolygon") return { kind: "polygon", rings: geometry.coordinates as [number, number][][][], label: p.name, presetId: p.id };
  const [w, s, e, n] = p.bbox;
  return { kind: "polygon", rings: [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]], label: p.name, presetId: p.id };
}
/** "Aug–Oct" when the months are consecutive (wrapping the year), otherwise a list. */
function seasonText(months: number[], names: readonly string[] = MONTH_NAMES): { text: string; start: number } {
  const s = [...months].sort((a, b) => a - b);
  for (let r = 0; r < s.length; r++) {
    const rot = [...s.slice(r), ...s.slice(0, r)];
    if (rot.every((m, i) => i === 0 || m === (rot[i - 1] + 1) % 12)) return { text: rot.length > 1 ? `${names[rot[0]]}–${names[rot.at(-1)!]}` : names[rot[0]], start: rot[0] };
  }
  return { text: s.map(m => names[m]).join(", "), start: s[0] };
}

export default function AtlasPage({ lang = "en" }: { lang?: Lang }) {
  const L = STR[lang], M = MONTHS[lang], ML = MONTHS_LONG[lang], SL = sourceLabels(lang);
  const fmt = (n: number | null | undefined, d = 0) => num(lang, n, d), monthLabel = (m: string) => monthLabelL(lang, m);
  const [meta, setMeta] = useState<HarmonizedMeta | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"place" | "draw" | "coords">("place");
  const [query, setQuery] = useState("");
  const [drawMode, setDrawMode] = useState<DrawMode>("none");
  const [aoi, setAoi] = useState<Aoi | null>(null);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [outline, setOutline] = useState<object | null>(null);
  type Loaded = { aoi: Aoi; points: MonthPoint[]; res: { exact: boolean; cellKm: number; cellsInside: number }; tiles: Tile[]; overlayMissing: number };
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<{ aoi: Aoi; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [from, setFrom] = useState("2001-01"), [to, setTo] = useState("2025-12");
  const [key, setKey] = useState<SeriesKey>("h");
  const [mode, setMode] = useState<ColorMode>("activity");
  const [ramp, setRamp] = useState<RampName>("inferno");
  const [selected, setSelected] = useState<string | null>(null);
  const [showValues, setShowValues] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const [coords, setCoords] = useState({ lat: "-31.42", lon: "-64.18", radius: "100", w: "", s: "", e: "", n: "" });
  const [info, setInfo] = useState<HotspotInfo | null>(null);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");
  const notify = (m: string) => { setToast(m); setTimeout(() => setToast(""), 4500); };
  const current = loaded && loaded.aoi === aoi ? loaded : null;
  const series = current?.points ?? null;
  const resolution = !current ? "" : current.res.exact ? (lang === "es" ? "celdas exactas de 5 km" : "exact 5 km cells") : lang === "es" ? `celdas de ${current.res.cellKm} km (${fmt(current.res.cellsInside)} con actividad)` : `${current.res.cellKm} km cells (${fmt(current.res.cellsInside)} with activity)`;
  const loading = !!aoi && !current && loadError?.aoi !== aoi;
  const areaError = loadError && loadError.aoi === aoi ? loadError.message : "";

  // Every area choice bumps this counter; a slower, older preset geometry request then cannot overwrite a newer choice (Astra 15a).
  const areaSeq = useRef(0);
  const choosePreset = useCallback(async (p: Preset) => {
    const mine = ++areaSeq.current;
    setPreset(p); setQuery(""); setDrawMode("none");
    try {
      const file = p.kind === "country" ? "/data/aoi/countries.json" : `/data/aoi/admin1/${p.country}.json`;
      const fc = await fetch(file).then(r => { if (!r.ok) throw new Error(); return r.json(); }) as { features: { properties: { id: string }; geometry: { type: string; coordinates: unknown } }[] };
      if (mine !== areaSeq.current) return;
      const f = fc.features.find(x => x.properties.id === p.id);
      setOutline(f ? { type: "Feature", properties: {}, geometry: f.geometry } : null);
      setAoi(presetAoi(p, f?.geometry ?? null));
    } catch { if (mine === areaSeq.current) { setOutline(null); setAoi(presetAoi(p, null)); } }
  }, []);

  // ---- boot: meta, preset index, URL state, export capability ----
  useEffect(() => {
    hotspotInfo().then(setInfo);
    Promise.all([fetch("/data/harmonized/meta.json").then(r => { if (!r.ok) throw new Error("The harmonized archive is not available."); return r.json() as Promise<HarmonizedMeta>; }),
      fetch("/data/aoi/index.json").then(r => { if (!r.ok) throw new Error("The place index is not available."); return r.json() as Promise<{ presets: Preset[] }>; })])
      .then(([m, idx]) => {
        setMeta(m); setPresets(idx.presets);
        const v = decodeView(window.location.search);
        setFrom(v.from ?? `${Math.max(2001, Number(m.firstMonth.slice(0, 4)))}-01`); setTo(v.to ?? m.lastMonth);
        if (v.key) setKey(v.key); if (v.mode) setMode(v.mode); if (v.ramp) setRamp(v.ramp); if (v.month) setSelected(v.month);
        const initial = v.presetId ?? (!v.aoi ? DEFAULT_PLACE : null);
        if (v.aoi) { setAoi(v.aoi); setTab(v.aoi.kind === "circle" ? "coords" : "draw"); }
        else if (initial) { const p = idx.presets.find(x => x.id === initial); if (p) void choosePreset(p); }
      }).catch((e: unknown) => setError(e instanceof Error ? e.message : "The harmonized archive could not load."));
  }, [choosePreset]);

  // ---- series for the current AOI (state is only set asynchronously) ----
  useEffect(() => {
    if (!meta || !aoi) return;
    let cancelled = false;
    (async () => {
      const level = chooseLevel(meta, aoi);
      const want = tilesForAoi(aoi, level.cellKm, level.tileCells).filter(([x, y]) => level.tiles.includes(`${x}_${y}`));
      const settled = await Promise.allSettled(want.map(([x, y]) => loadTile(level.path, x, y)));
      const tiles = settled.flatMap(r => (r.status === "fulfilled" ? [r.value] : [])), failed = want.length - tiles.length;
      let points: MonthPoint[], res: Loaded["res"];
      if (aoi.presetId && meta.presetsWithData?.includes(aoi.presetId)) {
        const r = await fetch(`/data/harmonized/presets/${safeId(aoi.presetId)}.json`);
        if (!r.ok) throw new Error(`The record for this place could not load (HTTP ${r.status}).`);
        points = presetToMonthPoints(meta, await r.json() as PresetSeries); res = { exact: true, cellKm: 5, cellsInside: 0 };
      } else {
        // Never present a partial sum as a complete record: a missing tile is an error, not a zero.
        if (failed) throw new Error(`${failed} of ${want.length} data tiles for this area did not load, so its totals would be incomplete.`);
        const agg = aggregateTiles(tiles, aoi);
        points = toMonthPoints(meta, agg.months, aoiAreaKm2(aoi)); res = { exact: false, cellKm: agg.cellKm || level.cellKm, cellsInside: agg.cellsInside };
      }
      if (!cancelled) setLoaded({ aoi, points, res, tiles, overlayMissing: failed });
    })().catch((e: unknown) => { if (!cancelled) setLoadError({ aoi, message: e instanceof Error ? e.message : "Could not load this area." }); });
    return () => { cancelled = true; };
  }, [meta, aoi, attempt]);

  // ---- activity overlay for the selected range (derived, no effect) ----
  const cells = useMemo<ActivityCell[]>(() => {
    if (!current || !aoi) return [];
    const a = (Number(from.slice(0, 4)) - 2000) * 12 + Number(from.slice(5, 7)) - 1, b = (Number(to.slice(0, 4)) - 2000) * 12 + Number(to.slice(5, 7)) - 1;
    const out: ActivityCell[] = [];
    for (const tile of current.tiles) for (const c of tile.cells) {
      const [lon, lat] = cellCenter(tile, c.index);
      if (!containsPoint(aoi, lon, lat)) continue;
      let v = 0;
      for (let k = 0; k < c.months.length; k++) if (c.months[k] >= a && c.months[k] <= b) v += c.values[k * tile.fields] / 10;
      if (v > 0) out.push({ lon, lat, v, sizeKm: tile.cellKm });
    }
    return out.length > 6000 ? out.sort((x, y) => y.v - x.v).slice(0, 6000) : out;
  }, [current, aoi, from, to]);
  const overlayKm = current?.tiles[0]?.cellKm ?? null;

  // ---- URL state ----
  useEffect(() => {
    if (!meta) return;
    const q = encodeView({ aoi, presetId: aoi?.presetId, from, to, key, mode, ramp, month: selected, lang });
    window.history.replaceState(null, "", `${window.location.pathname}?${q}`);
  }, [meta, aoi, from, to, key, mode, ramp, selected, lang]);

  // ---- analytics: one baseline policy everywhere (analytics.monthAnomaly) ----
  const baseline = useMemo<[number, number]>(() => meta?.baseline ?? [2003, 2025], [meta]);
  const clim = useMemo(() => series ? climatology(series, key, baseline[0], baseline[1]) : [], [series, key, baseline]);
  const climH = useMemo(() => !series ? [] : key === "h" ? clim : climatology(series, "h", baseline[0], baseline[1]), [series, key, clim, baseline]);
  const anomalies = useMemo(() => series ? anomalyMap(series, key, baseline, clim) : new Map<string, MonthAnomaly | null>(), [series, key, baseline, clim]);
  const latest = useMemo(() => series ? latestVsMedian(series, key, baseline, clim) : null, [series, key, baseline, clim]);
  const max = useMemo(() => series ? Math.max(1, ...series.filter(p => !p.partial).map(p => (p[key] as number | null | undefined) ?? 0)) : 1, [series, key]);
  const totals = useMemo(() => series ? annualTotals(series, key) : [], [series, key]);
  const complete = useMemo(() => totals.filter(t => t.complete && t.total !== null && t.year >= baseline[0] && t.year <= baseline[1]), [totals, baseline]);
  const completeH = useMemo(() => series ? annualTotals(series, "h").filter(t => t.complete && t.total !== null && t.year >= baseline[0] && t.year <= baseline[1]) : [], [series, baseline]);
  const peakYear = completeH.reduce<typeof completeH[number] | null>((b, t) => (!b || t.total! > b.total! ? t : b), null);
  const tr = useMemo(() => trend(complete.map(t => ({ x: t.year, y: t.total! }))), [complete]);
  const season = useMemo(() => seasonRanking(climH).slice(0, 3), [climH]);
  const share = useMemo(() => seasonShare(climH, season), [climH, season]);
  const active = (climH[season[0]]?.median ?? 0) > 0;
  const recorded = useMemo(() => (series ?? []).reduce((s, p) => s + (p.h ?? 0), 0), [series]);
  const range = useMemo(() => series ? rangeSummary(series, key, from, to) : null, [series, key, from, to]);
  const top = useMemo(() => series ? topMonths(series.filter(p => p.month >= from && p.month <= to), key, 5) : [], [series, key, from, to]);
  const timing = useMemo(() => series ? seasonWindows(series, "h", climH) : null, [series, climH]);
  // Typical (median) and earliest-recent onset: when 10% of the fire year's activity had occurred.
  const onsetPlan = useMemo(() => {
    const ys = timing?.years.filter(w => w.year >= baseline[0] && w.year <= baseline[1]) ?? [];
    if (!timing || ys.length < 5) return null;
    const when = (t: number) => { const k = Math.min(11.999, Math.max(0, t)), m = (timing.startMonth + Math.floor(k)) % 12; return L.part(k - Math.floor(k), ML[m]); };
    return { typical: when(median(ys.map(w => w.onset))), earliest: when(Math.min(...ys.slice(-10).map(w => w.onset))) };
  }, [timing, baseline, L, ML]);
  const timingTrend = useMemo(() => {
    const yrs = timing?.years.filter(w => w.year >= baseline[0] && w.year <= baseline[1]) ?? [];
    return { onset: trend(yrs.map(w => ({ x: w.year, y: w.onset }))), mid: trend(yrs.map(w => ({ x: w.year, y: w.mid }))) };
  }, [timing, baseline]);
  const sel = series?.find(p => p.month === (selected ?? latest?.month));
  const selAn = sel ? anomalies.get(sel.month) ?? null : null;
  // Fire years are labelled by the calendar year in which they START (Astra 15): map the selected month to its fire year,
  // and a fire-year row to the month of that year's midpoint.
  const hlFireYear = sel && timing ? Number(sel.month.slice(0, 4)) - (Number(sel.month.slice(5, 7)) - 1 < timing.startMonth ? 1 : 0) : null;
  const selectFireYear = (y: number) => {
    if (!timing) return;
    const w = timing.years.find(x => x.year === y), k = timing.startMonth + Math.min(11, Math.floor(w?.mid ?? 6));
    setSelected(`${y + Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`);
  };
  const sources = useMemo(() => {
    const m = new Map<number, Platform | null>(), counts = new Map<number, Record<string, number>>();
    for (const p of series ?? []) { const y = Number(p.month.slice(0, 4)), c = counts.get(y) ?? {}; if (p.source) c[p.source] = (c[p.source] ?? 0) + 1; counts.set(y, c); }
    for (const [y, c] of counts) m.set(y, (Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] as Platform) ?? null);
    return m;
  }, [series]);
  const bands = useMemo(() => {
    const m = new Map<number, [number, number]>();
    if (key !== "h") return m; // uncertainty bands describe the harmonized series only
    for (const p of series ?? []) { const y = Number(p.month.slice(0, 4)), b = m.get(y) ?? [0, 0]; m.set(y, [b[0] + (p.lo ?? p.h ?? 0), b[1] + (p.hi ?? p.h ?? 0)]); }
    return m;
  }, [series, key]);
  const hlYear = sel ? Number(sel.month.slice(0, 4)) : null;
  const highlight = useMemo(() => Array.from({ length: 12 }, (_, i) => { const p = series?.find(x => x.month === `${hlYear}-${String(i + 1).padStart(2, "0")}`); return p ? ((p[key] as number | null | undefined) ?? null) : null; }), [series, hlYear, key]);
  const trendLine = tr.slopePerYear !== null && complete.length ? { slope: tr.slopePerYear, intercept: median(complete.map(t => t.total! - tr.slopePerYear! * t.year)) } : null;
  const areaKm2 = aoi ? aoiAreaKm2(aoi) : 0;
  const label = preset && aoi?.presetId === preset.id ? `${(lang === "es" && preset.nameEs) || preset.name}${preset.kind === "admin1" && preset.country ? `, ${preset.country}` : ""}` : aoi?.label ?? (lang === "es" ? "Ningún área seleccionada" : "No area selected");
  const years = meta ? Array.from({ length: Number(meta.lastMonth.slice(0, 4)) - 1999 }, (_, i) => 2000 + i) : [];
  const periodDays = Math.round((Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)), 0) - Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, 1)) / 86400000) + 1;

  const results = useMemo(() => {
    if (query.trim().length < 2) return [];
    const q = norm(query.trim()), has = new Set(meta?.presetsWithData ?? []);
    return presets.filter(p => norm(p.name).includes(q) || (p.nameEs && norm(p.nameEs).includes(q)) || norm(p.code).includes(q))
      .sort((a, b) => Number(norm(b.name).startsWith(q)) - Number(norm(a.name).startsWith(q)) || Number(has.has(b.id)) - Number(has.has(a.id)) || (a.kind === "country" ? -1 : 1))
      .slice(0, 14);
  }, [query, presets, meta]);

  function pickPoint(lat: number, lon: number) {
    const la = Math.max(-85, Math.min(85, lat));
    areaSeq.current++; setPreset(null); setOutline(null); setTab("coords");
    setCoords(c => ({ ...c, lat: String(la), lon: String(lon), radius: "150" }));
    setAoi({ kind: "circle", lat: la, lon, radiusKm: 150, label: `150 km around ${la.toFixed(2)}, ${lon.toFixed(2)}` });
    document.getElementById("atlas-layout")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function applyCoords(kind: "circle" | "bbox") {
    if (kind === "circle") {
      const lat = Number(coords.lat), lon = Number(coords.lon), r = Number(coords.radius);
      if (![lat, lon, r].every(Number.isFinite) || Math.abs(lat) > 85 || Math.abs(lon) > 180 || r < 1 || r > 2000) return notify(L.badCircle);
      areaSeq.current++; setPreset(null); setOutline(null); setAoi({ kind: "circle", lat, lon, radiusKm: r, label: `${r} km around ${lat.toFixed(2)}, ${lon.toFixed(2)}` });
    } else {
      const [w, s, e, n] = [coords.w, coords.s, coords.e, coords.n].map(Number);
      if (![w, s, e, n].every(Number.isFinite) || w >= e || s >= n || Math.abs(s) > 85 || Math.abs(n) > 85 || Math.abs(w) > 180 || Math.abs(e) > 180) return notify(L.badBox);
      areaSeq.current++; setPreset(null); setOutline(null); setAoi({ kind: "polygon", rings: [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]], label: `Box ${w}, ${s} to ${e}, ${n}` });
    }
  }
  function tabKey(e: React.KeyboardEvent, id: "place" | "draw" | "coords") {
    const order = ["place", "draw", "coords"] as const, i = order.indexOf(id);
    const next = e.key === "ArrowRight" ? order[(i + 1) % 3] : e.key === "ArrowLeft" ? order[(i + 2) % 3] : e.key === "Home" ? order[0] : e.key === "End" ? order[2] : null;
    if (!next) return;
    e.preventDefault(); document.getElementById(`atlas-tab-${next}`)?.focus(); setTab(next); if (next !== "draw") setDrawMode("none");
  }

  async function exportPng() {
    if (!series) return;
    const blob = await calendarPng({ points: series, key, mode, ramp, title: `Burning calendar · ${label}`, subtitle: `${key === "h" ? "Harmonized MODIS + VIIRS (Suomi NPP VIIRS-equivalent 5 km cell-days)" : `Raw ${key === "modis" ? "MODIS (Terra + Aqua)" : "VIIRS Suomi NPP"} cell-days, not harmonized`} · ${mode === "anomaly" ? `percentile vs the same month in other years, ${baseline[0]}–${baseline[1]}` : "activity"}`, baseline, from, to, max });
    download(`fire-watch-calendar-${safeId(label)}-${from}-to-${to}.png`, blob, "image/png"); notify(L.toastPng);
  }
  function exportCsv() {
    if (!series || !meta) return;
    download(`fire-watch-${safeId(label)}-${from}-to-${to}.csv`, calendarCsv(series, label, from, to, baseline, `NASA FIRMS MODIS C6.1 + VIIRS 375 m active fire archives (standard processing); Fire Watch harmonization built ${meta.generatedAt?.slice(0, 10) ?? ""}; unit: Suomi NPP VIIRS-equivalent 5 km cell-days`), "text/csv;charset=utf-8"); notify(L.toastCsv);
  }
  async function exportHotspots() {
    if (!aoi || busy) return;
    setBusy("hotspots");
    try {
      const hs = await fetchHotspots(aoi, info?.archive ? from : to, to);
      download(`fire-watch-hotspots-${safeId(label)}-${hs.range}.csv`, [hs.header, ...hs.lines].join("\r\n") + "\r\n" + (hs.notes.length ? `# notes: ${hs.notes.join("; ")}\r\n` : ""), "text/csv;charset=utf-8");
      notify(L.toastHs(fmt(hs.lines.length), hs.notes.length ? `${L.warning}${hs.notes.join("; ")}` : ""));
    } catch (e) { notify(e instanceof Error ? e.message : L.hsFailed); }
    finally { setBusy(""); }
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(window.location.href); notify(L.copied); } catch { notify(L.copyFallback); }
  }

  if (error && !meta) return <div className="panel atlas-empty" role="alert">{error}</div>;
  const hotspotLabel = info?.archive ? L.hsPeriod : L.hs7;
  const hotspotBlocked = !!info?.archive && periodDays > info.maxDays;

  const TX = lang === "es"
    ? { steps: "Cómo usar el atlas", s1: "Elija un lugar", s1d: "Busque, dibuje o haga clic en el mapa", s2: "Lea el calendario", s2d: "Cada casilla es un mes; más claro = más quema", s3: "Mire el presente", s3d: "¿Los últimos días están por encima de lo usual?", plan: "Consejo de planificación", read: "Cómo leer este calendario", about: "Sobre el registro", what: "¿Qué muestra esto?", files: "Qué contiene cada archivo" }
    : { steps: "How to use the atlas", s1: "Pick a place", s1d: "Search, draw, or click the world map", s2: "Read the calendar", s2d: "Each square is a month; brighter = more burning", s3: "Check right now", s3d: "Are the latest days above the usual pace?", plan: "Planning tip", read: "How to read this calendar", about: "About the record", what: "What does this show?", files: "What's in each file" };
  return <div className="atlas">
    <WorldSeasons lang={lang} onPick={pickPoint} />
    <nav className="atlas-steps" aria-label={TX.steps}>
      {([["atlas-layout", TX.s1, TX.s1d], ["atlas-calendar", TX.s2, TX.s2d], ["atlas-now", TX.s3, TX.s3d]] as const).map(([id, t, d], i) =>
        <button key={id} onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}><b>{i + 1}</b><span><strong>{t}</strong><small>{d}</small></span></button>)}
    </nav>
    <div className="atlas-layout" id="atlas-layout">
      <section className="panel atlas-controls area-place" aria-label={L.chooseArea}>
        <div className="atlas-tabs" role="tablist" aria-label={L.waysToChoose}>
          {([["place", L.tabPlace, Search], ["draw", L.tabDraw, Hexagon], ["coords", L.tabCoords, Crosshair]] as const).map(([id, t, Icon]) =>
            <button key={id} id={`atlas-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`atlas-panel-${id}`} tabIndex={tab === id ? 0 : -1} onKeyDown={e => tabKey(e, id)}
              onClick={() => { setTab(id); if (id !== "draw") setDrawMode("none"); }}><Icon size={14} />{t}</button>)}
        </div>
        {tab === "place" && <div className="atlas-tabpanel" role="tabpanel" id="atlas-panel-place" aria-labelledby="atlas-tab-place">
          <div className="atlas-search-wrap">
            <div className="atlas-search"><Search size={15} aria-hidden /><input value={query} onChange={e => setQuery(e.target.value)} placeholder={L.searchPh} aria-label={L.searchLabel} />{query && <button className="icon-button" onClick={() => setQuery("")} aria-label={L.clearSearch}><X size={13} /></button>}</div>
            {results.length > 0 && <ul className="atlas-results" role="listbox" aria-label={L.matching}>{results.map(p => <li key={p.id}><button role="option" aria-selected={preset?.id === p.id} onClick={() => void choosePreset(p)}><span>{lang === "es" && p.nameEs ? p.nameEs : p.name}{p.nameEs && p.nameEs !== p.name ? <em> · {lang === "es" ? p.name : p.nameEs}</em> : null}</span><small>{p.kind === "country" ? L.country : `${L.province} · ${p.country}`}</small></button></li>)}</ul>}
          </div>
          <div className="atlas-chips" aria-label={L.quick}>{QUICK.map(q => <button key={q.id} aria-pressed={aoi?.presetId === q.id} onClick={() => { const p = presets.find(x => x.id === q.id); if (p) void choosePreset(p); }}>{q.label}</button>)}</div>
          <p className="atlas-help">{L.placesHelp}</p>
        </div>}
        {tab === "draw" && <div className="atlas-tabpanel" role="tabpanel" id="atlas-panel-draw" aria-labelledby="atlas-tab-draw">
          <div className="atlas-tools">{([["rectangle", L.rect, Square], ["polygon", L.poly, Hexagon], ["circle", L.circle, Circle]] as const).map(([id, t, Icon]) =>
            <button key={id} aria-pressed={drawMode === id} onClick={() => setDrawMode(drawMode === id ? "none" : id)}><Icon size={16} />{t}</button>)}</div>
          <p className="atlas-help">{drawMode === "rectangle" ? L.drawRect : drawMode === "circle" ? L.drawCircle : drawMode === "polygon" ? L.drawPoly : L.drawIdle}</p>
        </div>}
        {tab === "coords" && <div className="atlas-tabpanel" role="tabpanel" id="atlas-panel-coords" aria-labelledby="atlas-tab-coords">
          <div className="atlas-fields">
            <label>{L.lat}<input inputMode="decimal" value={coords.lat} onChange={e => setCoords({ ...coords, lat: e.target.value })} /></label>
            <label>{L.lon}<input inputMode="decimal" value={coords.lon} onChange={e => setCoords({ ...coords, lon: e.target.value })} /></label>
            <label className="wide">{L.radius}<input inputMode="decimal" value={coords.radius} onChange={e => setCoords({ ...coords, radius: e.target.value })} /></label>
          </div>
          <button className="atlas-button" onClick={() => applyCoords("circle")}><MapPin size={14} />{L.usePoint}</button>
          <div className="atlas-fields">
            {(["w", "s", "e", "n"] as const).map(k => <label key={k}>{({ w: L.west, s: L.south, e: L.east, n: L.north })[k]}<input inputMode="decimal" value={coords[k]} onChange={e => setCoords({ ...coords, [k]: e.target.value })} /></label>)}
          </div>
          <button className="atlas-button secondary" onClick={() => applyCoords("bbox")}><Square size={14} />{L.useBox}</button>
        </div>}
      </section>

      <section className="panel atlas-insight area-insight" aria-live="polite" aria-busy={loading}>
        <span className="section-kicker"><Flame size={10} /> {L.kickerRecord} · {meta ? `${meta.firstMonth.slice(0, 4)}–${meta.lastMonth.slice(0, 4)}` : ""} · {L.harmonizedMV}</span>
        <h2>{label}</h2>
        {!series ? <p className="atlas-lead">{loading ? <><Loader2 size={15} className="spin" /> {L.loadingRecord}</> : areaError ? L.areaFailed : L.chooseHint}</p> : !active ? <p className="atlas-lead">{recorded >= 1 ? L.episodic(fmt(recorded), meta?.firstMonth.slice(0, 4) ?? "", top[0] && top[0].v > 0 ? monthLabel(top[0].month) : "—") : L.noBurning(meta?.firstMonth.slice(0, 4) ?? "")}</p> : <>
          <p className="atlas-lead">{L.concentrates} <strong>{seasonText(season, M).text}</strong>{share !== null ? <strong className="plain">{L.hold(Math.round(share * 100))}</strong> : null}.</p>
          <More label={TX.plan}><p className="atlas-decision">{onsetPlan ? L.onsetPlan(onsetPlan.typical, onsetPlan.earliest) : <>{L.planText1} <strong>{ML[(seasonText(season).start + 11) % 12]}</strong>{L.planText2}</>}</p></More>
        </>}
      </section>

      <section className="panel atlas-map-panel area-map" aria-label={lang === "es" ? "Mapa del área" : "Area map"}>
        <AoiMap aoi={aoi} outline={outline} drawMode={drawMode} cells={cells} fitKey={aoi?.label} ariaLabel={lang === "es" ? "Mapa del área elegida con su actividad de quemas. Para elegir un área con el teclado, use las pestañas Lugar o Coordenadas." : undefined}
          onDrawn={a => { areaSeq.current++; setPreset(null); setOutline(null); setAoi(a); setDrawMode("none"); }} onCancelDraw={() => setDrawMode("none")} />
        <div className="atlas-map-badge"><span>{fmt(areaKm2)} km² · {resolution || "…"}{loading ? " · loading" : ""}</span></div>
        {drawMode !== "none" && <div className="atlas-map-hint">{L.drawing(drawMode === "rectangle" ? L.rect : drawMode === "polygon" ? L.poly : L.circle)}</div>}
        {cells.length > 0 && overlayKm && <div className="atlas-map-legend"><span className="ramp" /><span>{L.overlay(monthLabel(from), monthLabel(to), overlayKm)}{current?.overlayMissing ? L.tilesMissing(current.overlayMissing) : ""}</span></div>}
      </section>

      <section className="panel atlas-period area-period" aria-label={L.period}>
        <h3><CalendarRange size={13} /> {L.period}</h3>
        <div className="atlas-range">
          <MonthSelect value={from} years={years} onChange={setFrom} label={L.from} names={M} words={lang === "es" ? ["mes", "año"] : ["month", "year"]} />
          <span>{L.toWord}</span>
          <MonthSelect value={to} years={years} onChange={setTo} label={L.to} names={M} words={lang === "es" ? ["mes", "año"] : ["month", "year"]} />
        </div>
        <div className="atlas-seg">{meta && [[L.fullRecord, meta.firstMonth, meta.lastMonth], [L.viirsEra, "2012-01", meta.lastMonth], [L.last5, `${Number(meta.lastMonth.slice(0, 4)) - 4}-01`, meta.lastMonth], [L.last12, lastN(meta.lastMonth, 12), meta.lastMonth]].map(([t, a, b]) =>
          <button key={t} aria-pressed={from === a && to === b} onClick={() => { setFrom(a); setTo(b); }}>{t}</button>)}</div>
        {meta && <More label={TX.about}><p className="atlas-help">{L.recordSpan(monthLabel(meta.firstMonth), monthLabel(meta.lastMonth))}</p></More>}
        {range && <p className="atlas-note">{L.inPeriod} <strong>{fmt(range.total)}</strong> {key === "h" ? L.cellDaysH : L.cellDaysR} · {fmt(range.detections)} {L.detections}{range.peakMonth ? <> · {L.peakMonth} {monthLabel(range.peakMonth)}</> : null}.</p>}
      </section>

      <section className="panel atlas-figures area-figures" aria-label={L.keyFigures}>
        <Figure label={L.latestVsUsual} value={latest?.ratioToMedian !== null && latest?.ratioToMedian !== undefined ? `${fmt(latest.ratioToMedian, 1)}×` : "—"} detail={latest ? <>{monthLabel(latest.month)} <Badge c={latest.category} L={L} /></> : L.noComplete} alert={latest?.category === "much-above"} />
        <Figure label={L.fireSeason} value={active ? seasonText(season, M).text : "—"} detail={share !== null && active ? L.ofTypicalYear(Math.round(share * 100)) : L.medians(baseline[0], baseline[1])} />
        <Figure label={L.mostActiveYear} value={peakYear ? String(peakYear.year) : "—"} detail={peakYear ? `${fmt(peakYear.total)} ${L.cellDaysH}` : L.noCompleteYear} />
        <Figure label={<>{L.trendLabel} <TrendingUp size={11} /></>} value={tr.slopePerYear !== null && complete.length ? `${fmt(tr.slopePerYear * 10 / Math.max(1e-9, mean(complete.map(t => t.total!))) * 100)}${L.perDecade}` : "—"} detail={`${L.theilSen(tr.n)}${tr.p !== null ? ` · p=${fmt(tr.p, 2)}` : ""}`} />
        {top.length > 0 && top[0].v > 0 && <div className="atlas-figure wide"><div className="label">{L.mostActiveMonths} · {monthLabel(from)}–{monthLabel(to)}</div>
          <ol className="atlas-top">{top.map((t, i) => <li key={t.month}><button aria-pressed={selected === t.month} onClick={() => setSelected(t.month)}><span>{i + 1}</span>{monthLabel(t.month)}<em>{fmt(t.v)}</em></button></li>)}</ol></div>}
      </section>

      <section className="panel atlas-cal-panel area-cal" id="atlas-calendar">
        <div className="atlas-cal-toolbar">
          <span className="section-kicker">{L.calKicker} · {key === "h" ? L.harmonizedMV : `${key === "modis" ? "MODIS" : "VIIRS S-NPP"} · ${L.rawNot}`}</span>
          <div className="atlas-cal-controls">
            <div className="atlas-seg" role="group" aria-label={L.series}>{([["h", L.harmonized], ["modis", L.modisRaw], ["snpp", L.viirsRaw]] as const).map(([k, t]) => <button key={k} aria-pressed={key === k} onClick={() => setKey(k)}>{t}</button>)}</div>
            <div className="atlas-seg" role="group" aria-label={L.colourBy}>{([["activity", L.activity], ["anomaly", L.vsUsual]] as const).map(([k, t]) => <button key={k} aria-pressed={mode === k} onClick={() => setMode(k)}>{t}</button>)}</div>
            <div className="atlas-seg" role="group" aria-label={L.view}><button aria-pressed={showValues} onClick={() => setShowValues(v => !v)}>{L.numbers}</button><button aria-pressed={showTable} onClick={() => setShowTable(v => !v)}><Table2 size={12} /> {L.table}</button></div>
          </div>
        </div>
        {(error || areaError) && <div className="notice error" role="alert">{error || areaError}{areaError && <button onClick={() => { setLoadError(null); setAttempt(a => a + 1); }}><RotateCcw size={12} /> {L.retry}</button>}</div>}
        {!series ? <div className="atlas-empty">{loading ? <><Loader2 size={16} className="spin" /> {L.loadingRecord}</> : L.chooseHint}</div> : <>
          <Legend mode={mode} ramp={ramp} max={max} baseline={baseline} raw={key !== "h"} onRamp={setRamp} L={L} />
          {showTable ? <ValueTable points={series} keyName={key} from={from} to={to} anomalies={anomalies} L={L} fmt={fmt} /> :
            <BurnCalendar points={series} seriesKey={key} mode={mode} ramp={ramp} anomalies={anomalies} max={max} from={from} to={to} selected={selected ?? latest?.month ?? null} onSelect={setSelected} showValues={showValues} caption={`${L.calKicker}: ${label}`} lang={lang} />}
          <More label={TX.read}><p className="atlas-note">{key === "h" ? L.calNoteH : L.calNoteR} {L.calNoteDefs}</p></More>
        </>}
      </section>
    </div>

    {series && <>
      {aoi && meta && <RecentPanel aoi={aoi} meta={meta} clim={climH} label={label} baseline={baseline} lang={lang} />}

      <div className="atlas-detail">
        <section className="panel atlas-month" aria-live="polite">
          <span className="section-kicker">{L.selectedMonth}</span>
          {sel ? <>
            <h2>{monthLabel(sel.month)}</h2><p className="atlas-note">{label}</p>
            <div className="big">{fmt(sel[key] as number | null, 1)}</div>
            <p className="atlas-note">{key === "h" ? <>{L.unitH}{sel.lo !== null && sel.lo !== undefined && sel.hi !== sel.lo ? <> · {L.uncertainty} {fmt(sel.lo, 1)}–{fmt(sel.hi, 1)}</> : null}</> : L.unitR}</p>
            {selAn && <p className="atlas-compare"><Badge c={selAn.category} L={L} /> {selAn.partial ? L.partialNote : selAn.ratioToMedian !== null ? `${L.vsOther(fmt(selAn.ratioToMedian, 2), ML[Number(sel.month.slice(5, 7)) - 1], baseline[0], baseline[1])}${selAn.percentileRank !== null && selAn.category !== "unknown" ? L.pctile(Math.round(selAn.percentileRank)) : ""}${selAn.ratioToMean !== null ? L.vsMean(fmt(selAn.ratioToMean, 2)) : ""}` : L.noMedian}</p>}
            <dl>
              <dt>{L.dataSource}</dt><dd>{sel.source ? <><span className="sw" style={{ background: SOURCE_COLORS[sel.source] }} />{SL[sel.source]}</> : "—"}</dd>
              <dt>{L.rawModis}</dt><dd>{fmt(sel.modis)} {L.cellDays}</dd>
              <dt>{L.rawSnpp}</dt><dd>{sel.snpp === null || sel.snpp === undefined ? L.notOperating : `${fmt(sel.snpp)} ${L.cellDays}`}</dd>
              <dt>{L.rawN20}</dt><dd>{sel.noaa20 === null || sel.noaa20 === undefined ? L.notOperating : `${fmt(sel.noaa20)} ${L.cellDays}`}</dd>
              <dt>{L.hotspotDet}</dt><dd>{fmt(sel.detections)} {L.allSats}</dd>
              <dt>{L.coverage}</dt><dd>{sel.coveredDays !== undefined && sel.days ? L.daysOf(sel.coveredDays, sel.days) : sel.partial ? L.partial : L.complete}{sel.partial ? L.outage : ""}{sel.provisional ? L.provisionalW : ""}</dd>
            </dl>
            {(() => { // 3D view of the busiest fire day of this month (VIIRS era, areas small enough to search for one fire)
              const b = aoi ? aoiBounds(aoi) : null, ok = !!b && sel.month >= "2012-02" && (sel.detections ?? 0) > 0 && (b.east - b.west) * (b.north - b.south) <= 200, es = lang === "es" ? "&lang=es" : "";
              const href = ok && b ? `/scene?month=${sel.month}&west=${b.west.toFixed(3)}&south=${b.south.toFixed(3)}&east=${b.east.toFixed(3)}&north=${b.north.toFixed(3)}&name=${encodeURIComponent(`${label} · ${monthLabel(sel.month)}`)}${es}` : `/scene?demo=cordoba${es}`;
              return <p className="atlas-scene-link"><a className="atlas-button secondary" href={href}><Box size={14} />{ok ? L.see3d : L.see3dExample}</a><span className="atlas-note">{L.see3dNote}</span></p>;
            })()}
          </> : <p className="atlas-note">{L.selectCell}</p>}
        </section>
        <section className="panel atlas-chart"><span className="section-kicker">{L.seasonal}</span>
          <SeasonalChart lang={lang} clim={clim} highlight={highlight} highlightYear={hlYear} title={`Seasonal profile for ${label}: median and 10th–90th percentile by month, ${baseline[0]}–${baseline[1]}, with ${hlYear}`} /></section>
      </div>

      <div className="atlas-grid2">
        <section className="panel atlas-chart"><span className="section-kicker">{L.annual}</span>
          <AnnualChart totals={totals} sources={sources} bands={bands} trendLine={key === "h" ? trendLine : null} title={`Annual totals for ${label}`} selectedYear={hlYear} onSelectYear={y => setSelected(`${y}-${(selected ?? latest?.month ?? "2000-08").slice(5, 7)}`)} />
          <div className="atlas-cal-foot">{(Object.keys(SOURCE_COLORS) as Platform[]).map(p => <span key={p}><span className="sw" style={{ background: SOURCE_COLORS[p] }} />{SL[p]}</span>)}{key === "h" && <span>{L.whiskers}</span>}</div></section>
        <section className="panel atlas-chart"><span className="section-kicker">{L.timing}</span>
          {timing && <SeasonTimingChart lang={lang} windows={timing.years} startMonth={timing.startMonth} selectedYear={hlFireYear} onSelectYear={selectFireYear} title={`Fire-season window by year for ${label}: months in which 10%, 50% and 90% of each fire year's harmonized activity had occurred`} />}
          {timing && timing.years.length >= 5 && <More label={TX.what}><p className="atlas-note">{L.timingNote(M[timing.startMonth], M[(timing.startMonth + 11) % 12])} {timingTrend.onset.slopePerYear !== null ? <><strong>{L.onsetMoved(Math.round(Math.abs(timingTrend.onset.slopePerYear * 304.4)), timingTrend.onset.slopePerYear < 0)}</strong> (Theil–Sen, Mann–Kendall p={fmt(timingTrend.onset.p, 2)}){timingTrend.onset.p !== null && timingTrend.onset.p >= 0.05 ? L.notSig : ""}; {timingTrend.mid.slopePerYear !== null ? L.midMoved(Math.round(Math.abs(timingTrend.mid.slopePerYear * 304.4)), timingTrend.mid.slopePerYear < 0) : L.midNone}.</> : null}</p></More>}
        </section>
      </div>

      <div className="atlas-grid1">
        <section className="panel atlas-exports"><span className="section-kicker">{L.downloads} · {monthLabel(from).toUpperCase()}–{monthLabel(to).toUpperCase()}</span>
          <div className="atlas-export-row">
            <button className="atlas-button" onClick={exportCsv}><ArrowDownToLine size={14} />{L.calCsv}</button>
            <button className="atlas-button secondary" onClick={() => void exportPng()}><ImageIcon size={14} />{L.calImg}</button>
            <button className="atlas-button secondary" onClick={() => void exportHotspots()} disabled={!!busy || hotspotBlocked} aria-describedby="hotspot-note">{busy ? <Loader2 size={14} className="spin" /> : <ArrowDownToLine size={14} />}{hotspotLabel}</button>
            <button className="atlas-button secondary" onClick={() => void copyLink()}><Link2 size={14} />{L.share}</button>
          </div>
          <More label={TX.files}><p className="atlas-note"><strong>{L.calCsv} / {L.calImg}:</strong> {L.csvNote(baseline[0], baseline[1])}</p>
          <p className="atlas-note" id="hotspot-note"><strong>{L.hs7.split(" · ")[0]}:</strong> {info?.archive ? <>{L.hsNoteKey(info.maxDays)}{hotspotBlocked ? <> — <em>{L.hsNarrow(info.maxDays)}</em></> : null}.</> : L.hsNoteNoKey}</p></More>
        </section>
      </div>

      {key === "h" && <section className="panel atlas-chart"><span className="section-kicker">{L.whyKicker}</span>
        <SensorChart lang={lang} points={series} title={`Raw MODIS, raw VIIRS and harmonized monthly activity for ${label}`} start="2008-01" />
        <More label={TX.what}><p className="atlas-note">{L.whyNote}</p></More></section>}
    </>}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>;
}

function Figure({ label, value, detail, alert }: { label: React.ReactNode; value: string; detail: React.ReactNode; alert?: boolean }) {
  return <div className={`atlas-figure ${alert ? "alert" : ""}`}><div className="label">{label}</div><div className="value">{value}</div><div className="detail">{detail}</div></div>;
}
function Legend({ mode, ramp, max, baseline, raw, onRamp, L }: { mode: ColorMode; ramp: RampName; max: number; baseline: [number, number]; raw: boolean; onRamp: (r: RampName) => void; L: Strings }) {
  const ticks = activityTicks(max);
  const grad = mode === "activity"
    ? Array.from({ length: 11 }, (_, k) => sequentialColor(Math.expm1(Math.max(0.0001, k / 10) * Math.log1p(Math.max(1, max))), max, ramp)).join(",")
    : Array.from({ length: 11 }, (_, k) => anomalyColor(k * 10)).join(",");
  return <div className="atlas-legend2">
    <div className="lg-scale">
      <span className="lg-title">{mode === "activity" ? L.legendAct(raw) : L.legendAn(baseline[0], baseline[1])}</span>
      <div className="lg-bar"><span className="ramp" style={{ background: `linear-gradient(90deg,${grad})` }} />
        {mode === "activity" ? ticks.map(t => <span key={t.v} className="tick" style={{ left: `${t.t * 100}%` }}>{tick(t.v)}</span>)
          : ([[10, L.muchBelow], [50, L.typical], [90, L.muchAbove]] as const).map(([q, t]) => <span key={q} className="tick" style={{ left: `${q}%` }}>{t}</span>)}</div>
    </div>
    {mode === "activity" && <div className="atlas-seg lg-ramps" role="group" aria-label={L.ramp}>{([["cividis", "Cividis"], ["viridis", "Viridis"], ["inferno", "Inferno"]] as const).map(([k, t]) => <button key={k} aria-pressed={ramp === k} onClick={() => onRamp(k)}>{t}</button>)}</div>}
    <div className="lg-keys">
      {mode === "activity" ? <span><i style={{ background: "var(--atlas-zero)" }} />{L.zeroDet}</span> : <span><i style={{ background: "var(--atlas-missing)" }} />{L.notCompared}</span>}
      <span><i className="hatch" />{L.noRecord}</span><span><i className="corner" />{L.partialMonth}</span><span><i className="dot" />{L.provisional}</span>
    </div>
  </div>;
}
function MonthSelect({ value, years, onChange, label, names, words }: { value: string; years: number[]; onChange: (v: string) => void; label: string; names: readonly string[]; words: [string, string] }) {
  return <div className="atlas-month-select" role="group" aria-label={label}>
    <select aria-label={`${label}: ${words[0]}`} value={value.slice(5, 7)} onChange={e => onChange(`${value.slice(0, 4)}-${e.target.value}`)}>{names.map((m, i) => <option key={m} value={String(i + 1).padStart(2, "0")}>{m}</option>)}</select>
    <select aria-label={`${label}: ${words[1]}`} value={value.slice(0, 4)} onChange={e => onChange(`${e.target.value}-${value.slice(5, 7)}`)}>{years.map(y => <option key={y} value={y}>{y}</option>)}</select>
  </div>;
}
function Badge({ c, L }: { c: string; L: Strings }) {
  return <span className={`badge ${c}`}>{L.badge[c] ?? c}</span>;
}
function ValueTable({ points, keyName, from, to, anomalies, L, fmt }: { points: MonthPoint[]; keyName: SeriesKey; from: string; to: string; anomalies: Map<string, MonthAnomaly | null>; L: Strings; fmt: (n: number | null | undefined, d?: number) => string }) {
  const rows = points.filter(p => p.month >= from && p.month <= to).reverse();
  return <div className="atlas-table-wrap" tabIndex={0} role="region" aria-label={L.tableMonths(rows.length)}><table className="atlas-table"><caption className="sr-only">{L.tableCaption}</caption>
    <thead><tr><th scope="col">{L.thMonth}</th><th scope="col">{keyName === "h" ? L.harmonized : L.modisRaw.split(" ")[1] ?? "Raw"}</th>{keyName === "h" && <><th scope="col">{L.thLow}</th><th scope="col">{L.thHigh}</th></>}<th scope="col">{L.thVs}</th><th scope="col">{L.modisRaw}</th><th scope="col">{L.viirsRaw}</th><th scope="col">{L.thSource}</th><th scope="col">{L.thFlags}</th></tr></thead>
    <tbody>{rows.map(p => { const a = anomalies.get(p.month); return <tr key={p.month}><td>{p.month}</td><td>{fmt(p[keyName] as number | null, 1)}</td>{keyName === "h" && <><td>{fmt(p.lo, 1)}</td><td>{fmt(p.hi, 1)}</td></>}<td>{a && a.ratioToMedian !== null ? `${fmt(a.ratioToMedian, 2)}×` : "—"}</td><td>{fmt(p.modis)}</td><td>{fmt(p.snpp)}</td><td>{p.source ?? "—"}</td><td>{[p.partial && L.partialMonth, p.provisional && L.provisional].filter(Boolean).join(", ")}</td></tr>; })}</tbody></table></div>;
}
function lastN(month: string, n: number) { const i = (Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1) - (n - 1); return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`; }
function median(v: number[]) { const s = [...v].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; }
function mean(v: number[]) { return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; }
