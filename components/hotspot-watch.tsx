"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, CircleHelp, Crosshair, Flame, Layers, MapPin, Pause, Play, Radio, RefreshCw, Satellite, Search, X } from "lucide-react";
import FireMap, { type FireBounds, type FirePoint } from "./fire-map";
import { deriveTimeline, filterAtTime, formatAge, groupHotspots } from "@/lib/live-timeline";

type LivePoint = FirePoint & { state: string };
type Incident = { id: string; name: string; lat: number; lon: number; state: string; acres: number | null; containment: number | null; updatedAt: string | null; discoveredAt: string | null; url: string };
type IncidentData = { incidents: Incident[]; fetchedAt: string; source: string; warning?: string };
type Focus = { id: string; title: string; lat: number; lon: number; incident?: Incident };
type Props = { points: LivePoint[]; fetchedAt: string | null; loading: boolean; error: string; missingFeeds: number; region: string; regionName: string; bounds: FireBounds; boundary?: object; onRefresh: () => void; onImagery: () => void };
const utc = (date: string) => new Date(date).toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " UTC";
function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const rad = Math.PI / 180;
  const dlat = (a.lat - b.lat) * rad, dlon = (a.lon - b.lon) * rad;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dlon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export default function LiveWatch({ points, fetchedAt, loading, error, missingFeeds, region, regionName, bounds, boundary, onRefresh, onImagery }: Props) {
  const [incidentData, setIncidentData] = useState<IncidentData | null>(null);
  const [incidentError, setIncidentError] = useState("");
  const [tab, setTab] = useState<"incidents" | "hotspots">("incidents");
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<Focus | null>(null);
  const [selected, setSelected] = useState<FirePoint | null>(null);
  const [satellite, setSatellite] = useState(true);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [replayPoints, setReplayPoints] = useState<LivePoint[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [clock, setClock] = useState<string | null>(null);
  const now = [clock, fetchedAt, incidentData?.fetchedAt].filter((value): value is string => !!value).sort().at(-1) ?? "";
  const reference = anchor ?? fetchedAt ?? "";

  useEffect(() => {
    let canceled = false;
    const controller = new AbortController();
    const retrieve = async () => {
      try {
        const response = await fetch("/api/incidents", { signal: controller.signal });
        const data = await response.json() as IncidentData & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Reported fires are temporarily unavailable.");
        if (!canceled) { setIncidentData(data); setIncidentError(""); }
      } catch (failure) { if (!canceled) setIncidentError(failure instanceof Error ? failure.message : "Reported fires are unavailable."); }
    };
    void retrieve();
    const timer = setInterval(() => void retrieve(), 300000);
    return () => { canceled = true; controller.abort(); clearInterval(timer); };
  }, []);
  useEffect(() => { const tick = () => setClock(new Date().toISOString()); const initial = setTimeout(tick, 0); const timer = setInterval(tick, 30000); return () => { clearTimeout(initial); clearInterval(timer); }; }, []);

  const regionPoints = useMemo(() => points.filter(p => region === "US" || p.state === region), [points, region]);
  const timelineSource = replayPoints ?? points;
  const areaPoints = useMemo(() => timelineSource.filter(p => focus ? distanceKm(focus, p) <= 40 : region === "US" || p.state === region), [focus, timelineSource, region]);
  const windowPoints = useMemo(() => filterAtTime(areaPoints, reference), [areaPoints, reference]);
  const frames = useMemo(() => deriveTimeline(windowPoints, reference), [windowPoints, reference]);
  const frameIndex = cursor === null ? Math.max(0, frames.length - 1) : Math.min(cursor, frames.length - 1);
  const frame = frames[frameIndex];
  const shown = useMemo(() => frame ? filterAtTime(windowPoints, frame.at) : [], [windowPoints, frame]);
  const groups = useMemo(() => groupHotspots(filterAtTime(regionPoints, fetchedAt ?? "")).sort((a, b) => b.pointCount - a.pointCount), [regionPoints, fetchedAt]);
  const incidents = useMemo(() => (incidentData?.incidents ?? []).filter(i => (region === "US" || i.state === region) && `${i.name} ${i.state}`.toLowerCase().includes(query.toLowerCase())), [incidentData, region, query]);
  const shownGroups = groups.filter(g => `${g.lat.toFixed(2)} ${g.lon.toFixed(2)}`.includes(query));
  const latest = windowPoints.at(-1)?.acquiredAt;
  const selectedVisible = selected && shown.some(p => p.id === selected.id) ? selected : null;
  const maxNew = Math.max(1, ...frames.map(f => f.newCount));
  const following = cursor === null && !playing;
  const currentIncident = focus?.incident ? incidentData?.incidents.find(i => i.id === focus.id) : null;
  const report = currentIncident ?? focus?.incident;
  const noLongerListed = !!focus?.incident && !!incidentData && !currentIncident;

  useEffect(() => {
    if (!playing || frames.length === 0) return;
    const timer = setInterval(() => setCursor(index => {
      const next = (index ?? -1) + 1;
      return next >= frames.length ? 0 : next;
    }), 850);
    return () => clearInterval(timer);
  }, [playing, frames.length]);

  function seek(index: number) { setPlaying(false); setAnchor(reference); setReplayPoints(replayPoints ?? points); setCursor(index); setSelected(null); }
  function followLatest() { setPlaying(false); setAnchor(null); setReplayPoints(null); setCursor(null); setSelected(null); }
  function choose(next: Focus) { setFocus(next); setSelected(null); followLatest(); }
  function play() { if (playing) { setPlaying(false); return; } setAnchor(reference); setReplayPoints(replayPoints ?? points); if (cursor === null || cursor >= frames.length - 1) setCursor(0); setSelected(null); setPlaying(true); }

  return <div className="live-watch">
    {error && <div className="notice error" role="alert"><CircleHelp size={17} /><span>{error}{fetchedAt && " Previous observations remain visible."}</span><button onClick={onRefresh}>Retry</button></div>}
    {fetchedAt && missingFeeds > 0 && <div className="notice"><CircleHelp size={17} /><span>{missingFeeds} of 6 NASA feeds are unavailable. These observations are incomplete.</span></div>}
    <div className="watch-status-strip"><span><span className={`status-dot ${error ? "quiet" : ""}`} />{following ? "FOLLOWING LATEST" : playing ? "PLAYING OBSERVATIONS" : "TIMELINE PAUSED"}</span><span>{latest ? `Newest detection ${formatAge(latest, now).toLowerCase()}` : !fetchedAt ? loading ? "Connecting to satellite feeds…" : "Satellite observations unavailable" : "No recent detections in this area"}</span><button onClick={onImagery}><Satellite size={15} /> Watch satellite imagery <ArrowUpRight size={14} /></button></div>
    <div className="watch-layout">
      <section className="panel watch-map-panel">
        <div className="watch-map-heading"><div><span className="section-kicker">OBSERVATION MAP</span><h2>{focus?.title ?? regionName}</h2></div>{focus && <button className="button secondary" onClick={() => { setFocus(null); setSelected(null); followLatest(); }}><X size={14} /> Reset area</button>}</div>
        <div className="watch-map"><FireMap points={shown} bounds={focus ? undefined : bounds} selectedBoundary={focus ? undefined : boundary} satellite={satellite} colorByAge referenceTime={frame?.at} recentWindowMinutes={60} radiusScale={focus ? .85 : .6} focusPoint={focus ? { lat: focus.lat, lon: focus.lon, zoom: 10 } : undefined} focusLabel={focus ? `${focus.title} · selected location, not a fire perimeter` : undefined} selectedId={selectedVisible?.id} onSelectPoint={point => { setSelected(point); if (!focus) setFocus({ id: point.id, title: "Selected hotspot area", lat: point.lat, lon: point.lon }); }} />
          <div className="map-overlay-top"><span className="map-location"><Crosshair size={13} />{focus ? "Within 40 km of selection" : "Select a fire or hotspot"}</span><button className="map-layer" onClick={() => setSatellite(v => !v)} aria-pressed={satellite}><Layers size={14} />{satellite ? "Satellite base" : "Dark map"}</button></div>
          <div className="watch-map-stamp"><Radio size={12} />{frame ? utc(frame.at) : "Awaiting observations"}<small>{following ? "Latest available observations" : "Acquisition-time replay"}</small></div>
          {fetchedAt && shown.length === 0 && <div className="map-empty">No detections in this frame.<small>{windowPoints.length ? "Move the timeline forward to see later observations." : "Clouds, overpass timing, or source delay can hide burning."}</small></div>}
        </div>
        <div className="watch-legend"><span><i style={{ background: "#ff984d" }} />≤1 hour old</span><span><i style={{ background: "#d9ae64" }} />1–6 hours</span><span><i style={{ background: "#72767e" }} />6–24 hours</span><small>Age at selected time · dots are detections</small></div>
        <div className="watch-timeline"><div className="watch-timeline-title"><span className="section-kicker">LAST 24 HOURS / OBSERVED ACTIVITY</span><strong>{fetchedAt ? `${shown.length.toLocaleString()} detections` : "Awaiting data"}</strong></div><div className="watch-timebars" aria-hidden="true">{frames.map((f, index) => <span key={f.at} className={index === frameIndex ? "current" : index > frameIndex ? "future" : ""} style={{ height: `${Math.max(5, f.newCount / maxNew * 100)}%` }} />)}</div><div className="watch-player"><button className="button primary" onClick={play} disabled={!frames.length || !windowPoints.length} aria-label={playing ? "Pause fire timeline" : "Play fire timeline"}>{playing ? <Pause size={16} /> : <Play size={16} />}</button><input type="range" min={0} max={Math.max(0, frames.length - 1)} value={frameIndex < 0 ? 0 : frameIndex} onChange={e => seek(+e.target.value)} aria-label="Fire observation time" aria-valuetext={frame ? utc(frame.at) : "Unavailable"} disabled={!frames.length} /><button className={`button secondary ${following ? "is-live" : ""}`} onClick={followLatest}><Radio size={14} /> Latest</button></div><div className="watch-time-labels"><span>{frames[0] ? utc(frames[0].at) : "24 hours ago"}</span><span>{frames.at(-1) ? utc(frames.at(-1)!.at) : "Latest"}</span></div><p>Bars show detections acquired each hour. Playback reveals new observations; it does not estimate a moving fire boundary.</p></div>
        <div className="watch-map-bottom"><span>{satellite ? "Reference satellite basemap · not live imagery" : "Reference basemap"}</span><span>{loading ? "Checking NASA…" : fetchedAt ? `NASA checked ${formatAge(fetchedAt, now).toLowerCase()}` : "NASA connection unavailable"}</span></div>
      </section>
      <aside className="watch-sidebar">
        {focus && <section className="panel watch-focus"><div className="section-kicker"><MapPin size={13} /> SELECTED AREA</div><h3>{focus.title}</h3><p>{focus.lat.toFixed(3)}, {focus.lon.toFixed(3)} · 40 km radius</p>{report && <><div className="watch-incident-stats"><div><strong>{report.acres == null ? "—" : Math.round(report.acres).toLocaleString()}</strong><small>reported acres</small></div><div><strong>{report.containment == null ? "—" : `${report.containment}%`}</strong><small>contained</small></div></div>{noLongerListed && <p className="watch-report-note" role="status">This incident is no longer in the latest returned list. Details below are from the previous report.</p>}<p className="footnote">{report.updatedAt ? `Report updated ${formatAge(report.updatedAt, now).toLowerCase()}. ` : "Report time unavailable. "}Nearby hotspots are not confirmed to belong to this incident.</p><a href={report.url} target="_blank" rel="noreferrer" className="text-link">Official incident record <ArrowUpRight size={13} /></a></>}{selectedVisible && <dl className="observation-details"><div><dt>Observed</dt><dd>{utc(selectedVisible.acquiredAt)}</dd></div><div><dt>Sensor</dt><dd>{selectedVisible.sensor}</dd></div><div><dt>Radiative power</dt><dd>{selectedVisible.frp === null ? "Unknown" : `${selectedVisible.frp.toFixed(1)} MW`}</dd></div></dl>}<button className="button secondary watch-imagery-button" onClick={onImagery}><Satellite size={15} /> Open regional thermal imagery</button></section>}
        <section className="panel watch-browser"><div className="watch-browser-title"><span className="section-kicker">FIND AN AREA TO WATCH</span><Flame size={16} /></div><div className="segmented watch-tabs"><button onClick={() => { setTab("incidents"); setQuery(""); }} className={tab === "incidents" ? "selected" : ""}>Reported fires</button><button onClick={() => { setTab("hotspots"); setQuery(""); }} className={tab === "hotspots" ? "selected" : ""}>Hotspot groups</button></div><label className="watch-search"><Search size={15} /><input placeholder={tab === "incidents" ? "Search fire name or state" : "Search coordinates"} aria-label={tab === "incidents" ? "Search reported fires" : "Search hotspot groups"} value={query} onChange={e => setQuery(e.target.value)} /></label>
          {tab === "incidents" ? <><p className="watch-list-note">NIFC reports · {incidentData ? `${incidents.length} in this selection` : "awaiting source"}<br />Locations and reports, not live fire perimeters.</p>{incidentError && <p className="watch-list-error" role="status">{incidentError}{incidentData && " Showing the last successful list."}</p>}<div className="watch-list">{!incidentData ? <p className="watch-list-empty">{incidentError ? "Report availability is unknown. Satellite observations are available separately under Hotspot groups." : "Loading reported fires…"}</p> : !incidents.length ? <p className="watch-list-empty">No matching reports returned. Try Hotspot groups to explore satellite detections.</p> : incidents.map(i => <button key={i.id} className={`watch-list-item ${focus?.id === i.id ? "chosen" : ""}`} onClick={() => choose({ id: i.id, title: i.name, lat: i.lat, lon: i.lon, incident: i })}><span className="watch-fire-icon"><Flame size={16} /></span><span><strong>{i.name}</strong><small>{i.state} · {i.acres === null ? "Size unknown" : `${Math.round(i.acres).toLocaleString()} acres`}{i.containment === null ? "" : ` · ${i.containment}% contained`}</small></span><ArrowUpRight size={13} /></button>)}</div><div className="watch-list-source"><a href={incidentData?.source ?? "https://www.arcgis.com/home/item.html?id=4181a117dc9e43db8598533e29972015"} target="_blank" rel="noreferrer">NIFC / WFIGS <ArrowUpRight size={11} /></a><span>Up to 150 recent U.S. reports</span></div></> : <><p className="watch-list-note">Nearby detections grouped in 15 km grid cells. Includes possible agricultural, industrial, and volcanic heat sources.</p><div className="watch-list">{!shownGroups.length ? <p className="watch-list-empty">{!fetchedAt ? loading ? "Loading satellite observations…" : "Satellite observations are unavailable." : "No groups match this selection."}</p> : shownGroups.slice(0, 60).map(g => <button key={g.id} className={`watch-list-item ${focus?.id === g.id ? "chosen" : ""}`} onClick={() => choose({ id: g.id, title: `Hotspots near ${g.lat.toFixed(2)}, ${g.lon.toFixed(2)}`, lat: g.lat, lon: g.lon })}><span className="watch-fire-icon"><Crosshair size={16} /></span><span><strong>{g.lat.toFixed(2)}, {g.lon.toFixed(2)}</strong><small>{g.pointCount} detections · {formatAge(g.latestAt, now)}</small></span><ArrowUpRight size={13} /></button>)}</div><div className="watch-list-source"><span>Top 60 groups by detection count</span><span>Not separate fire incidents</span></div></>}
        </section>
      </aside>
    </div>
    <div className="watch-explainer"><div><Radio size={18} /><div><strong>A map that updates with the evidence.</strong><p>We check NASA FIRMS every 5 minutes. New hotspots arrive after satellite overpasses and processing, so observations can be hours apart. NOAA imagery offers more frequent regional scans.</p></div></div><div><Satellite size={18} /><div><strong>Watch the scans from orbit.</strong><p>The thermal imagery loop shows recent NOAA GOES scans, normally 5 minutes apart over the contiguous U.S., with delivery delay. Clouds and pixel size limit what you can see.</p></div></div></div>
  </div>;
}
