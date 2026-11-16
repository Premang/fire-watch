"use client";

import { useEffect, useRef, useState } from "react";

export type FirePoint = {
  id: string;
  lat: number;
  lon: number;
  sensor: string;
  acquiredAt: string;
  frp: number | null;
  confidence: string | number | null;
};

export type FireBounds = { west: number; south: number; east: number; north: number };

export type MapGeometryLayer = {
  id: string; data: object; label: string; color: string;
  fillOpacity?: number; weight?: number; dashArray?: string;
  featureLabel?: (properties: Record<string, unknown>) => string;
};
export type MapLocation = { id: string; lat: number; lon: number; label: string; kind?: "camera" | "incident" };

export type FireMapProps = {
  points: FirePoint[];
  bounds?: FireBounds;
  onBoundsChange?: (bounds: FireBounds) => void;
  onSelectPoint?: (point: FirePoint) => void;
  selectedId?: string | null;
  showHotspots?: boolean;
  satellite: boolean;
  selectedBoundary?: object | null;
  colorByAge?: boolean;
  /** ISO timestamp with Z or an explicit UTC offset; also excludes future points. */
  referenceTime?: string;
  recentWindowMinutes?: number;
  radiusScale?: number;
  /** Changes explicitly recenter the map; data refreshes do not. */
  focusPoint?: { lat: number; lon: number; zoom?: number };
  /** Describes a selected location; this marker is not a satellite detection. */
  focusLabel?: string;
  className?: string;
  geometryLayers?: MapGeometryLayer[];
  locations?: MapLocation[];
  selectedLocationId?: string | null;
  onSelectLocation?: (location: MapLocation) => void;
  fitKey?: number | string;
  /** Called with the clicked position; used for drawing on the map. */
  onMapClick?: (lat: number, lon: number) => void;
};

type LatLng = [number, number];
type LeafletBounds = {
  getWest(): number;
  getSouth(): number;
  getEast(): number;
  getNorth(): number;
};
type LeafletLayer = {
  addTo(target: LeafletMap | LeafletGroup): LeafletLayer;
  remove(): void;
  on(event: string, callback: () => void): LeafletLayer;
  bindTooltip(content: HTMLElement, options?: Record<string, unknown>): LeafletLayer;
};
type LeafletGroup = LeafletLayer & { clearLayers(): void };
type LeafletMap = {
  createPane(name: string): HTMLElement;
  stop(): LeafletMap;
  setView(center: LatLng, zoom: number, options?: Record<string, unknown>): LeafletMap;
  fitBounds(bounds: [LatLng, LatLng], options?: Record<string, unknown>): LeafletMap;
  getBounds(): LeafletBounds;
  invalidateSize(options?: Record<string, unknown>): void;
  on(event: string, callback: (event: { latlng?: { lat: number; lng: number } }) => void): void;
  off(event: string, callback: () => void): void;
  remove(): void;
};
type Leaflet = {
  map(element: HTMLElement, options?: Record<string, unknown>): LeafletMap;
  layerGroup(): LeafletGroup;
  tileLayer(url: string, options: Record<string, unknown>): LeafletLayer;
  circleMarker(position: LatLng, options: Record<string, unknown>): LeafletLayer;
  geoJSON(data: object, options?: Record<string, unknown>): LeafletLayer;
  control: {
    zoom(options?: Record<string, unknown>): { addTo(map: LeafletMap): void };
    scale(options?: Record<string, unknown>): { addTo(map: LeafletMap): void };
  };
};

let leafletPromise: Promise<Leaflet> | null = null;
const getLeaflet = () => (window as Window & { L?: Leaflet }).L;

// One shared loader also handles React StrictMode's mount / cleanup / remount cycle.
function loadLeaflet(): Promise<Leaflet> {
  if (leafletPromise) return leafletPromise;
  const asset = (kind: "script" | "style", url: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const id = `ember-leaflet-${kind}`;
      const previous = document.getElementById(id) as HTMLScriptElement | HTMLLinkElement | null;
      if (previous?.dataset.loaded === "true") return resolve();
      const element = previous ?? document.createElement(kind === "script" ? "script" : "link");
      const timeout = window.setTimeout(fail, 18000);
      function cleanup() {
        window.clearTimeout(timeout);
        element.removeEventListener("load", done);
        element.removeEventListener("error", fail);
      }
      function done() {
        cleanup();
        element.dataset.loaded = "true";
        resolve();
      }
      function fail() {
        cleanup();
        element.remove();
        reject(new Error("Map assets could not be loaded. Check your connection and try again."));
      }
      element.addEventListener("load", done);
      element.addEventListener("error", fail);
      if (!previous) {
        element.id = id;
        if (element instanceof HTMLScriptElement) {
          element.src = url;
          element.async = true;
        } else {
          element.rel = "stylesheet";
          element.href = url;
        }
        document.head.appendChild(element);
      }
    });

  leafletPromise = Promise.all([
    asset("style", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"),
    getLeaflet() ? Promise.resolve() : asset("script", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"),
  ]).then(() => {
    const leaflet = getLeaflet();
    if (!leaflet) throw new Error("The map library did not initialize. Please try again.");
    return leaflet;
  }).catch((error: unknown) => {
    leafletPromise = null;
    throw error;
  });
  return leafletPromise;
}

function validBounds(bounds: FireBounds): boolean {
  return Object.values(bounds).every(Number.isFinite) &&
    bounds.south < bounds.north && bounds.west < bounds.east &&
    bounds.south >= -85 && bounds.north <= 85;
}

const asLeafletBounds = (bounds: FireBounds): [LatLng, LatLng] => [
  [bounds.south, bounds.west], [bounds.north, bounds.east],
];

function zonedTimestamp(value: string): number | null {
  // Never interpret a bare time in the browser's local timezone.
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(value)) return null;
  const calendarDay = value.slice(0, 10);
  const dayCheck = new Date(`${calendarDay}T00:00:00Z`);
  if (!Number.isFinite(dayCheck.getTime()) || dayCheck.toISOString().slice(0, 10) !== calendarDay) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export default function FireMap({
  points, bounds, onBoundsChange, onSelectPoint, selectedId,
  showHotspots = true, satellite, selectedBoundary, className = "",
  colorByAge = false, referenceTime, recentWindowMinutes = 60, radiusScale = 1, focusPoint, focusLabel,
  geometryLayers, locations, selectedLocationId, onSelectLocation, fitKey, onMapClick,
}: FireMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<Leaflet | null>(null);
  const pointLayerRef = useRef<LeafletGroup | null>(null);
  const boundsRef = useRef(bounds);
  const callbacksRef = useRef({ onBoundsChange, onSelectPoint, onSelectLocation, onMapClick });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tileError, setTileError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const parsedReferenceTime = referenceTime === undefined ? undefined : zonedTimestamp(referenceTime);

  useEffect(() => { boundsRef.current = bounds; }, [bounds]);
  useEffect(() => {
    callbacksRef.current = { onBoundsChange, onSelectPoint, onSelectLocation, onMapClick };
  }, [onBoundsChange, onSelectPoint, onSelectLocation, onMapClick]);

  useEffect(() => {
    let canceled = false;
    let ownedMap: LeafletMap | null = null;
    let observer: ResizeObserver | null = null;
    let frame = 0;
    loadLeaflet().then((leaflet) => {
      if (canceled || !containerRef.current) return;
      leafletRef.current = leaflet;
      const map = leaflet.map(containerRef.current, {
        zoomControl: false, attributionControl: true, preferCanvas: true,
        minZoom: 3, maxZoom: 18, worldCopyJump: true, zoomSnap: 0.5,
      });
      ownedMap = map;
      mapRef.current = map;
      map.createPane("fire-observations").style.zIndex = "610";
      map.createPane("fire-cameras").style.zIndex = "620";
      if (boundsRef.current && validBounds(boundsRef.current)) {
        map.fitBounds(asLeafletBounds(boundsRef.current), { padding: [28, 28], animate: false });
      } else {
        map.setView([38.2, -98.6], 4);
      }
      leaflet.control.zoom({ position: "bottomright" }).addTo(map);
      leaflet.control.scale({ position: "bottomleft", imperial: true, metric: true }).addTo(map);
      const pointLayer = leaflet.layerGroup();
      pointLayer.addTo(map);
      pointLayerRef.current = pointLayer;
      map.on("click", (event) => { if (!canceled && event.latlng) callbacksRef.current.onMapClick?.(event.latlng.lat, event.latlng.lng); });
      map.on("moveend", () => {
        if (canceled) return;
        const next = map.getBounds();
        callbacksRef.current.onBoundsChange?.({
          west: next.getWest(), south: next.getSouth(),
          east: next.getEast(), north: next.getNorth(),
        });
      });
      observer = new ResizeObserver(() => {
        window.cancelAnimationFrame(frame);
        frame = window.requestAnimationFrame(() => {
          if (!canceled) map.invalidateSize({ pan: true, animate: false });
        });
      });
      observer.observe(containerRef.current);
      setReady(true);
    }).catch((failure: unknown) => {
      if (!canceled) setError(failure instanceof Error ? failure.message : "The map is unavailable.");
    });
    return () => {
      canceled = true;
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
      ownedMap?.remove();
      if (mapRef.current === ownedMap) {
        mapRef.current = null;
        pointLayerRef.current = null;
      }
    };
  }, [attempt]);

  useEffect(() => {
    const map = mapRef.current;
    const leaflet = leafletRef.current;
    if (!ready || !map || !leaflet) return;
    let active = true;
    let errors = 0;
    const layer = leaflet.tileLayer(
      satellite
        ? "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        : "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 18, maxNativeZoom: satellite ? 18 : 16, crossOrigin: true,
        attribution: satellite
          ? 'Imagery © <a href="https://www.esri.com/" target="_blank" rel="noopener noreferrer">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community'
          : '© <a href="https://www.esri.com/" target="_blank" rel="noopener noreferrer">Esri</a>, HERE, Garmin, <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>, and the GIS User Community',
      },
    );
    layer.on("tileerror", () => { if (active && ++errors >= 3) setTileError(true); });
    layer.on("tileload", () => { if (active) { errors = 0; setTileError(false); } });
    layer.addTo(map);
    // Place names and borders sit on top of either base, so imagery stays readable.
    const labels = leaflet.tileLayer(
      satellite
        ? "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
        : "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 18, maxNativeZoom: satellite ? 18 : 16, crossOrigin: true },
    );
    labels.addTo(map);
    return () => { active = false; labels.remove(); layer.remove(); };
  }, [satellite, ready, attempt]);

  const west = bounds?.west, south = bounds?.south, east = bounds?.east, north = bounds?.north;
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || west === undefined || south === undefined || east === undefined || north === undefined) return;
    const next = { west, south, east, north };
    if (!validBounds(next)) return;
    const current = map.getBounds();
    // A parent can echo viewport changes back without repeatedly fitting / zooming.
    const unchanged = Math.abs(current.getWest() - west) < 0.00001 &&
      Math.abs(current.getSouth() - south) < 0.00001 &&
      Math.abs(current.getEast() - east) < 0.00001 &&
      Math.abs(current.getNorth() - north) < 0.00001;
    if (!unchanged) map.fitBounds(asLeafletBounds(next), { padding: [28, 28], animate: false });
  }, [west, south, east, north, ready, fitKey]);

  const focusLat = focusPoint?.lat, focusLon = focusPoint?.lon, focusZoom = focusPoint?.zoom ?? 9;
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || focusLat === undefined || focusLon === undefined ||
      !Number.isFinite(focusLat) || !Number.isFinite(focusLon) || !Number.isFinite(focusZoom) ||
      Math.abs(focusLat) > 85 || Math.abs(focusLon) > 180) return;
    // Measure the settled layout before focusing; preserve the geographic
    // center when the responsive map changes dimensions.
    const frame = window.requestAnimationFrame(() => {
      map.stop();
      map.invalidateSize({ pan: true, animate: false });
      map.setView([focusLat, focusLon], Math.max(3, Math.min(18, focusZoom)), { animate: false });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusLat, focusLon, focusZoom, ready]);

  // A separate unfilled blue ring identifies the selected location without
  // contributing a fabricated point to the thermal observation layer.
  useEffect(() => {
    const map = mapRef.current;
    const leaflet = leafletRef.current;
    if (!ready || !map || !leaflet || focusLat === undefined || focusLon === undefined ||
      !Number.isFinite(focusLat) || !Number.isFinite(focusLon) ||
      Math.abs(focusLat) > 85 || Math.abs(focusLon) > 180) return;
    const focusLayer = leaflet.layerGroup();
    focusLayer.addTo(map);
    const tooltip = document.createElement("div");
    tooltip.textContent = focusLabel ?? "Selected location";
    leaflet.circleMarker([focusLat, focusLon], {
      radius: 15, color: "#68baff", weight: 2.5, opacity: 1,
      fill: false, dashArray: "4 3", bubblingMouseEvents: false,
    }).bindTooltip(tooltip, {
      direction: "top", offset: [0, -16], className: "ember-map-tooltip",
    }).addTo(focusLayer);
    return () => { focusLayer.clearLayers(); focusLayer.remove(); };
  }, [focusLat, focusLon, focusLabel, ready, attempt]);

  useEffect(() => {
    const leaflet = leafletRef.current;
    const group = pointLayerRef.current;
    if (!ready || !leaflet || !group) return;
    group.clearLayers();
    if (!showHotspots || parsedReferenceTime === null) return;
    const cutoff = parsedReferenceTime ?? (colorByAge ? Date.now() : null);
    const recentMinutes = Number.isFinite(recentWindowMinutes) && recentWindowMinutes > 0 ? recentWindowMinutes : 60;
    const scale = Number.isFinite(radiusScale) && radiusScale > 0 ? Math.max(0.1, Math.min(4, radiusScale)) : 1;
    const drawPoints = points.map((point) => ({ point, acquired: zonedTimestamp(point.acquiredAt) }));
    // Recent observations remain visible above the older, fainter points.
    if (colorByAge) drawPoints.sort((a, b) => (a.acquired ?? -Infinity) - (b.acquired ?? -Infinity));
    drawPoints.forEach(({ point, acquired }) => {
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) return;
      if (cutoff !== null && (acquired === null || acquired > cutoff)) return;
      const ageMinutes = cutoff !== null && acquired !== null ? (cutoff - acquired) / 60000 : null;
      const selected = point.id === selectedId;
      const sensor = point.sensor.toUpperCase();
      const sensorColor = sensor.includes("MODIS") ? "#f3c66a" : sensor.includes("GOES") ? "#73cfca" : "#ff814a";
      const recent = ageMinutes !== null && ageMinutes <= recentMinutes;
      const withinSixHours = ageMinutes !== null && ageMinutes <= 360;
      const color = colorByAge ? recent ? "#ff984d" : withinSixHours ? "#d9ae64" : "#72767e" : sensorColor;
      const fillOpacity = !colorByAge ? 0.82 : recent ? 0.95 : withinSixHours ? 0.64 : ageMinutes !== null && ageMinutes <= 1440 ? 0.32 : 0.18;
      const opacity = !colorByAge ? 1 : recent ? 1 : withinSixHours ? 0.8 : ageMinutes !== null && ageMinutes <= 1440 ? 0.45 : 0.25;
      const radius = Math.max(3.3, Math.min(7.5, 3.3 + Math.sqrt(Math.max(0, point.frp ?? 0)) / 8)) * scale;
      if (selected) leaflet.circleMarker([point.lat, point.lon], {
        pane: "fire-observations", radius: radius + 7 * scale, color: "#fff1cc", weight: 1.4, opacity: 0.85,
        fillOpacity: 0.08, fillColor: color, interactive: false,
      }).addTo(group);
      const tooltip = document.createElement("div");
      const when = acquired === null ? null : new Date(acquired);
      tooltip.textContent = `${point.sensor} · ${when === null ? `${point.acquiredAt} (unverified time)` : when.toLocaleString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " UTC"}${point.frp == null ? "" : ` · ${point.frp.toFixed(1)} MW`}`;
      leaflet.circleMarker([point.lat, point.lon], {
        pane: "fire-observations", radius, color: selected ? "#fff3da" : color, weight: (selected ? 1.6 : 0.6) * Math.min(1, scale),
        fillColor: color, fillOpacity, opacity, bubblingMouseEvents: false,
      }).bindTooltip(tooltip, { direction: "top", offset: [0, -5], className: "ember-map-tooltip" })
        .on("click", () => callbacksRef.current.onSelectPoint?.(point)).addTo(group);
    });
    return () => group.clearLayers();
  }, [points, selectedId, showHotspots, ready, colorByAge, parsedReferenceTime, recentWindowMinutes, radiusScale]);

  useEffect(() => {
    const map = mapRef.current;
    const leaflet = leafletRef.current;
    if (!ready || !map || !leaflet || !selectedBoundary) return;
    let boundary: LeafletLayer | undefined;
    try {
      boundary = leaflet.geoJSON(selectedBoundary, {
        style: { color: "#f2c878", weight: 2, fillColor: "#f2a349", fillOpacity: 0.08, dashArray: "5 5" },
        interactive: false,
      });
      boundary.addTo(map);
    } catch {
      // Malformed optional geometry must not take down the observed hotspot map.
      console.warn("The selected boundary could not be drawn.");
    }
    return () => boundary?.remove();
  }, [selectedBoundary, ready]);

  useEffect(() => {
    const map = mapRef.current, leaflet = leafletRef.current;
    if (!ready || !map || !leaflet || !geometryLayers?.length) return;
    const group = leaflet.layerGroup();
    group.addTo(map);
    for (const entry of geometryLayers) {
      try {
        leaflet.geoJSON(entry.data, {
          style: { color: entry.color, weight: entry.weight ?? 1.6, fillColor: entry.color,
            fillOpacity: entry.fillOpacity ?? .12, dashArray: entry.dashArray, lineCap: "round" },
          onEachFeature: (feature: { properties?: Record<string, unknown> }, layer: LeafletLayer) => {
            const tooltip = document.createElement("div");
            tooltip.textContent = entry.featureLabel ? entry.featureLabel(feature.properties ?? {}) : entry.label;
            layer.bindTooltip(tooltip, { sticky: true, className: "ember-map-tooltip" });
          },
        }).addTo(group);
      } catch { console.warn("A map observation layer could not be displayed."); }
    }
    return () => { group.clearLayers(); group.remove(); };
  }, [geometryLayers, ready, attempt]);

  useEffect(() => {
    const map = mapRef.current, leaflet = leafletRef.current;
    if (!ready || !map || !leaflet || !locations?.length) return;
    const group = leaflet.layerGroup(); group.addTo(map);
    for (const location of locations) {
      if (!Number.isFinite(location.lat) || !Number.isFinite(location.lon) || Math.abs(location.lat) > 85 || Math.abs(location.lon) > 180) continue;
      const selected = selectedLocationId === location.id;
      const tooltip = document.createElement("div"); tooltip.textContent = location.label;
      leaflet.circleMarker([location.lat, location.lon], {
        pane: "fire-cameras", radius: selected ? 8 : 5, color: selected ? "#fff4d2" : "#79b8cf", weight: 1.7,
        fillColor: location.kind === "camera" ? "#559ebc" : "#142f39", fillOpacity: .9,
      }).bindTooltip(tooltip, { direction: "top", className: "ember-map-tooltip" })
        .on("click", () => callbacksRef.current.onSelectLocation?.(location)).addTo(group);
    }
    return () => { group.clearLayers(); group.remove(); };
  }, [locations, selectedLocationId, ready, attempt]);

  return (
    <div className={`ember-fire-map ${className}`} style={{ position: "relative", height: "100%", minHeight: 320, width: "100%", background: "#121b21", isolation: "isolate" }}>
      <div ref={containerRef} aria-label="Interactive map of satellite fire detections. Use arrow keys to pan and plus or minus to zoom." style={{ position: "absolute", inset: 0, zIndex: 0 }} />
      {!ready && !error && <div role="status" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#c9d1d4", fontSize: 13 }}>Loading observation map…</div>}
      {error && <div role="alert" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 32, textAlign: "center", color: "#e5e7e7" }}>
        <p style={{ maxWidth: 340, margin: 0, fontSize: 14 }}>{error}</p>
        <button type="button" onClick={() => { setError(null); setReady(false); setAttempt((value) => value + 1); }} style={{ background: "#e4af6c", color: "#141a1d", border: 0, borderRadius: 6, padding: "9px 18px", cursor: "pointer", fontWeight: 600 }}>Retry map</button>
      </div>}
      {ready && tileError && <div role="status" style={{ position: "absolute", top: 74, left: "50%", transform: "translateX(-50%)", zIndex: 500, maxWidth: "80%", border: "1px solid #79613e", borderRadius: 6, background: "#202019", color: "#f3d5a4", padding: "8px 12px", fontSize: 12 }}>Some basemap tiles are unavailable. Observations remain visible.</div>}
      {ready && parsedReferenceTime === null && <div role="status" style={{ position: "absolute", top: 74, left: "50%", transform: "translateX(-50%)", zIndex: 500, maxWidth: "80%", border: "1px solid #79613e", borderRadius: 6, background: "#202019", color: "#f3d5a4", padding: "8px 12px", fontSize: 12 }}>Detections hidden: reference time needs a valid timestamp with a timezone.</div>}
      <style>{`
        .ember-fire-map .leaflet-container { background: #121b21; font-family: inherit; }
        .ember-fire-map .leaflet-control-attribution { background: rgba(17,25,30,.92); color: #a5b2b9; font-size: 9px; padding: 3px 7px; }
        .ember-fire-map .leaflet-control-attribution a { color: #bbc8ce; }
        .ember-fire-map .leaflet-control-zoom { border: 1px solid #3b484e; box-shadow: 0 3px 12px #0004; border-radius: 6px; overflow: hidden; margin-right: 16px; margin-bottom: 16px; }
        .ember-fire-map .leaflet-control-zoom a { background: #17232a; color: #dce5e9; border-color: #3b484e; width: 31px; height: 31px; line-height: 30px; }
        .ember-fire-map .leaflet-control-zoom a:hover { background: #2c3a43; }
        .ember-fire-map .leaflet-control-zoom a.leaflet-disabled { color: #687780; }
        .ember-fire-map .leaflet-control-scale-line { background: rgba(20,30,36,.8); border-color: #9caeb7; color: #c3d0d6; text-shadow: none; font-size: 9px; }
        .ember-fire-map .leaflet-control-scale { margin-left: 18px; margin-bottom: 20px; }
        .ember-map-tooltip { background: #15252e; color: #ebedf0; border: 1px solid #4a5a64; border-radius: 5px; font-size: 11px; box-shadow: 0 4px 16px #0005; }
        .ember-map-tooltip.leaflet-tooltip-top:before { border-top-color: #4a5a64; }
      `}</style>
    </div>
  );
}
