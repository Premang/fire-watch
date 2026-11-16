"use client";

// Leaflet map for choosing an area of interest: rectangle / circle (two clicks) and polygon (clicks, then
// double-click or click the first vertex). Works with mouse and touch; Escape cancels. Keyboard users can
// use the Coordinates tab instead. Loads Leaflet 1.9.4 with the same element ids as components/fire-map.tsx.
import { useEffect, useRef, useState } from "react";
import type { Aoi } from "@/lib/harmonized/data";

export type DrawMode = "none" | "rectangle" | "polygon" | "circle";
export type ActivityCell = { lon: number; lat: number; v: number; sizeKm: number };

type LatLng = { lat: number; lng: number };
type Layer = { addTo(t: unknown): Layer; remove(): void; setLatLngs?(l: unknown): void; setBounds?(b: unknown): void; setRadius?(r: number): void; getBounds?(): Bounds };
type Bounds = { isValid(): boolean };
type LMap = {
  setView(c: [number, number], z: number): LMap; fitBounds(b: unknown, o?: object): LMap; on(e: string, f: (ev: { latlng: LatLng; originalEvent?: Event }) => void): void;
  off(e: string, f?: unknown): void; remove(): void; distance(a: LatLng, b: LatLng): number; invalidateSize(): void; doubleClickZoom: { disable(): void; enable(): void };
  getContainer(): HTMLElement; createPane(n: string): HTMLElement; latLngToContainerPoint(l: LatLng): { x: number; y: number };
};
type Leaflet = {
  map(el: HTMLElement, o?: object): LMap; tileLayer(u: string, o: object): Layer; polygon(l: unknown, o: object): Layer; polyline(l: unknown, o: object): Layer;
  rectangle(b: unknown, o: object): Layer; circle(c: unknown, o: object): Layer; circleMarker(c: unknown, o: object): Layer; geoJSON(d: object, o: object): Layer;
  layerGroup(): Layer & { clearLayers(): void }; canvas(o?: object): unknown; latLngBounds(a: unknown, b?: unknown): Bounds;
};

let leafletPromise: Promise<Leaflet> | null = null;
function loadLeaflet(): Promise<Leaflet> {
  const existing = (window as unknown as { L?: Leaflet }).L;
  if (existing) return Promise.resolve(existing);
  if (leafletPromise) return leafletPromise;
  const asset = (kind: "script" | "style", url: string) => new Promise<void>((resolve, reject) => {
    const id = `ember-leaflet-${kind}`;
    const prev = document.getElementById(id) as (HTMLScriptElement | HTMLLinkElement) | null;
    if (prev?.dataset.loaded === "true") return resolve();
    const el = prev ?? document.createElement(kind === "script" ? "script" : "link");
    const done = () => { el.dataset.loaded = "true"; resolve(); };
    el.addEventListener("load", done, { once: true }); el.addEventListener("error", () => reject(new Error("The map library could not load.")), { once: true });
    if (!prev) {
      el.id = id;
      if (kind === "script") { (el as HTMLScriptElement).src = url; (el as HTMLScriptElement).async = true; }
      else { (el as HTMLLinkElement).rel = "stylesheet"; (el as HTMLLinkElement).href = url; }
      document.head.appendChild(el);
    }
  });
  leafletPromise = Promise.all([asset("style", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"), asset("script", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js")])
    .then(() => { const L = (window as unknown as { L?: Leaflet }).L; if (!L) throw new Error("The map library did not initialize."); return L; })
    .catch(e => { leafletPromise = null; throw e; });
  return leafletPromise;
}

const AOI_STYLE = { color: "#f4a46e", weight: 2, fillColor: "#f4a46e", fillOpacity: 0.07 };
const DRAFT_STYLE = { color: "#ffe1b2", weight: 2, dashArray: "6 5", fillColor: "#ffe1b2", fillOpacity: 0.05 };

export default function AoiMap({ aoi, outline, drawMode, onDrawn, onCancelDraw, cells, fitKey, ariaLabel }: {
  aoi: Aoi | null; outline?: object | null; drawMode: DrawMode; onDrawn: (aoi: Aoi) => void; onCancelDraw: () => void; cells?: ActivityCell[]; fitKey?: string; ariaLabel?: string;
}) {
  const el = useRef<HTMLDivElement>(null), mapRef = useRef<LMap | null>(null), LRef = useRef<Leaflet | null>(null);
  const aoiLayer = useRef<Layer | null>(null), draftLayer = useRef<Layer | null>(null), cellLayer = useRef<(Layer & { clearLayers(): void }) | null>(null);
  const cellRenderer = useRef<unknown>(null);
  const [ready, setReady] = useState(false), [error, setError] = useState("");
  const draft = useRef<LatLng[]>([]);
  const onDrawnRef = useRef(onDrawn), onCancelRef = useRef(onCancelDraw);
  useEffect(() => { onDrawnRef.current = onDrawn; onCancelRef.current = onCancelDraw; });

  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then(L => {
      if (cancelled || !el.current || mapRef.current) return;
      LRef.current = L;
      const map = L.map(el.current, { zoomControl: true, worldCopyJump: true, minZoom: 2, attributionControl: true, scrollWheelZoom: false }).setView([-15, -55], 3);
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, attribution: "Basemap © Esri" }).addTo(map);
      // Place names sit above the activity overlay so they stay readable; the pane ignores the pointer.
      const labels = map.createPane("atlasLabels"); labels.style.zIndex = "450"; labels.style.pointerEvents = "none";
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, pane: "atlasLabels", updateWhenZooming: false, opacity: 0.9 }).addTo(map);
      cellLayer.current = L.layerGroup(); cellLayer.current.addTo(map); cellRenderer.current = null;
      mapRef.current = map; setReady(true);
    }).catch(e => !cancelled && setError(e instanceof Error ? e.message : "Map unavailable."));
    return () => { cancelled = true; mapRef.current?.remove(); mapRef.current = null; };
  }, []);

  // Draw the current AOI (preset outline or drawn geometry) and fit to it.
  useEffect(() => {
    const L = LRef.current, map = mapRef.current;
    if (!ready || !L || !map) return;
    aoiLayer.current?.remove(); aoiLayer.current = null;
    if (!aoi) return;
    let layer: Layer;
    if (outline) layer = L.geoJSON(outline, { style: () => AOI_STYLE });
    else if (aoi.kind === "circle") layer = L.circle([aoi.lat, aoi.lon], { ...AOI_STYLE, radius: aoi.radiusKm * 1000 });
    else layer = L.polygon(aoi.rings.map(p => p.map(r => r.map(([lon, lat]) => [lat, lon]))), AOI_STYLE);
    layer.addTo(map); aoiLayer.current = layer;
    const fit = () => { const b = layer.getBounds?.(); if (b?.isValid()) { map.invalidateSize(); map.fitBounds(b, { padding: [24, 24], maxZoom: 9, animate: false }); } };
    fit();
    // The panel can change size after the first fit (layout settling, responsive breakpoints): refit when it does.
    let last = "", raf = 0;
    const ro = new ResizeObserver(entries => { const r = entries[0].contentRect, k = `${Math.round(r.width)}x${Math.round(r.height)}`; if (k === last) return; last = k; cancelAnimationFrame(raf); raf = requestAnimationFrame(fit); });
    ro.observe(map.getContainer());
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [ready, aoi, outline, fitKey]);

  // Activity overlay: one square per tile cell, area-true size, colour by intensity.
  useEffect(() => {
    const L = LRef.current, group = cellLayer.current;
    if (!ready || !L || !group) return;
    group.clearLayers();
    if (!cells?.length) return;
    const max = Math.max(1, ...cells.map(c => c.v));
    const renderer = (cellRenderer.current ??= L.canvas({ padding: 0.3 })); // one shared canvas: a fresh one per update left redraws pending on a removed canvas
    for (const c of cells) {
      const t = Math.log1p(c.v) / Math.log1p(max), dLat = c.sizeKm / 2 / 111.2, dLon = c.sizeKm / 2 / (111.2 * Math.max(0.1, Math.cos(c.lat * Math.PI / 180)));
      L.rectangle([[c.lat - dLat, c.lon - dLon], [c.lat + dLat, c.lon + dLon]], { renderer, stroke: false, fillColor: `hsl(${40 - 32 * t} 95% ${32 + 34 * t}%)`, fillOpacity: 0.25 + 0.55 * t, interactive: false }).addTo(group);
    }
  }, [ready, cells]);

  // Drawing interaction.
  useEffect(() => {
    const L = LRef.current, map = mapRef.current;
    if (!ready || !L || !map || drawMode === "none") return;
    draft.current = []; draftLayer.current?.remove(); draftLayer.current = null;
    map.doubleClickZoom.disable();
    const container = map.getContainer(); container.style.cursor = "crosshair";
    const ring = (pts: LatLng[]) => pts.map(p => [p.lng, p.lat] as [number, number]);
    const finish = (a: Aoi) => { draftLayer.current?.remove(); draftLayer.current = null; draft.current = []; onDrawnRef.current(a); };
    const preview = (cursor: LatLng) => {
      const pts = draft.current;
      if (!pts.length) return;
      draftLayer.current?.remove();
      if (drawMode === "rectangle") draftLayer.current = L.rectangle([[pts[0].lat, pts[0].lng], [cursor.lat, cursor.lng]], DRAFT_STYLE).addTo(map);
      else if (drawMode === "circle") draftLayer.current = L.circle([pts[0].lat, pts[0].lng], { ...DRAFT_STYLE, radius: map.distance(pts[0], cursor) }).addTo(map);
      else draftLayer.current = L.polyline([...pts, cursor].map(p => [p.lat, p.lng]), DRAFT_STYLE).addTo(map);
    };
    const click = (ev: { latlng: LatLng }) => {
      const p = ev.latlng, pts = draft.current;
      if (drawMode === "rectangle") {
        if (!pts.length) { pts.push(p); return; }
        const a = pts[0], w = Math.min(a.lng, p.lng), e = Math.max(a.lng, p.lng), s = Math.min(a.lat, p.lat), n = Math.max(a.lat, p.lat);
        if (e - w < 1e-3 || n - s < 1e-3) return;
        finish({ kind: "polygon", label: "Drawn rectangle", rings: [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]] });
      } else if (drawMode === "circle") {
        if (!pts.length) { pts.push(p); return; }
        const r = Math.min(2000, map.distance(pts[0], p) / 1000); // same limit as the Coordinates form and share links
        if (r < 1) return;
        finish({ kind: "circle", label: `Drawn circle (${Math.round(r)} km radius)`, lon: pts[0].lng, lat: pts[0].lat, radiusKm: r });
      } else {
        const a = map.latLngToContainerPoint(pts[0] ?? p), b = map.latLngToContainerPoint(p);
        if (pts.length >= 3 && Math.hypot(a.x - b.x, a.y - b.y) < 12) {
          finish({ kind: "polygon", label: "Drawn polygon", rings: [[[...ring(pts), ring([pts[0]])[0]]]] }); return;
        }
        pts.push(p); preview(p);
      }
    };
    const dbl = () => {
      const pts = draft.current;
      if (drawMode === "polygon" && pts.length >= 3) finish({ kind: "polygon", label: "Drawn polygon", rings: [[[...ring(pts), ring([pts[0]])[0]]]] });
    };
    const move = (ev: { latlng: LatLng }) => preview(ev.latlng);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { draftLayer.current?.remove(); draftLayer.current = null; draft.current = []; onCancelRef.current(); } };
    map.on("click", click); map.on("dblclick", dbl); map.on("mousemove", move); document.addEventListener("keydown", key);
    return () => { map.off("click", click); map.off("dblclick", dbl); map.off("mousemove", move); document.removeEventListener("keydown", key); map.doubleClickZoom.enable(); container.style.cursor = ""; draftLayer.current?.remove(); draftLayer.current = null; };
  }, [ready, drawMode]);

  return <div className="atlas-map" ref={el} role="region" aria-label={ariaLabel ?? "Map of the selected area with its burning activity. To choose an area by keyboard, use the Place or Coordinates tabs."}>
    {error && <div className="atlas-empty" role="alert">{error}</div>}
  </div>;
}
