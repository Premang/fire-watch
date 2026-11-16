"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Camera as CameraIcon, MapPin, RefreshCw } from "lucide-react";
import { CAMERA_ATTRIBUTION, CAMERA_LICENSE, CAMERA_SOURCE, cameraFreshness } from "@/lib/cameras";
import type { Camera, CameraResponse } from "@/lib/cameras";

export type { Camera } from "@/lib/cameras";
export interface IncidentCamerasProps {
  lat?: number;
  lon?: number;
  selectedCameraId?: string | null;
  onSelectCamera?: (camera: Camera) => void;
  onCamerasChange?: (cameras: Camera[]) => void;
}

function stamp(value: string | null): string {
  if (!value) return "Unavailable";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date) + " UTC" : "Unavailable";
}

export default function IncidentCameras({ lat, lon, selectedCameraId, onSelectCamera, onCamerasChange }: IncidentCamerasProps) {
  const root = useRef<HTMLElement>(null);
  const callbacks = useRef({ onSelectCamera, onCamerasChange });
  const attempted = useRef<{ key: string; retry: number } | null>(null);
  const [record, setRecord] = useState<{ key: string; data: CameraResponse } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [inViewport, setInViewport] = useState(true);
  const [tabVisible, setTabVisible] = useState(true);
  const [clock, setClock] = useState<string | null>(null);
  const [internalId, setInternalId] = useState<string | null>(null);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const validArea = typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const key = validArea ? `${lat},${lon}` : "";
  const data = record?.key === key ? record.data : null;
  const visibleError = error?.key === key ? error.message : "";
  const cameras = data?.cameras ?? [];
  const selected = cameras.find((camera) => camera.id === (selectedCameraId ?? internalId)) ?? cameras.find((camera) => camera.imageStatus === "available") ?? cameras[0];
  const visible = inViewport && tabVisible;
  const freshness = selected ? cameraFreshness(selected.capturedAt, clock ?? data?.fetchedAt ?? "") : "unknown";

  useEffect(() => { callbacks.current = { onSelectCamera, onCamerasChange }; }, [onSelectCamera, onCamerasChange]);
  useEffect(() => {
    const visibility = () => setTabVisible(document.visibilityState !== "hidden");
    visibility();
    document.addEventListener("visibilitychange", visibility);
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => setInViewport(entry.isIntersecting), { rootMargin: "120px" });
    if (root.current) observer?.observe(root.current);
    return () => { document.removeEventListener("visibilitychange", visibility); observer?.disconnect(); };
  }, []);
  useEffect(() => {
    callbacks.current.onCamerasChange?.([]);
  }, [key]);
  useEffect(() => {
    // Always discover each newly selected area's cameras once so map pins can
    // appear even when this panel is below the fold. Only polling is gated.
    if (!key || (!visible && attempted.current?.key === key && attempted.current.retry === retry)) return;
    let canceled = false, inFlight = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      setClock(new Date().toISOString());
      if (inFlight) return;
      inFlight = true;
      controller = new AbortController();
      setLoading(true);
      try {
        const response = await fetch(`/api/cameras?${new URLSearchParams({ lat: String(lat), lon: String(lon) })}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as CameraResponse & { error?: string };
        if (!response.ok || !Array.isArray(payload.cameras)) throw new Error(payload.error ?? "Camera data is temporarily unavailable.");
        if (!canceled) {
          setRecord({ key, data: payload }); setError(null); setClock(new Date().toISOString());
          callbacks.current.onCamerasChange?.(payload.cameras);
        }
      } catch (failure) {
        if (!canceled) setError({ key, message: failure instanceof Error ? failure.message : "Camera data is unavailable." });
      } finally { inFlight = false; if (!canceled) { attempted.current = { key, retry }; setLoading(false); } }
    };
    void refresh();
    const timer = visible ? setInterval(() => void refresh(), 15_000) : null;
    return () => { canceled = true; controller?.abort(); if (timer) clearInterval(timer); };
  }, [key, lat, lon, visible, retry]);

  function choose(camera: Camera) {
    setInternalId(camera.id); setFailedImage(null); callbacks.current.onSelectCamera?.(camera);
  }
  function refresh() { setFailedImage(null); setRetry((value) => value + 1); }

  return <section ref={root} className="panel incident-cameras" aria-label="Nearby ground cameras">
    <div className="ic-heading"><div><span className="section-kicker"><CameraIcon size={13} /> NEARBY GROUND CAMERAS</span><h3>A view from the ground.</h3></div>{key && <button type="button" onClick={refresh} className="ic-refresh" aria-label="Refresh nearby camera images" disabled={loading}><RefreshCw size={15} className={loading ? "ic-spinning" : ""} /></button>}</div>
    <p className="ic-intro">Public ALERTCalifornia views near your selection. A nearby camera may be facing away from the fire.</p>
    {!validArea ? <div className="ic-empty"><MapPin size={20} /><p>Select a fire or hotspot to find nearby cameras.</p><a href="https://cameras.alertcalifornia.org/" target="_blank" rel="noreferrer">Explore the camera network <ArrowUpRight size={13} /></a></div> : <>
      {visibleError && <div className="ic-notice ic-error" role="status">{visibleError}{data && " Showing the previous camera result; source image times are shown below."}<button type="button" onClick={refresh}>Retry</button></div>}
      {!data && !visibleError && <div className="ic-empty"><CameraIcon size={22} /><p>Finding nearby source cameras…</p></div>}
      {data?.status === "outside-coverage" && <div className="ic-empty"><MapPin size={20} /><p>This location is outside this California camera network’s nearby coverage.</p><a href="https://cameras.alertcalifornia.org/" target="_blank" rel="noreferrer">Open the source coverage map <ArrowUpRight size={13} /></a></div>}
      {data?.status === "empty" && <div className="ic-empty"><p>No ALERTCalifornia camera was listed within {data.radiusKm} km. Camera availability does not establish whether burning is present.</p><a href="https://cameras.alertcalifornia.org/" target="_blank" rel="noreferrer">Explore broader camera coverage <ArrowUpRight size={13} /></a></div>}
      {selected && <>
        <div className="ic-view-title"><div><strong>{selected.name}</strong><small>{selected.distanceKm.toFixed(1)} km from selection{selected.county ? ` · ${selected.county} County` : ""}</small></div><span className={`ic-status ic-${freshness}`}>{selected.imageStatus === "unavailable" ? "Image unavailable" : freshness === "recent" ? "Recent source frame" : freshness === "stale" ? "Stale frame" : freshness === "future" ? "Source clock ahead" : "Capture time unavailable"}</span></div>
        <div className="ic-image-wrap">
          {selected.imageUrl && failedImage !== selected.imageUrl ? <a href={selected.imageUrl} target="_blank" rel="noreferrer" aria-label={`Open full uncropped image from ${selected.name}`}>
            {/* Keep the original image uncropped, including source timestamps and partner logos. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img key={`${selected.id}:${selected.imageUrl}:${retry}`} src={selected.imageUrl} alt={`Source camera view from ${selected.name}. Visibility of the selected fire is unconfirmed.`} loading="lazy" onError={() => setFailedImage(selected.imageUrl)} />
          </a> : <div className="ic-image-missing"><CameraIcon size={28} /><span>{failedImage ? "The source image could not be displayed." : "This camera’s image is currently unavailable."}</span><a href={selected.sourceUrl} target="_blank" rel="noreferrer">Check the official camera page <ArrowUpRight size={13} /></a></div>}
        </div>
        <div className="ic-image-meta"><div><span>Source image time</span><strong>{stamp(selected.capturedAt)}</strong></div><a href={selected.sourceUrl} target="_blank" rel="noreferrer">Full camera view <ArrowUpRight size={13} /></a></div>
        {!selected.capturedAt && <p className="ic-note">The source did not expose a separate capture timestamp. Read any timestamp on the original image; the check time below is not its capture time.</p>}
        {freshness === "stale" && <p className="ic-notice">This source frame is over 5 minutes old. It may no longer show current conditions.</p>}
        {selected.reportedOnline === false && <p className="ic-notice">The source catalogue reports this camera offline.</p>}
        <div className="ic-orientation"><span>{selected.viewDirection === undefined ? "Direction unavailable" : `Reported bearing ${Math.round(selected.viewDirection)}°`}</span><span>View metadata: {stamp(selected.viewUpdatedAt)}</span>{onSelectCamera && <button type="button" onClick={() => callbacks.current.onSelectCamera?.(selected)}><MapPin size={12} /> Locate on map</button>}</div>
        <p className="ic-note">Camera direction and view sectors can lag images. A mapped sector does not guarantee an unobstructed view.</p>
        <div className="ic-camera-list" aria-label="Nearby camera choices">{cameras.map((camera) => <button type="button" key={camera.id} className={selected.id === camera.id ? "ic-selected" : ""} onClick={() => choose(camera)} aria-pressed={selected.id === camera.id}><CameraIcon size={15} /><span><strong>{camera.name}</strong><small>{camera.distanceKm.toFixed(1)} km{camera.imageStatus === "unavailable" ? " · image unavailable" : camera.freshness === "stale" ? " · older frame" : ""}</small></span></button>)}</div>
      </>}
    </>}
    <div className="ic-footer"><a href={CAMERA_SOURCE} target="_blank" rel="noreferrer">{CAMERA_ATTRIBUTION} <ArrowUpRight size={11} /></a><a href={CAMERA_LICENSE} target="_blank" rel="noreferrer">CC BY-NC-ND 4.0</a><span>{data ? `Source checked ${stamp(data.fetchedAt)}` : "California camera coverage"}</span><span>{visible ? "Checks every 15 seconds while visible" : "Refresh paused while hidden"} · still images</span></div>
    <style>{`
      .incident-cameras{padding:20px;min-width:0;color:var(--text,#e5e6e7)}
      .incident-cameras .ic-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
      .incident-cameras .section-kicker{display:flex;align-items:center;gap:7px}
      .incident-cameras h3{font-size:22px;letter-spacing:-.6px;margin:8px 0}
      .incident-cameras .ic-intro,.incident-cameras .ic-note{font-size:12px;line-height:1.6;color:#9a9da3;margin:7px 0 14px}
      .incident-cameras a{color:#b5b7bc;text-decoration:none;display:inline-flex;gap:5px;align-items:center}
      .incident-cameras a:hover{text-decoration:underline}
      .incident-cameras .ic-refresh{border:1px solid #373a3f;background:#1c1d20;color:#cbcdd0;border-radius:8px;padding:9px;cursor:pointer}
      .incident-cameras .ic-refresh:disabled{opacity:.5}
      .incident-cameras .ic-empty{padding:24px 14px;text-align:center;border:1px dashed #373a3f;border-radius:9px;color:#acafb4;font-size:13px;line-height:1.6}
      .incident-cameras .ic-empty>svg{margin:auto}
      .incident-cameras .ic-view-title{display:flex;justify-content:space-between;gap:9px;align-items:flex-start;margin:16px 0 10px}
      .incident-cameras .ic-view-title strong{display:block;font-size:15px}
      .incident-cameras .ic-view-title small{display:block;color:#91959c;font-size:11px;margin-top:4px;text-transform:capitalize}
      .incident-cameras .ic-status{font-size:10px;line-height:1.4;padding:4px 7px;border-radius:5px;background:#2a2c31;color:#c3c5c9;text-align:right;flex-shrink:0;max-width:120px}
      .incident-cameras .ic-stale,.incident-cameras .ic-unknown,.incident-cameras .ic-future{background:#3a3020;color:#dfbd80}
      .incident-cameras .ic-image-wrap{background:#020504;border:1px solid #36393f;border-radius:7px;overflow:hidden;min-height:125px}
      .incident-cameras .ic-image-wrap>a{display:block;width:100%}
      .incident-cameras .ic-image-wrap img{display:block;width:100%;height:auto;max-height:440px;object-fit:contain}
      .incident-cameras .ic-image-missing{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;min-height:180px;padding:20px;color:#a3a6ac;font-size:12px;text-align:center}
      .incident-cameras .ic-image-meta{display:flex;justify-content:space-between;gap:12px;padding:10px 0;font-size:11px}
      .incident-cameras .ic-image-meta span{display:block;color:#8f9299;margin-bottom:3px}
      .incident-cameras .ic-image-meta strong{font-weight:500;color:#d8d9db}
      .incident-cameras .ic-notice{font-size:12px;line-height:1.6;background:#30291b;border:1px solid #574629;color:#e0c69b;padding:10px 12px;border-radius:6px;margin:10px 0}
      .incident-cameras .ic-error{background:#342321;border-color:#64423b;color:#e2b5aa}
      .incident-cameras .ic-notice button{display:block;border:0;background:transparent;text-decoration:underline;color:inherit;padding:6px 0 0;cursor:pointer}
      .incident-cameras .ic-orientation{display:flex;flex-wrap:wrap;gap:5px 12px;font-size:10px;color:#90949b;line-height:1.7}
      .incident-cameras .ic-orientation button{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;color:#b3b6bb;padding:0;cursor:pointer}
      .incident-cameras .ic-camera-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:13px}
      .incident-cameras .ic-camera-list button{display:flex;gap:8px;align-items:center;text-align:left;min-width:0;padding:9px;border-radius:7px;border:1px solid #2f3237;background:#17181b;color:#bbbdc2;cursor:pointer}
      .incident-cameras .ic-camera-list button.ic-selected{border-color:#787c85;background:#282a2d}
      .incident-cameras .ic-camera-list button>svg{flex-shrink:0}
      .incident-cameras .ic-camera-list strong{font-size:11px;display:block;overflow-wrap:anywhere;font-weight:500}
      .incident-cameras .ic-camera-list small{font-size:10px;color:#90939a;display:block;margin-top:3px}
      .incident-cameras .ic-footer{display:flex;flex-wrap:wrap;gap:7px 12px;border-top:1px solid #2f3237;padding-top:12px;margin-top:16px;font-size:9px;line-height:1.5;color:#848890}
      .incident-cameras .ic-footer>span{flex-basis:100%}
      @media(max-width:430px){.incident-cameras{padding:15px}.incident-cameras .ic-camera-list{grid-template-columns:1fr}.incident-cameras .ic-view-title{flex-wrap:wrap}}
    `}</style>
  </section>;
}
