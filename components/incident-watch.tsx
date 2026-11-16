"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Camera as CameraIcon, CircleHelp, Crosshair, Flame, Layers, MapPin, Pause, Play, Radio, RefreshCw, Satellite, Search } from "lucide-react";
import FireMap, { type FireBounds, type FirePoint, type MapGeometryLayer } from "./fire-map";
import IncidentCameras from "./incident-cameras";
import type { Camera } from "@/lib/cameras";
import type { GoesFrame, GoesFrameMetadata, GoesPlatform, GoesTimeline } from "@/lib/goes-types";
import type { PerimeterSummary as Summary, PerimeterIndex, PerimeterDetail } from "@/lib/perimeters";
import { formatAge } from "@/lib/live-timeline";

export type IncidentWatchProps = { points: (FirePoint & { state: string })[]; fetchedAt: string | null; loading: boolean; error: string; missingFeeds: number; region: string; regionName: string; bounds: FireBounds; boundary?: object; onRefresh: () => void; onImagery: () => void };
const utc = (date?: string | null) => date ? new Date(date).toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " UTC" : "Not supplied";
const inBounds = (p: { lat: number; lon: number }, b: FireBounds) => p.lat >= b.south && p.lat <= b.north && p.lon >= b.west && p.lon <= b.east;
function pad(b: FireBounds, minimum: number, fraction = .2): FireBounds { const dx = Math.max(minimum, (b.east - b.west) * fraction), dy = Math.max(minimum, (b.north - b.south) * fraction); return { west: b.west - dx, east: b.east + dx, south: b.south - dy, north: b.north + dy }; }
function extent(i: Summary): FireBounds { return i.bounds ?? { west: i.lon - .05, east: i.lon + .05, south: i.lat - .05, north: i.lat + .05 }; }
async function json<T>(url: string, signal: AbortSignal): Promise<T> { const response = await fetch(url, { signal }); const data = await response.json() as T & { error?: string }; if (!response.ok) throw new Error(data.error || `Source unavailable (${response.status})`); return data as T; }

export default function IncidentWatch({ points, fetchedAt, loading, error, missingFeeds, region, regionName, bounds, boundary, onRefresh, onImagery }: IncidentWatchProps) {
  const [index, setIndex] = useState<PerimeterIndex | null>(null), [indexError, setIndexError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null), [query, setQuery] = useState("");
  const [detail, setDetail] = useState<PerimeterDetail | null>(null), [detailError, setDetailError] = useState(""), [detailLoading, setDetailLoading] = useState(false);
  const [version, setVersion] = useState("latest"), [refresh, setRefresh] = useState(0), [fitKey, setFitKey] = useState(0);
  const [satellite, setSatellite] = useState(true), [showPerimeter, setShowPerimeter] = useState(true), [showHeat, setShowHeat] = useState(true), [showNasa, setShowNasa] = useState(true), [showCameras, setShowCameras] = useState(true);
  const [clock, setClock] = useState("");
  const [platformOverride, setPlatformOverride] = useState<GoesPlatform | "auto">("auto");
  const [catalog, setCatalog] = useState<GoesTimeline | null>(null), [catalogError, setCatalogError] = useState("");
  const [heldFrames, setHeldFrames] = useState<GoesFrameMetadata[] | null>(null), [frameKey, setFrameKey] = useState<string | null>(null), [playing, setPlaying] = useState(false);
  const [frameArea, setFrameArea] = useState("");
  const [frame, setFrame] = useState<GoesFrame | null>(null), [frameError, setFrameError] = useState(""), [frameLoading, setFrameLoading] = useState(false);
  const frameCache = useRef(new Map<string, GoesFrame>());
  const [cameras, setCameras] = useState<Camera[]>([]), [cameraId, setCameraId] = useState<string>();
  const [cameraFocus, setCameraFocus] = useState<{lat: number; lon: number; zoom: number} | undefined>();
  const [selectedPoint, setSelectedPoint] = useState<FirePoint | null>(null);
  useEffect(() => { const update = () => setClock(new Date().toISOString()); update(); const timer = setInterval(update, 30000); return () => clearInterval(timer); }, []);

  useEffect(() => {
    const abort = new AbortController(); let live = true;
    async function retrieve() { try { const data = await json<PerimeterIndex>("/api/perimeters", abort.signal); if (live) { setIndex(data); setIndexError(""); } } catch (e) { if (live) setIndexError(e instanceof Error ? e.message : "Mapped fires unavailable"); } }
    void retrieve(); const timer = setInterval(() => { if (!document.hidden) void retrieve(); }, 300000);
    return () => { live = false; abort.abort(); clearInterval(timer); };
  }, [refresh]);
  const eligible = useMemo(() => (index?.incidents ?? []).filter(i => region === "US" || i.state === region), [index, region]);
  const ranked = useMemo(() => {
    const ongoing = eligible.filter(i => i.containment !== 100);
    return [...(ongoing.length ? ongoing : eligible)].sort((a, b) => {
      // Open on a fire that satellites are seeing right now: most detections first, then size.
      const near = (i: Summary) => { const box = pad(extent(i), .015); return Math.min(999, points.filter(p => inBounds(p, box)).length); };
      const score = (i: Summary) => (i.quality === "mapped" ? 1e15 : 0) + near(i) * 1e11 + (i.containment !== null && (i.acres ?? 0) >= 100 ? 1e10 : 0) + Math.min(i.acres ?? 0, 9e9);
      const scores = new Map<string, number>(); const cached = (i: Summary) => { let v = scores.get(i.id); if (v === undefined) { v = score(i); scores.set(i.id, v); } return v; };
      return cached(b) - cached(a);
    });
  }, [eligible, points]);
  useEffect(() => { if ((!selectedId || !eligible.some(i => i.id === selectedId)) && ranked.length && (fetchedAt || !loading)) setSelectedId(ranked[0].id); }, [ranked, selectedId, eligible, fetchedAt, loading]);
  const incident = eligible.find(i => i.id === selectedId) ?? null;
  const list = ranked.filter(i => `${i.name} ${i.state}`.toLowerCase().includes(query.toLowerCase()));
  const mapBounds = useMemo(() => incident ? pad(extent(incident), .03, .25) : bounds, [incident, bounds]);
  const thermalBounds = useMemo(() => incident ? pad(extent(incident), .35, .4) : null, [incident]);
  const bbox = thermalBounds ? `${thermalBounds.west.toFixed(4)},${thermalBounds.south.toFixed(4)},${thermalBounds.east.toFixed(4)},${thermalBounds.north.toFixed(4)}` : "";
  const platform: GoesPlatform = platformOverride === "auto" ? (incident && incident.lon < -105 ? "18" : "19") : platformOverride;
  const inConus = !!incident && !["AK", "HI", "PR", "GU", "VI", "AS", "MP"].includes(incident.state) && incident.lat > 24 && incident.lat < 50.5 && incident.lon > -126 && incident.lon < -66;
  const frames = heldFrames ?? (catalog?.platform === platform ? catalog.frames : []);
  const targetFrame = frameKey ? frames.find(f => f.key === frameKey) : frames.at(-1);
  const frameIndex = targetFrame ? frames.findIndex(f => f.key === targetFrame.key) : 0;
  const following = frameKey === null;
  const historyDetail = incident && detail?.incidentId.toLowerCase() === selectedId?.toLowerCase() ? detail : null;
  const currentDetail = incident && detail && detail.incidentId.toLowerCase() === selectedId?.toLowerCase() && (version === "latest" ? !detail.selectedVersionId : detail.selectedVersionId === version) ? detail : null;
  const perimeter = currentDetail?.preferred ?? null;
  const now = [clock, fetchedAt, index?.fetchedAt].filter((x): x is string => !!x).sort().at(-1) ?? "";
  const isFrameReady = !!targetFrame && frame?.frame.key === targetFrame.key && frame.frame.platform === platform && frameArea === bbox && !frameLoading && !frameError;
  const observedFrame = isFrameReady ? frame : null;

  useEffect(() => {
    setVersion("latest"); setDetail(null); setCameras([]); setCameraId(undefined); setCameraFocus(undefined); setSelectedPoint(null); setFrame(null); setHeldFrames(null); setFrameKey(null); setPlaying(false);
  }, [selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    const abort = new AbortController(); let live = true;
    async function retrieve() { setDetailLoading(true); try { const data = await json<PerimeterDetail>(`/api/perimeters?id=${encodeURIComponent(selectedId!)}${version === "latest" ? "" : `&version=${version}`}`, abort.signal); if (live) { setDetail(data); setDetailError(""); } } catch (e) { if (live) { setDetailError(e instanceof Error ? e.message : "Boundary unavailable"); } } finally { if (live) setDetailLoading(false); } }
    void retrieve(); const timer = setInterval(() => { if (version === "latest" && !document.hidden) void retrieve(); }, 300000);
    return () => { live = false; abort.abort(); clearInterval(timer); };
  }, [selectedId, version, refresh]);
  useEffect(() => { setHeldFrames(null); setFrameKey(null); setPlaying(false); setFrame(null); }, [platform]);
  useEffect(() => {
    if (!inConus) return;
    const abort = new AbortController(); let live = true;
    async function retrieve() { try { const data = await json<GoesTimeline>(`/api/goes?platform=${platform}&hours=3`, abort.signal); if (live) { setCatalog(data); setCatalogError(""); } } catch (e) { if (live) setCatalogError(e instanceof Error ? e.message : "NOAA scan listing unavailable"); } }
    void retrieve(); const timer = setInterval(() => { if (!document.hidden) void retrieve(); }, 60000);
    return () => { live = false; abort.abort(); clearInterval(timer); };
  }, [platform, inConus, refresh]);
  useEffect(() => {
    if (!targetFrame || !bbox || !inConus) { setFrame(null); return; }
    const key = `${platform}|${bbox}|${targetFrame.key}`;
    const cached = frameCache.current.get(key);
    setFrameError("");
    if (cached) { setFrameArea(bbox); setFrame(cached); setFrameLoading(false); return; }
    const abort = new AbortController(); let live = true; setFrameLoading(true); setFrame(null);
    json<GoesFrame>(`/api/goes/frame?platform=${platform}&key=${encodeURIComponent(targetFrame.key)}&bbox=${bbox}`, abort.signal).then(data => {
      if (!live) return;
      frameCache.current.set(key, data);
      if (frameCache.current.size > 50) frameCache.current.delete(frameCache.current.keys().next().value!);
      setFrameArea(bbox); setFrame(data); setFrameError("");
    }).catch(e => { if (live) { setFrameError(e instanceof Error ? e.message : "Thermal scan unavailable"); setPlaying(false); } }).finally(() => { if (live) setFrameLoading(false); });
    return () => { live = false; abort.abort(); };
  }, [targetFrame?.key, platform, bbox, inConus, refresh]);
  useEffect(() => {
    if (!playing || !isFrameReady || frames.length < 2) return;
    const timer = setTimeout(() => setFrameKey(frames[(frameIndex + 1) % frames.length].key), 1200);
    return () => clearTimeout(timer);
  }, [playing, isFrameReady, frameIndex, frames]);
  const nasaPoints = useMemo(() => {
    if (!incident || !thermalBounds || !fetchedAt) return [];
    const end = Date.parse(following ? fetchedAt : targetFrame?.scanEnd ?? fetchedAt);
    return points.filter(p => inBounds(p, thermalBounds) && Date.parse(p.acquiredAt) <= end && Date.parse(p.acquiredAt) > end - 86400000);
  }, [incident, thermalBounds, points, fetchedAt, following, targetFrame?.scanEnd]);
  const visibleSelectedPoint = selectedPoint && nasaPoints.some(p => p.id === selectedPoint.id) ? selectedPoint : null;
  const geoLayers = useMemo<MapGeometryLayer[]>(() => {
    const layers: MapGeometryLayer[] = [];
    if (showPerimeter && perimeter) layers.push({ id: "perimeter", data: perimeter, label: `${incident?.name} · ${perimeter.properties.mapMethod || "published boundary"} · capture ${utc(perimeter.properties.capturedAt)}`, color: "#e9eccb", fillOpacity: .09, weight: 2.5, dashArray: perimeter.properties.quality === "mapped" ? undefined : "6 5" });
    if (showHeat && observedFrame) layers.push({ id: "goes", data: observedFrame.features, label: `GOES-${platform} thermal pixel · ${utc(observedFrame.frame.scanStart)}`, color: "#ff683b", fillOpacity: .48, weight: 1.4, featureLabel: p => `GOES-${platform} · ${utc(String(p.acquiredAt))} · ${p.quality} thermal pixel, not a fire boundary` });
    const camera = cameras.find(c => c.id === cameraId);
    if (showCameras && camera?.fieldOfView) layers.push({id: "camera-view", data: camera.fieldOfView, label: `${camera.name} · reported camera sector, visibility unconfirmed`, color: "#8acbd7", fillOpacity: .08, weight: 1, dashArray: "3 4"});
    return layers;
  }, [showPerimeter, perimeter, incident?.name, showHeat, observedFrame, platform, cameras, cameraId, showCameras]);
  const cameraLocations = useMemo(() => showCameras ? cameras.map(c => ({ id: c.id, lat: c.lat, lon: c.lon, label: `${c.name} · camera location`, kind: "camera" as const })) : [], [cameras, showCameras]);
  const updateCameras = useCallback((next: Camera[]) => setCameras(next), []);
  const selectCamera = useCallback((camera: Camera) => { setCameraId(camera.id); setCameraFocus({lat: camera.lat, lon: camera.lon, zoom: 11}); document.getElementById("incident-observation-map")?.scrollIntoView({behavior: "smooth", block: "start"}); }, []);
  function choose(id: string) { setSelectedId(id); setFitKey(v => v + 1); }
  function latest() { setPlaying(false); setFrameKey(null); setHeldFrames(null); }
  function seek(n: number) { setPlaying(false); setHeldFrames(frames); setFrameKey(frames[n]?.key ?? null); }
  function play() { if (playing) { setPlaying(false); return; } setHeldFrames(frames); if (following || frameIndex >= frames.length - 1) setFrameKey(frames[0]?.key ?? null); setPlaying(true); }
  const boundaryInfo = perimeter?.properties;

  return <div className="live-watch incident-watch">
    <div className="watch-status-strip"><span><span className={`status-dot ${frameError || catalogError ? "quiet" : ""}`} />{following ? "FOLLOWING LATEST SCANS" : playing ? "PLAYING SATELLITE SCANS" : "SCAN TIMELINE PAUSED"}</span><span>{targetFrame ? `GOES scan ${formatAge(targetFrame.scanStart, now).toLowerCase()}` : "Connecting to observation sources…"}</span><button onClick={() => { setRefresh(v => v + 1); onRefresh(); }}><RefreshCw size={14} /> Refresh sources</button></div>
    {(indexError || (index?.partial && index.warning)) && <div className="notice" role="status"><CircleHelp size={16} /><span>{indexError || index?.warning}{indexError && index && " Showing the last successful fire list."}</span></div>}
    <div className="watch-layout">
      <div className="incident-main">
        <section className="panel watch-map-panel">
          <div className="watch-map-heading"><div><span className="section-kicker">INCIDENT OBSERVATORY / {incident?.state || regionName.toUpperCase()}</span><h2>{incident?.name || (index ? "Choose a mapped fire" : "Finding a mapped fire…")}</h2></div><button className="button secondary" disabled={!incident} onClick={() => { setCameraFocus(undefined); setFitKey(v => v + 1); }} aria-label="Fit mapped fire"><Crosshair size={14} /> Fit fire</button></div>
          <div className="incident-layer-bar" aria-label="Map layers"><button aria-pressed={showPerimeter} onClick={() => setShowPerimeter(v => !v)}><i className="outline-key" /> Fire boundary</button><button aria-pressed={showHeat} onClick={() => setShowHeat(v => !v)}><i className="heat-key" /> GOES heat pixels</button><button aria-pressed={showNasa} onClick={() => setShowNasa(v => !v)}><i className="nasa-key" /> NASA · past 24 h</button><button aria-pressed={showCameras} onClick={() => setShowCameras(v => !v)}><CameraIcon size={13} /> Cameras</button></div>
          <div id="incident-observation-map" className="watch-map incident-map"><FireMap points={showNasa ? nasaPoints : []} bounds={mapBounds} selectedBoundary={incident ? undefined : boundary} fitKey={`${selectedId}-${fitKey}`} satellite={satellite} focusPoint={cameraFocus} focusLabel={cameraFocus ? "Selected ground camera location" : undefined} geometryLayers={geoLayers} locations={cameraLocations} selectedLocationId={cameraId} onSelectLocation={location => setCameraId(location.id)} referenceTime={following ? fetchedAt ?? undefined : targetFrame?.scanEnd} recentWindowMinutes={60} radiusScale={.8} selectedId={visibleSelectedPoint?.id} onSelectPoint={setSelectedPoint} />
            <div className="map-overlay-top"><span className="map-location"><MapPin size={13} />{boundaryInfo ? boundaryInfo.quality === "mapped" ? "Official mapped perimeter" : boundaryInfo.quality === "approximate" ? "Approximate published boundary" : "Boundary method unverified" : detailLoading ? "Loading boundary…" : "No verified boundary loaded"}</span><button className="map-layer" onClick={() => setSatellite(v => !v)} aria-pressed={satellite}><Layers size={14} />{satellite ? "Satellite base" : "Dark map"}</button></div>
            <div className="watch-map-stamp"><Radio size={12} />{observedFrame ? utc(observedFrame.frame.scanStart) : frameLoading ? "Decoding NOAA thermal scan…" : inConus ? "Thermal scan unavailable" : "GOES CONUS coverage unavailable"}<small>{observedFrame ? `${observedFrame.detectionCount} high-confidence heat pixels in this area` : frameError ? "See source status below" : "Perimeter and NASA observations remain separate"}</small>{boundaryInfo && <small>Boundary capture: {utc(boundaryInfo.capturedAt)}</small>}</div>
          </div>
          <div className="incident-source-times"><div><span>Boundary capture</span><strong>{utc(boundaryInfo?.capturedAt)}</strong><small>{boundaryInfo?.mapMethod || "Awaiting source geometry"}</small></div><div><span>Satellite scan</span><strong>{utc(observedFrame?.frame.scanStart)}</strong><small>{observedFrame ? `GOES-${platform} · 2 km pixels at nadir` : "No current thermal frame displayed"}</small></div><div><span>NASA observations</span><strong>{nasaPoints.length} detections / 24 h</strong><small>{fetchedAt ? `${missingFeeds ? `${6 - missingFeeds}/6 feeds · ` : ""}latest ${nasaPoints.length ? formatAge(nasaPoints.reduce((a, p) => p.acquiredAt > a ? p.acquiredAt : a, ""), now).toLowerCase() : "none in area"}` : loading ? "Connecting…" : "Feed unavailable"}</small></div></div>
          <div className="watch-timeline"><div className="watch-timeline-title"><span className="section-kicker">LAST 3 HOURS / GOES THERMAL SCANS</span><label className="goes-platform">Satellite <select aria-label="GOES satellite" value={platformOverride} onChange={e => setPlatformOverride(e.target.value as GoesPlatform | "auto")}><option value="auto">Auto · GOES-{incident && incident.lon < -105 ? "18" : "19"}</option><option value="18">GOES-18 · West</option><option value="19">GOES-19 · East</option></select></label></div>
            <div className="goes-frame-ticks" aria-hidden="true">{frames.map(f => <span key={f.key} className={f.key === targetFrame?.key ? "current" : ""} />)}</div>
            <div className="watch-player"><button className="button primary" onClick={play} disabled={frames.length < 2 || !inConus} aria-label={playing ? "Pause thermal scans" : "Play thermal scans"}>{playing ? <Pause size={16} /> : <Play size={16} />}</button><input type="range" min={0} max={Math.max(0, frames.length - 1)} value={Math.max(0, frameIndex)} onChange={e => seek(+e.target.value)} aria-label="Thermal scan time" aria-valuetext={targetFrame ? utc(targetFrame.scanStart) : "Unavailable"} disabled={!frames.length || !inConus} /><button className={`button secondary ${following ? "is-live" : ""}`} onClick={latest}><Radio size={14} /> Latest</button></div><div className="watch-time-labels"><span>{utc(frames[0]?.scanStart)}</span><span>{utc(frames.at(-1)?.scanStart)}</span></div>
            <p>{frames.length} observed scans. Normally 5 minutes apart; playback waits for each scan. Satellite pixels show detected heat, not the exact flame edge. The boundary above keeps its own survey time.</p>
            {catalog?.platform === platform && catalog.warnings.map((warning, n) => <p className="source-warning" role="status" key={n}>{warning}</p>)}
            {observedFrame && <details className="thermal-notes"><summary>Thermal coverage & confidence</summary><p>Cells are satellite footprints and can include unburned land. Their size grows away from the center of the satellite view.</p><p>Only high-confidence heat detections are shown. Clouds and small fires can leave gaps.</p><p>This scan spans {utc(observedFrame.frame.scanStart)} to {utc(observedFrame.frame.scanEnd)}. Different pixels are observed at different moments within that interval.</p></details>}
            {(catalogError || frameError) && <p className="source-warning" role="alert">{catalogError || frameError} <button onClick={() => setRefresh(v => v + 1)}>Retry NOAA</button></p>}
            {!inConus && incident && <p className="source-warning">This incident is outside this GOES CONUS product. Published boundaries, NASA hotspots, and camera availability are still shown.</p>}
            {observedFrame && !observedFrame.detectionCount && <p className="source-warning">No high-confidence GOES heat pixels detected here in this scan. Clouds, a small or cooling fire, or viewing geometry can hide burning.</p>}
          </div><div className="watch-map-bottom"><span>{satellite ? "Reference satellite basemap · not live" : "Reference basemap"}</span>{observedFrame && <a href={observedFrame.frame.url} target="_blank" rel="noreferrer">NOAA source scan ↗</a>}<button onClick={onImagery}>Regional imagery ↗</button></div>
        </section>
        <section className="panel perimeter-history"><div className="perimeter-history-heading"><div><span className="section-kicker">MAPPED PROGRESSION</span><h3>Published boundary versions</h3></div><label>Boundary <select aria-label="Perimeter version" value={version} onChange={e => setVersion(e.target.value)} disabled={!incident}><option value="latest">Latest available</option>{historyDetail?.versions.map(v => <option key={v.versionId} value={v.versionId}>{v.capturedAt ? "Capture " + utc(v.capturedAt) : v.sourceUpdatedAt ? "Source " + utc(v.sourceUpdatedAt) : "Saved " + utc(v.observedAt)} · {v.source}</option>)}</select></label></div>{currentDetail && (currentDetail.partial || currentDetail.history.status === "unavailable") && <p className="source-warning" role="status">{currentDetail.warning}</p>}<p>{detailError || currentDetail?.history.note || (detailLoading ? "Loading available boundary history…" : "Select a fire to inspect its mapped boundary.")}</p>{boundaryInfo && <div className="perimeter-provenance"><span>Capture: {utc(boundaryInfo.capturedAt)}</span><span>Source record: {utc(boundaryInfo.sourceUpdatedAt ?? boundaryInfo.editedAt)}</span><a href={boundaryInfo.sourceUrl} target="_blank" rel="noreferrer">{boundaryInfo.source} <ArrowUpRight size={12} /></a></div>}</section>
        <IncidentCameras lat={incident?.lat} lon={incident?.lon} onSelectCamera={selectCamera} onCamerasChange={updateCameras} selectedCameraId={cameraId} />
      </div>
      <aside className="watch-sidebar">
        <section className="panel watch-focus"><div className="section-kicker"><Flame size={13} /> INCIDENT REPORT</div><h3>{incident?.name || "Awaiting mapped incidents"}</h3>{incident && <><p>{incident.state} · {incident.lat.toFixed(3)}, {incident.lon.toFixed(3)}</p><p><a className="text-link" href={`/scene?lat=${incident.lat.toFixed(4)}&lon=${incident.lon.toFixed(4)}&name=${encodeURIComponent(incident.name)}`}>See the latest satellite pass in 3D →</a></p><div className="watch-incident-stats"><div><strong>{incident.acres == null ? "—" : Math.round(incident.acres).toLocaleString()}</strong><small>reported acres</small></div><div><strong>{incident.containment == null ? "—" : `${incident.containment}%`}</strong><small>contained</small></div></div><p>Report: {utc(incident.updatedAt)}</p><div className="incident-evidence"><strong>What this map shows</strong><p>The outline is the {version === "latest" ? "selected published" : "selected saved"} footprint{boundaryInfo?.quality === "approximate" ? " (approximate)" : boundaryInfo?.quality === "unknown" ? " (mapping method unverified)" : ""}. Orange cells are heat detected in the selected satellite scan. Blue pins locate cameras.</p><p>It is not a continuously surveyed fire front. Use official incident instructions for response decisions.</p></div>{visibleSelectedPoint && <dl className="observation-details"><div><dt>NASA sensor</dt><dd>{visibleSelectedPoint.sensor}</dd></div><div><dt>Observed</dt><dd>{utc(visibleSelectedPoint.acquiredAt)}</dd></div><div><dt>Radiative power</dt><dd>{visibleSelectedPoint.frp == null ? "Unknown" : `${visibleSelectedPoint.frp.toFixed(1)} MW`}</dd></div></dl>}</>}</section>
        <section className="panel watch-browser"><div className="watch-browser-title"><span className="section-kicker">FIND A MAPPED FIRE</span><Search size={15} /></div><label className="watch-search"><Search size={15} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Fire name or state" aria-label="Search mapped fires" /></label><p className="watch-list-note">{index ? `${list.length} reports in ${regionName}` : "Loading official boundaries…"} · latest published footprints, with separate capture times.</p><div className="watch-list">{!list.length ? <p className="watch-list-empty">{index ? "No matching mapped incident is available. Try another state or the All hotspots view." : indexError ? "Mapped reports could not be loaded." : "Retrieving NIFC and California mapping…"}</p> : list.map(i => <button key={i.id} className={`watch-list-item ${selectedId === i.id ? "chosen" : ""}`} onClick={() => choose(i.id)}><span className="watch-fire-icon"><Flame size={16} /></span><span><strong>{i.name}</strong><small>{i.state} · {i.containment == null ? "Containment unknown" : `${i.containment}% contained`}</small><small className={i.quality === "mapped" ? "mapped-badge" : ""}>{i.quality === "mapped" ? "Mapped" : "Approximate / unverified"} · {i.capturedAt ? formatAge(i.capturedAt, now) : "Capture time unavailable"}</small></span><ArrowUpRight size={13} /></button>)}</div><div className="watch-list-source"><span>NIFC / WFIGS + CAL FIRE aerial mapping</span><span>Refreshes every 5 minutes while open</span></div></section>
        <section className="panel incident-health"><span className="section-kicker">SOURCE STATUS</span>{(currentDetail?.sources ?? index?.sources)?.map(s => <div key={s.id}><strong>{s.name}</strong><span>{s.status}</span>{s.error && <p>{s.error}</p>}</div>)}<div><strong>Boundary refresh</strong><span>{detailError ? "Unavailable" : currentDetail ? "Loaded" : "Waiting"}</span>{detailError && <p>{detailError}</p>}</div><div><strong>Boundary history</strong><span>{currentDetail?.history.status ?? (detailError ? "Unavailable" : "Waiting")}</span></div><div><strong>NOAA GOES-{platform}</strong><span>{catalogError || frameError ? "Unavailable" : observedFrame ? "Scan loaded" : frameLoading ? "Decoding scan" : "Waiting"}</span></div><div><strong>NASA FIRMS</strong><span>{error ? "Source issue" : fetchedAt ? `${6 - missingFeeds}/6 feeds` : "Waiting"}</span>{error && <p>{error}</p>}</div><p>New data are checked while this page is open. Refreshing a source does not mean a new boundary was surveyed.</p></section>
      </aside>
    </div>
  </div>;
}
