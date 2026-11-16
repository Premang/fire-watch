"use client";

import { useEffect, useMemo, useState } from "react";
import FireMap, { type FireBounds } from "./fire-map";
import type { FirePoint, Sensor } from "@/lib/fire-analysis";

type ReplayArchive = {
  meta: {
    title: string;
    start: string;
    end: string;
    bounds: [number, number, number, number];
    note: string;
    provenance: Array<{ sensor: Sensor; source: string; year: number }>;
  };
  points: FirePoint[];
};

type ReplayDay = { date: string; points: FirePoint[]; cells: Set<string> };
const DAY_MS = 86400000;
const EARTH_KM = 6371;
const COS_30 = Math.cos(Math.PI / 6);
const CELL_KM = 5;

// Same 25 km² cylindrical equal-area cells as lib/fire-analysis.ts.
// Sensors are evaluated separately; repeated detections occupy one cell.
function cellKey(point: FirePoint): string {
  const x = EARTH_KM * point.lon * Math.PI / 180 * COS_30;
  const y = EARTH_KM * Math.sin(point.lat * Math.PI / 180) / COS_30;
  return `${Math.floor(x / CELL_KM)}:${Math.floor(y / CELL_KM)}`;
}

function cellGeometry(cells: Set<string>) {
  const lon = (x: number) => x * CELL_KM / (EARTH_KM * COS_30) * 180 / Math.PI;
  const lat = (y: number) => Math.asin(Math.max(-1, Math.min(1, y * CELL_KM * COS_30 / EARTH_KM))) * 180 / Math.PI;
  return {
    type: "FeatureCollection",
    features: [...cells].map((key) => {
      const [x, y] = key.split(":").map(Number);
      return {
        type: "Feature",
        properties: { cell: key },
        geometry: {
          type: "Polygon",
          coordinates: [[[lon(x), lat(y)], [lon(x + 1), lat(y)], [lon(x + 1), lat(y + 1)], [lon(x), lat(y + 1)], [lon(x), lat(y)]]],
        },
      };
    }),
  };
}

function dateLabel(date: string, short = false): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC", month: short ? "short" : "long", day: "numeric", ...(short ? {} : { year: "numeric" }),
  });
}

const percent = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(1)}%`;

export default function ReplayPanel() {
  const [archive, setArchive] = useState<ReplayArchive | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sensor, setSensor] = useState<Sensor>("VIIRS");
  const [index, setIndex] = useState(23);
  const [playing, setPlaying] = useState(false);
  const [satellite, setSatellite] = useState(false);
  const [showBaseline, setShowBaseline] = useState(true);
  const [selectedPoint, setSelectedPoint] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/data/dixie-replay.json", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("The archived observations are currently unavailable.");
        const payload: ReplayArchive = await response.json();
        if (!payload.meta || !Array.isArray(payload.points) || !Array.isArray(payload.meta.bounds) || payload.meta.bounds.length !== 4) {
          throw new Error("The replay archive could not be read.");
        }
        if (!controller.signal.aborted) setArchive(payload);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "The replay could not be loaded.");
      });
    return () => controller.abort();
  }, [attempt]);

  const days = useMemo<ReplayDay[]>(() => {
    if (!archive) return [];
    const start = Date.parse(archive.meta.start.slice(0, 10) + "T00:00:00Z");
    const end = Date.parse(archive.meta.end.slice(0, 10) + "T00:00:00Z");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
    const count = Math.min(50, Math.floor((end - start) / DAY_MS) + 1);
    const byDate = new Map<string, FirePoint[]>();
    archive.points.forEach((point) => {
      if (point.sensor !== sensor) return;
      const date = point.acquiredAt.slice(0, 10);
      const existing = byDate.get(date);
      if (existing) existing.push(point);
      else byDate.set(date, [point]);
    });
    return Array.from({ length: count }, (_, offset) => {
      const date = new Date(start + offset * DAY_MS).toISOString().slice(0, 10);
      const points = byDate.get(date) ?? [];
      return { date, points, cells: new Set(points.map(cellKey)) };
    });
  }, [archive, sensor]);

  const currentIndex = Math.min(index, Math.max(0, days.length - 1));
  const today = days[currentIndex];
  const yesterday = days[currentIndex - 1];
  const bounds = useMemo<FireBounds | undefined>(() => archive ? {
    west: archive.meta.bounds[0], south: archive.meta.bounds[1],
    east: archive.meta.bounds[2], north: archive.meta.bounds[3],
  } : undefined, [archive]);
  const predictedGeometry = useMemo(() => yesterday && showBaseline ? cellGeometry(yesterday.cells) : undefined, [yesterday, showBaseline]);
  const maximumCount = useMemo(() => Math.max(1, ...days.map((day) => day.points.length)), [days]);
  const scores = useMemo(() => {
    // Empty detection days are not evidence of an observed fire-free day.
    if (!today?.cells.size || !yesterday?.cells.size) return null;
    const hits = [...yesterday.cells].filter((key) => today.cells.has(key)).length;
    const union = new Set([...yesterday.cells, ...today.cells]).size;
    return {
      hits, predicted: yesterday.cells.size, observed: today.cells.size,
      precision: hits / yesterday.cells.size, recall: hits / today.cells.size,
      iou: hits / union, newCells: today.cells.size - hits,
    };
  }, [today, yesterday]);

  useEffect(() => {
    if (!playing || days.length < 2) return;
    const timer = window.setTimeout(() => {
      const next = currentIndex + 1;
      if (next < days.length) setIndex(next);
      if (next >= days.length - 1) setPlaying(false);
    }, 1300);
    return () => window.clearTimeout(timer);
  }, [playing, currentIndex, days.length]);

  function goTo(next: number) {
    setPlaying(false);
    setSelectedPoint(null);
    setIndex(Math.max(0, Math.min(days.length - 1, next)));
  }

  if (error) return <div className="replay-message" role="alert" style={{ padding: 36, border: "1px solid #37454d", borderRadius: 12, background: "#111d24", color: "#dce4e7" }}>
    <p>{error}</p>
    <button type="button" onClick={() => { setError(null); setAttempt((value) => value + 1); }} style={{ marginTop: 12, padding: "8px 14px", border: "1px solid #a47750", borderRadius: 6, color: "#efbc83", background: "#263038", cursor: "pointer" }}>Retry archive</button>
  </div>;

  if (!archive || !today) return <div role="status" style={{ padding: 48, minHeight: 300, display: "grid", placeItems: "center", color: "#a5b5be", background: "#111d24", borderRadius: 12 }}>Loading the 2021 observation archive…</div>;

  return <section className="replay-panel" aria-label="Dixie-area activity replay">
    <header className="replay-header">
      <div>
        <div className="replay-eyebrow"><span /> RETROSPECTIVE LAB <span className="replay-year">2021 ARCHIVE</span></div>
        <h2>Dixie-area activity</h2>
        <p>Replay the observations. Put a simple prediction to the test.</p>
      </div>
      <div className="replay-sensor-control" aria-label="Replay sensor">
        {(["VIIRS", "MODIS"] as const).map((item) => <button key={item} type="button" aria-pressed={sensor === item} className={sensor === item ? "is-active" : ""} onClick={() => { setSensor(item); setPlaying(false); setSelectedPoint(null); }}>{item}</button>)}
      </div>
    </header>

    <div className="replay-layout">
      <div className="replay-main">
        <div className="replay-map-wrap">
          <FireMap points={today.points} bounds={bounds} satellite={satellite} selectedBoundary={predictedGeometry} selectedId={selectedPoint} onSelectPoint={(point) => setSelectedPoint(point.id)} />
          <div className="replay-map-label"><span className="replay-map-dot" /> NORTHERN CALIFORNIA <small>{sensor === "VIIRS" ? "Suomi NPP · 375 m detections" : "Terra + Aqua · 1 km detections"}</small></div>
          <button className="replay-basemap" type="button" aria-pressed={satellite} onClick={() => setSatellite((value) => !value)}>{satellite ? "Dark basemap" : "Satellite basemap"}</button>
          {satellite && <div className="replay-imagery-note">Reference imagery · not from the replay date</div>}
        </div>
        <div className="replay-map-legend">
          <span><i className={sensor === "MODIS" ? "replay-legend-modis" : "replay-legend-observed"} /> Observed detections</span>
          <label><input type="checkbox" checked={showBaseline} onChange={(event) => setShowBaseline(event.target.checked)} /><i className="replay-legend-grid" /> Prior-day occupied cells</label>
          <span className="replay-utc">All dates UTC</span>
        </div>

        <div className="replay-timeline">
          <div className="replay-date-row">
            <div className="replay-play-controls">
              <button type="button" className="replay-arrow" aria-label="Previous day" disabled={currentIndex === 0} onClick={() => goTo(currentIndex - 1)}>‹</button>
              <button type="button" className="replay-play" aria-label={playing ? "Pause replay" : "Play replay"} onClick={() => {
                if (!playing && currentIndex === days.length - 1) setIndex(0);
                setPlaying((value) => !value);
              }}>{playing ? "Ⅱ" : "▶"}</button>
              <button type="button" className="replay-arrow" aria-label="Next day" disabled={currentIndex === days.length - 1} onClick={() => goTo(currentIndex + 1)}>›</button>
            </div>
            <div className="replay-current-date"><strong>{dateLabel(today.date)}</strong><span>Day {currentIndex + 1} of {days.length}</span></div>
            <div className="replay-day-count"><strong>{today.points.length.toLocaleString()}</strong><span>{sensor} detections</span></div>
          </div>
          <div className="replay-bars" aria-label="Daily detection counts">
            {days.map((day, dayIndex) => <button key={day.date} type="button" className={`replay-bar ${dayIndex === currentIndex ? "is-selected" : ""} ${dayIndex > currentIndex ? "is-future" : ""}`} aria-label={`${dateLabel(day.date)}: ${day.points.length.toLocaleString()} detections`} aria-current={dayIndex === currentIndex ? "date" : undefined} title={`${dateLabel(day.date, true)} · ${day.points.length.toLocaleString()} detections`} onClick={() => goTo(dayIndex)}><span style={{ height: `${Math.max(4, day.points.length / maximumCount * 100)}%` }} /></button>)}
          </div>
          <input type="range" className="replay-range" min={0} max={days.length - 1} step={1} value={currentIndex} onChange={(event) => goTo(Number(event.target.value))} aria-label="Replay date" aria-valuetext={dateLabel(today.date)} />
          <div className="replay-range-labels"><span>{dateLabel(days[0].date, true)}</span><span>Daily observations, not fire area</span><span>{dateLabel(days[days.length - 1].date, true)}</span></div>
        </div>
      </div>

      <aside className="replay-benchmark">
        <div className="replay-benchmark-top"><span className="replay-eyebrow">BASELINE EXPERIMENT</span><span className="replay-benchmark-badge">No training</span></div>
        <h3>Does yesterday<br />predict today?</h3>
        <p className="replay-benchmark-intro">Assume every cell with a detection yesterday will have one again today. Then compare with today’s observed cells.</p>
        <div className="replay-comparison-date"><span>{yesterday ? dateLabel(yesterday.date, true) : "No prior day"}</span><span>→</span><strong>{dateLabel(today.date, true)}</strong></div>
        <div className="replay-cell-stats">
          <div><strong>{yesterday?.cells.size ?? "—"}</strong><span>Predicted cells</span></div>
          <div><strong>{today.cells.size}</strong><span>Detected today</span></div>
        </div>
        <div className="replay-metrics">
          {[
            { label: "Precision", value: scores?.precision ?? null, detail: "Repeated detections / predicted cells" },
            { label: "Recall", value: scores?.recall ?? null, detail: "Repeated detections / observed cells" },
            { label: "Intersection over union", value: scores?.iou ?? null, detail: "Shared cells / all cells in either day" },
          ].map((metric) => <div className="replay-metric" key={metric.label}>
            <div><span>{metric.label}</span><strong>{percent(metric.value)}</strong></div>
            <div className="replay-meter"><span style={{ width: `${(metric.value ?? 0) * 100}%` }} /></div>
            <small>{metric.detail}</small>
          </div>)}
        </div>
        <div className="replay-insight">{scores ? <><strong>{scores.newCells} newly detected {scores.newCells === 1 ? "cell" : "cells"}</strong><span>{scores.hits} of {scores.observed} observed cells repeated yesterday’s detections. The rest are missed by this baseline.</span></> : <><strong>Not enough observed activity to score</strong><span>Both consecutive days need detections. An empty record does not establish that there was no fire.</span></>}</div>
        <div className="replay-limit"><span aria-hidden="true">ⓘ</span><p>Persistence benchmark, not a spread forecast. Scores describe recorded detections, not the true fire front. No crew deployment guidance.</p></div>
      </aside>
    </div>

    <details className="replay-methods">
      <summary>Data, grid & interpretation <span>View methodology + sources</span></summary>
      <div className="replay-method-content">
        <p><strong>Actual archive.</strong> {archive.meta.note} This view uses daily {sensor === "VIIRS" ? "VIIRS Suomi NPP" : "MODIS Terra and Aqua"} records. A detection can be much smaller than its sensor pixel.</p>
        <p><strong>One-day persistence.</strong> The prediction for the selected date is exactly the prior UTC day’s occupied cells; no observations from the target date enter the prediction. Repeated observations are merged within each day. Cells use the same 5 km cylindrical equal-area grid as the calendar (25 km² cells; their geographic shape varies with latitude).</p>
        <p><strong>How to read scores.</strong> Precision is shared cells divided by prior-day cells. Recall is shared cells divided by today’s cells. Intersection over union is shared cells divided by their union. Cloud, overpass timing and sensor sensitivity affect all three. These are retrospective detection-set comparisons, not validated operational forecast scores; missing observations are not verified zeros.</p>
        <div className="replay-source-links">{archive.meta.provenance.filter((item) => item.source.startsWith("https://firms.modaps.eosdis.nasa.gov/")).map((item) => <a href={item.source} key={item.sensor} target="_blank" rel="noopener noreferrer">NASA FIRMS · {item.sensor} {item.year} archive ↗</a>)}</div>
      </div>
    </details>

    <style>{`
      .replay-panel { color: var(--text, #e7edf0); font-family: inherit; }
      .replay-panel button, .replay-panel input { font: inherit; }
      .replay-header { display:flex; align-items:center; justify-content:space-between; gap:24px; margin-bottom:24px; }
      .replay-eyebrow { display:flex; align-items:center; gap:8px; font-size:10px; font-weight:650; letter-spacing:1.65px; color:#a3b4bd; }
      .replay-eyebrow > span:first-child:not(.replay-year) { width:5px; height:5px; border-radius:50%; background:#e5ae73; }
      .replay-year { margin-left:4px; letter-spacing:1px; color:#c0a17d; background:#cf9c5210; padding:4px 7px; border:1px solid #b88f532c; border-radius:4px; font-size:9px; }
      .replay-header h2 { font-size:29px; font-weight:500; letter-spacing:-.9px; margin:13px 0 5px; line-height:1.15; }
      .replay-header p { margin:0; color:var(--muted-text, #94a6b1); font-size:13px; }
      .replay-sensor-control { display:flex; padding:4px; border:1px solid #35444d; border-radius:7px; background:#101b22; }
      .replay-sensor-control button { padding:7px 15px; border:0; border-radius:4px; background:transparent; color:#94a6b1; font-size:11px; font-weight:600; letter-spacing:.5px; cursor:pointer; }
      .replay-sensor-control button.is-active { color:#f2ca9d; background:#bb844f24; box-shadow:inset 0 0 0 1px #d6a57435; }
      .replay-layout { display:grid; grid-template-columns:minmax(0,1fr) 300px; border:1px solid #34434b; border-radius:10px; overflow:hidden; background:var(--panel, #101c23); }
      .replay-main { min-width:0; }
      .replay-map-wrap { height:420px; position:relative; }
      .replay-map-label { position:absolute; left:18px; top:18px; z-index:500; background:#122029ed; border:1px solid #53657164; border-radius:6px; padding:10px 13px; color:#ced8dc; font-size:9px; letter-spacing:1.15px; font-weight:600; pointer-events:none; box-shadow:0 4px 15px #0002; }
      .replay-map-dot { display:inline-block; width:5px; height:5px; border-radius:50%; margin-right:6px; background:#edaa73; vertical-align:1px; }
      .replay-map-label small { display:block; font-size:9px; font-weight:400; letter-spacing:0; color:#8ea3af; margin-top:4px; }
      .replay-basemap { position:absolute; top:18px; right:18px; z-index:500; padding:9px 11px; border:1px solid #53657164; border-radius:6px; background:#122029ed; color:#b9c8d0; font-size:10px!important; cursor:pointer; }
      .replay-basemap:hover { color:#fff; background:#23343e; }
      .replay-imagery-note { position:absolute; top:62px; right:18px; z-index:500; background:#122029ed; color:#b9c8d0; font-size:9px; padding:6px 8px; border-radius:4px; }
      .replay-map-legend { display:flex; align-items:center; flex-wrap:wrap; gap:16px; padding:11px 18px; background:#142129; border-top:1px solid #34434b; border-bottom:1px solid #34434b; color:#9db0bc; font-size:10px; }
      .replay-map-legend > span,.replay-map-legend label { display:flex; align-items:center; gap:7px; }
      .replay-map-legend label { cursor:pointer; }
      .replay-map-legend input { width:12px; height:12px; accent-color:#d1a16c; margin:0; }
      .replay-map-legend i { width:6px; height:6px; display:inline-block; border-radius:50%; }
      .replay-map-legend .replay-legend-observed { background:#ff814a; box-shadow:0 0 7px #fb7a4359; }
      .replay-map-legend .replay-legend-modis { background:#f3c66a; }
      .replay-map-legend .replay-legend-grid { width:9px; height:9px; border:1px dashed #e1b572; border-radius:0; background:#e1b57214; }
      .replay-map-legend .replay-utc { margin-left:auto; font-size:9px; color:#728994; }
      .replay-timeline { padding:21px 22px 18px; }
      .replay-date-row { display:flex; align-items:center; gap:14px; }
      .replay-play-controls { display:flex; align-items:center; gap:5px; }
      .replay-arrow { background:transparent; color:#a5b7c0; border:0; font-size:26px!important; width:24px; cursor:pointer; padding:0; }
      .replay-arrow:disabled { opacity:.25; cursor:default; }
      .replay-play { display:grid; place-items:center; width:34px; height:34px; padding:0; color:#20272b; background:#d4a372; border:1px solid #e5b886; border-radius:50%; font-size:12px!important; cursor:pointer; }
      .replay-play:hover { background:#ebbf91; }
      .replay-current-date strong { display:block; font-size:14px; font-weight:500; }
      .replay-current-date > span { display:block; color:#7f96a3; font-size:10px; margin-top:3px; }
      .replay-day-count { margin-left:auto; text-align:right; }
      .replay-day-count strong { display:block; font-size:20px; font-weight:500; font-variant-numeric:tabular-nums; }
      .replay-day-count > span { font-size:9px; color:#829aa7; }
      .replay-bars { height:53px; display:flex; align-items:end; gap:3px; margin-top:23px; }
      .replay-bar { flex:1; min-width:0; height:100%; display:flex; align-items:end; padding:0; border:0; background:transparent; cursor:pointer; }
      .replay-bar > span { display:block; width:100%; background:#627a87; border-radius:2px 2px 0 0; opacity:.65; transition:background .15s,opacity .15s; }
      .replay-bar.is-future > span { opacity:.3; }
      .replay-bar.is-selected > span { background:#e5a16c; opacity:1; }
      .replay-bar:hover > span { background:#efbd91; opacity:1; }
      .replay-range { appearance:none; width:100%; height:3px; background:#354852; border-radius:4px; accent-color:#dda672; margin:12px 0 10px; cursor:pointer; }
      .replay-range::-webkit-slider-thumb { appearance:none; width:11px; height:11px; border:2px solid #f4d1ad; background:#ca9765; border-radius:50%; box-shadow:0 0 0 4px #d3a06d16; }
      .replay-range::-moz-range-thumb { width:9px; height:9px; border:2px solid #f4d1ad; background:#ca9765; border-radius:50%; }
      .replay-range-labels { display:flex; justify-content:space-between; color:#7f96a3; font-size:9px; }
      .replay-range-labels span:nth-child(2) { color:#607c8c; }
      .replay-benchmark { border-left:1px solid #34434b; padding:24px 22px; background:#142129; }
      .replay-benchmark-top { display:flex; justify-content:space-between; align-items:center; gap:7px; }
      .replay-benchmark-top .replay-eyebrow { font-size:8px; letter-spacing:1.2px; }
      .replay-benchmark-badge { padding:3px 6px; border:1px solid #42606b; border-radius:4px; font-size:8px; color:#94b8bb; white-space:nowrap; }
      .replay-benchmark h3 { margin:19px 0 10px; font-size:25px; line-height:1.14; letter-spacing:-.65px; font-weight:500; }
      .replay-benchmark-intro { color:#8fa6b3; font-size:11px; line-height:1.7; margin:0; }
      .replay-comparison-date { display:flex; align-items:center; justify-content:center; gap:20px; padding:11px; margin:19px 0; border:1px solid #354853; border-radius:5px; background:#101b22; font-size:11px; color:#96aebb; }
      .replay-comparison-date > strong { font-weight:500; color:#e6bf97; }
      .replay-comparison-date > span:nth-child(2) { color:#52717f; }
      .replay-cell-stats { display:grid; grid-template-columns:1fr 1fr; gap:15px; margin-bottom:23px; }
      .replay-cell-stats > div + div { border-left:1px solid #354853; padding-left:18px; }
      .replay-cell-stats strong { display:block; font-size:26px; font-weight:500; line-height:1; font-variant-numeric:tabular-nums; }
      .replay-cell-stats span { display:block; margin-top:7px; color:#829ca9; font-size:9px; }
      .replay-metrics { display:flex; flex-direction:column; gap:17px; }
      .replay-metric > div:first-child { display:flex; justify-content:space-between; align-items:baseline; gap:8px; font-size:11px; color:#b6c5cd; }
      .replay-metric strong { font-size:17px; font-weight:500; color:#e9bf96; font-variant-numeric:tabular-nums; }
      .replay-meter { height:3px; background:#2a3f4a; border-radius:5px; margin:6px 0; overflow:hidden; }
      .replay-meter > span { display:block; height:100%; background:#c79c71; transition:width .3s; }
      .replay-metric small { color:#6f8b9a; font-size:8px; line-height:1.4; }
      .replay-insight { margin-top:20px; background:#1c3038; border-left:2px solid #7ba5a6; padding:11px 12px; }
      .replay-insight strong { display:block; color:#b9d4d2; font-size:11px; font-weight:500; }
      .replay-insight span { display:block; color:#8aa6b0; font-size:10px; line-height:1.6; margin-top:4px; }
      .replay-limit { margin-top:19px; display:flex; gap:7px; align-items:start; color:#7e98a6; }
      .replay-limit > span { margin-top:1px; font-size:12px; color:#b79a76; }
      .replay-limit p { font-size:9px; line-height:1.7; margin:0; }
      .replay-methods { margin-top:18px; border:1px solid #2d424c; border-radius:7px; background:#121f26; }
      .replay-methods > summary { cursor:pointer; padding:15px 18px; color:#b8c7cf; font-size:11px; }
      .replay-methods > summary > span { float:right; color:#698796; font-size:10px; }
      .replay-method-content { padding:0 18px 18px; color:#8da5b2; font-size:11px; line-height:1.75; }
      .replay-method-content p { margin:0 0 11px; }
      .replay-method-content strong { color:#c0cfd6; font-weight:500; }
      .replay-source-links { display:flex; gap:18px; flex-wrap:wrap; }
      .replay-source-links a { color:#dfb387; font-size:10px; text-decoration:none; }
      .replay-source-links a:hover { text-decoration:underline; }
      .replay-panel button:focus-visible, .replay-panel input:focus-visible, .replay-panel summary:focus-visible, .replay-panel a:focus-visible { outline:2px solid #dfad77; outline-offset:4px; }
      @media(max-width:1050px) { .replay-layout { grid-template-columns:minmax(0,1fr) 260px; } .replay-benchmark { padding:22px 17px; } .replay-map-label { max-width:190px; } }
      @media(max-width:760px) { .replay-layout { grid-template-columns:1fr; } .replay-benchmark { border-left:0; border-top:1px solid #34434b; } .replay-benchmark h3 br { display:none; } .replay-cell-stats { max-width:340px; } .replay-metrics { display:grid; grid-template-columns:repeat(3,1fr); gap:20px; } .replay-metric > div:first-child { display:block; } .replay-metric strong { display:block; margin-top:6px; } .replay-benchmark h3 { font-size:23px; } .replay-header h2 { font-size:25px; } .replay-header { gap:12px; align-items:flex-start; } .replay-sensor-control { margin-top:5px; } .replay-sensor-control button { padding:7px 10px; } .replay-header p { max-width:270px; font-size:11px; } .replay-map-label { left:12px; top:12px; } .replay-basemap { right:12px; top:12px; } }
      @media(max-width:460px) { .replay-header { flex-direction:column; gap:15px; } .replay-header p { max-width:none; } .replay-map-label { font-size:8px; padding:8px; max-width:165px; } .replay-map-label small { font-size:8px; } .replay-basemap { font-size:9px!important; padding:8px; } .replay-map-legend { padding:10px 12px; gap:10px; font-size:9px; } .replay-map-legend .replay-utc { display:none; } .replay-timeline { padding:18px 13px; } .replay-date-row { gap:9px; } .replay-current-date strong { font-size:11px; } .replay-day-count strong { font-size:17px; } .replay-play-controls { gap:1px; } .replay-play { width:29px; height:29px; } .replay-arrow { width:17px; } .replay-range-labels span:nth-child(2) { display:none; } .replay-bars { gap:2px; } .replay-metrics { gap:12px; } .replay-metric > div:first-child > span { font-size:10px; } .replay-methods > summary > span { display:none; } }
      @media(prefers-reduced-motion:reduce) { .replay-panel * { transition:none!important; } }
    `}</style>
  </section>;
}
