"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Pause, Play, RefreshCw, X, ZoomIn, ZoomOut } from "lucide-react";

type Sector = "east" | "west";
type Product = "fire" | "geocolor";
type Frame = { url: string; observedAt: string; lastModified: string | null };
type Imagery = {
  frames: Frame[]; sector: string; sectorKey: Sector; satellite: string;
  product: Product; title: string; expectedCadenceMinutes: number;
  source: string; fetchedAt: string; sourceLastModified: string | null;
};

export type SatelliteViewerProps = {
  onClose: () => void;
  initialSector?: Sector;
  initialProduct?: Product;
};

function stamp(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${date.toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })} UTC` : "Timestamp unavailable";
}

function ageLabel(value: string, now: number) {
  const minutes = Math.floor((now - Date.parse(value)) / 60000);
  if (!Number.isFinite(minutes)) return "Age unavailable";
  if (minutes < 0) return "Timestamp is ahead of this device’s clock";
  if (minutes < 1) return "Less than 1 minute old";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} old`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m old`;
}

export default function SatelliteViewer({ onClose, initialSector = "east", initialProduct = "fire" }: SatelliteViewerProps) {
  const [sector, setSector] = useState<Sector>(initialSector);
  const [product, setProduct] = useState<Product>(initialProduct);
  const [data, setData] = useState<Imagery | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedUrl, setSelectedUrl] = useState("");
  const [followingLatest, setFollowingLatest] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [zoom, setZoom] = useState<1 | 2>(1);
  const [now, setNow] = useState(() => Date.now());
  const [failedImage, setFailedImage] = useState("");
  const modalRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const selectedUrlRef = useRef("");
  const followRef = useRef(true);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  const activeData = data?.sectorKey === sector && data.product === product ? data : null;
  const index = activeData ? Math.max(0, activeData.frames.findIndex((frame) => frame.url === selectedUrl)) : 0;
  const frame = activeData?.frames[index];
  const latestFrame = activeData?.frames[activeData.frames.length - 1];
  const stale = !!latestFrame && now - Date.parse(latestFrame.observedAt) > 20 * 60000;

  function selectFrame(url: string) { selectedUrlRef.current = url; setSelectedUrl(url); }
  function followLatest(value: boolean) { followRef.current = value; setFollowingLatest(value); }
  function changeFeed(nextSector: Sector, nextProduct: Product) {
    if (nextSector === sector && nextProduct === product) return;
    setSector(nextSector); setProduct(nextProduct); setPlaying(false); followLatest(true);
    selectFrame(""); setNotice(""); setError(""); setFailedImage(""); setZoom(1);
  }

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    async function refresh() {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      setLoading(true);
      try {
        const response = await fetch(`/api/imagery?sector=${sector}&product=${product}`, { signal: controller.signal, cache: "no-store" });
        const result = await response.json() as Imagery & { error?: string };
        if (!response.ok) throw new Error(result.error || "NOAA imagery is unavailable.");
        if (!result.frames?.length) throw new Error("NOAA returned an empty image sequence.");
        if (controller.signal.aborted) return;
        const previous = selectedUrlRef.current;
        const retained = result.frames.find((item) => item.url === previous);
        const next = followRef.current || !retained ? result.frames[result.frames.length - 1] : retained;
        if (!followRef.current && previous && !retained) setNotice("Your paused frame left NOAA’s rolling archive. Showing the latest available frame.");
        selectedUrlRef.current = next.url;
        setSelectedUrl(next.url); setData(result); setError(""); setNow(Date.now());
      } catch (failure: unknown) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to refresh NOAA imagery.");
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void Promise.resolve().then(refresh);
    const timer = window.setInterval(() => { void refresh(); }, 60000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [sector, product, reload]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!playing || !activeData) return;
    const timer = window.setTimeout(() => selectFrame(activeData.frames[(index + 1) % activeData.frames.length].url), 750);
    return () => window.clearTimeout(timer);
  }, [playing, activeData, index]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    modalRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key !== "Tab") return;
      const items = Array.from(modalRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), [tabindex='0']") ?? []);
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", listener);
    return () => { document.removeEventListener("keydown", listener); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, []);

  const sourcePage = sector === "west"
    ? `https://www.star.nesdis.noaa.gov/GOES/sector_band.php?sat=G18&sector=psw&band=${product === "fire" ? "FireTemperature" : "GEOCOLOR"}&length=24`
    : `https://www.star.nesdis.noaa.gov/GOES/conus_band.php?sat=G19&band=${product === "fire" ? "FireTemperature" : "GEOCOLOR"}&length=24`;

  return <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={modalRef} className="imagery-modal satellite-viewer" role="dialog" aria-modal="true" aria-label="Recent NOAA satellite imagery">
      <header><div><span className="section-kicker">NOAA / {product === "fire" ? "FIRE TEMPERATURE RGB" : "GEOCOLOR"}</span><h2>Watch from orbit.</h2></div><button className="icon-button" onClick={onClose} aria-label="Close satellite imagery"><X size={21} /></button></header>
      <div className="imagery-controls">
        <div className="segmented" aria-label="Satellite coverage">
          <button onClick={() => changeFeed("east", product)} aria-pressed={sector === "east"} className={sector === "east" ? "selected" : ""}>GOES-East · CONUS</button>
          <button onClick={() => changeFeed("west", product)} aria-pressed={sector === "west"} className={sector === "west" ? "selected" : ""}>GOES-West · Pacific Southwest</button>
        </div>
        <button className="icon-button" disabled={loading} aria-label="Refresh satellite frames" onClick={() => { setFailedImage(""); setReload((value) => value + 1); }}><RefreshCw size={16} className={loading ? "spin" : ""} /></button>
      </div>
      <div className="satellite-product-row">
        <div className="segmented" aria-label="Satellite product">
          <button onClick={() => changeFeed(sector, "fire")} aria-pressed={product === "fire"} className={product === "fire" ? "selected" : ""}>Fire Temperature RGB</button>
          <button onClick={() => changeFeed(sector, "geocolor")} aria-pressed={product === "geocolor"} className={product === "geocolor" ? "selected" : ""}>GeoColor · clouds & smoke</button>
        </div>
        <div className="satellite-zoom"><button className="icon-button" disabled={zoom === 1} aria-label="Fit whole satellite image" onClick={() => { setZoom(1); viewportRef.current?.scrollTo(0, 0); }}><ZoomOut size={15} /></button><span>{zoom}×</span><button className="icon-button" disabled={zoom === 2} aria-label="Enlarge satellite image to two times" onClick={() => setZoom(2)}><ZoomIn size={15} /></button></div>
      </div>
      <div className="satellite-status-row"><span><i className={`status-dot ${error || stale || !followingLatest ? "quiet" : ""}`} />{followingLatest ? "Following latest available" : playing ? "Playing recent frames" : "Paused on selected frame"}</span><span>Checks every 60s · nominal 5-minute frames</span></div>
      {error && <div role="status" className="satellite-warning">{error} {activeData ? "Retaining previously fetched frames; refresh status is stale." : "Try refreshing or choose another product."}</div>}
      {notice && <div role="status" className="satellite-warning">{notice}</div>}
      {stale && !error && <div role="status" className="satellite-warning">Latest available image is {ageLabel(latestFrame!.observedAt, now).toLowerCase()}. Source delivery may be delayed.</div>}
      <div ref={viewportRef} className={`satellite-screen satellite-pan ${zoom === 2 ? "zoomed" : ""}`} tabIndex={zoom === 2 ? 0 : -1} aria-label={zoom === 2 ? "Enlarged image. Scroll to pan horizontally and vertically." : "Satellite image"}>
        {frame ? <>
          {/* NOAA images are published products, displayed directly from their source. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={frame.url} alt={`${activeData!.satellite} ${activeData!.title}, ${activeData!.sector}, acquired ${stamp(frame.observedAt)}`} onError={() => setFailedImage(frame.url)} />
          {failedImage === frame.url && <div className="satellite-image-error" role="status">This NOAA image did not load. Try another frame or refresh.</div>}
        </> : <div className="loading-text">{error || "Retrieving NOAA image sequence…"}{error && <button className="button secondary" onClick={() => setReload((value) => value + 1)}>Retry imagery</button>}</div>}
      </div>
      {zoom === 2 && <p className="satellite-pan-hint">Scroll to pan the enlarged image. This is an image zoom, not a geolocated fire map.</p>}
      {activeData && frame && <>
        <div className="loop-controls">
          <button className="button primary" onClick={() => { followLatest(false); setNotice(""); setPlaying((value) => !value); }} aria-label={playing ? "Pause imagery loop" : "Play imagery loop"}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
          <input type="range" aria-label="Satellite acquisition frame" aria-valuetext={stamp(frame.observedAt)} min={0} max={activeData.frames.length - 1} value={index} onChange={(event) => { setPlaying(false); followLatest(false); setNotice(""); selectFrame(activeData.frames[Number(event.target.value)].url); }} />
          <span>{index + 1} / {activeData.frames.length}</span>
          <button type="button" className={`button satellite-latest ${followingLatest ? "is-live" : "secondary"}`} aria-pressed={followingLatest} onClick={() => { setPlaying(false); setNotice(""); followLatest(!followingLatest); if (!followingLatest) selectFrame(activeData.frames[activeData.frames.length - 1].url); }}>Latest {followingLatest ? "on" : "off"}</button>
        </div>
        <div className="loop-caption"><div><strong>{stamp(frame.observedAt)}</strong><small className="satellite-age">{ageLabel(frame.observedAt, now)}{!followingLatest ? " · selected frame" : ""}</small></div><a href={frame.url} target="_blank" rel="noreferrer">Open source image <ArrowUpRight size={13} /></a></div>
        <div className="satellite-fetch-time">{frame.lastModified ? `NOAA file updated ${stamp(frame.lastModified)} · ` : ""}Sequence checked {stamp(activeData.fetchedAt)}</div>
      </>}
      <div className="imagery-disclaimer">
        <p>{product === "fire" ? "Fire Temperature RGB combines infrared channels to highlight relative fire signals. Its colors are not a direct temperature measurement, a fire perimeter, or proof that every bright pixel is a wildfire. Clouds can obscure fires." : "GeoColor provides cloud and daytime smoke context. At night it combines infrared information with a static city-lights background; city lights are not live fire observations."}</p>
        <p>{sector === "west" ? "Coverage: Pacific Southwest, including California, Nevada and Arizona—not the entire western U.S. " : "Coverage: contiguous U.S. "}Alaska and Hawaii are outside these views. NOAA STAR imagery is informational and is not an operational emergency-response product.</p>
        <div className="satellite-source-links"><a href={sourcePage} target="_blank" rel="noreferrer">NOAA product & legend ↗</a><a href="https://www.star.nesdis.noaa.gov/GOES/documents/QuickGuide_Fire_Temperature_RGB.pdf" target="_blank" rel="noreferrer">Fire RGB quick guide ↗</a><a href="https://cameras.alertcalifornia.org/" target="_blank" rel="noreferrer">California ground cameras ↗</a></div>
      </div>
      <style>{`
        .satellite-viewer .satellite-product-row { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:0 25px 12px; }
        .satellite-viewer .satellite-zoom { display:flex; align-items:center; gap:9px; color:var(--muted); font:10px monospace; }
        .satellite-viewer .satellite-status-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:0 25px 13px; font-size:9px; color:#979aa1; }
        .satellite-viewer .satellite-status-row>span:first-child { display:flex; align-items:center; gap:7px; }
        .satellite-viewer .satellite-status-row>span:last-child { color:#6f737b; }
        .satellite-viewer .satellite-warning { color:#dec298; background:#322e1d; border-block:1px solid #54482f; padding:9px 25px; font-size:10px; line-height:1.5; }
        .satellite-viewer .satellite-pan { overflow:auto; position:relative; display:block; }
        .satellite-viewer .satellite-pan>img { position:relative; inset:auto; display:block; width:100%; height:100%; max-height:none; object-fit:contain; }
        .satellite-viewer .satellite-pan.zoomed>img { width:200%; height:200%; max-width:none; max-height:none; object-fit:contain; }
        .satellite-viewer .satellite-pan>.loading-text { min-height:100%; justify-content:center; padding:25px; text-align:center; }
        .satellite-viewer .satellite-image-error { position:absolute; inset:25% 15%; background:#1d1e21eb; display:grid; place-items:center; padding:20px; border:1px solid #4c5058; color:#c9cbce; font-size:12px; text-align:center; }
        .satellite-viewer .satellite-pan-hint { font-size:9px; color:#999ca2; background:#1f2124; padding:7px 25px; }
        .satellite-viewer .satellite-latest { height:32px; font-size:9px; white-space:nowrap; }
        .satellite-viewer .satellite-latest.is-live { color:#c3c5c8; background:#323439; border:1px solid #5f636a; }
        .satellite-viewer .satellite-age { display:block; font-size:9px; color:#91949b; margin-top:6px; }
        .satellite-viewer .satellite-fetch-time { padding:0 25px 15px; color:#6f737a; font:8px monospace; line-height:1.6; }
        .satellite-viewer .imagery-disclaimer p+p { margin-top:7px; }
        .satellite-viewer .satellite-source-links { display:flex; flex-wrap:wrap; gap:15px; margin-top:9px; }
        .satellite-viewer .satellite-source-links a { margin:0; }
        @media(max-width:550px){ .satellite-viewer .imagery-controls { gap:8px; } .satellite-viewer .imagery-controls .segmented button { font-size:7px; padding:8px 6px; } .satellite-viewer .satellite-product-row { padding:0 13px 12px; gap:8px; } .satellite-viewer .satellite-product-row .segmented button { font-size:7px; padding:7px 6px; } .satellite-viewer .satellite-zoom { gap:4px; } .satellite-viewer .satellite-zoom .icon-button { width:24px; height:25px; } .satellite-viewer .satellite-status-row { padding:0 14px 12px; align-items:flex-start; flex-direction:column; gap:6px; font-size:8px; } .satellite-viewer .satellite-warning { padding:9px 15px; font-size:9px; } .satellite-viewer .loop-controls { gap:8px; } .satellite-viewer .loop-controls .button { padding:0 9px; height:30px; } .satellite-viewer .loop-controls>span { font-size:8px; } .satellite-viewer .satellite-fetch-time { padding:0 17px 12px; font-size:7px; } .satellite-viewer .satellite-age { font-size:8px; } }
      `}</style>
    </section>
  </div>;
}
