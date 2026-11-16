export const CAMERA_SOURCE = "https://www.arcgis.com/home/item.html?id=0c1c1166688f4f2db938194799337be4";
export const CAMERA_LAYER = "https://services8.arcgis.com/X84q166Srnyl4JMV/arcgis/rest/services/ALERTCalifornia_Camera_Feed/FeatureServer";
export const CAMERA_ATTRIBUTION = "ALERTCalifornia | UC San Diego";
export const CAMERA_LICENSE = "https://creativecommons.org/licenses/by-nc-nd/4.0/";
export const CAMERA_RADIUS_KM = 100;

export type CameraFreshness = "recent" | "stale" | "unknown" | "future";
export interface CameraFieldOfView {
  type: "Feature";
  properties: { cameraId: string; viewUpdatedAt: string | null; source: string };
  geometry: { type: "Polygon"; coordinates: number[][][] };
}
export interface Camera {
  id: string;
  name: string;
  lat: number;
  lon: number;
  distanceKm: number;
  county: string;
  sourceUrl: string;
  /** The actual allowlisted URL from the source layer. */
  latestImageUrl: string;
  /** Immutable resolved image URL; null when the source image is unavailable. */
  imageUrl: string | null;
  /** Timestamp from the source image's explicit public metadata, never fetch time. */
  capturedAt: string | null;
  fileUpdatedAt: string | null;
  /** Orientation/viewshed metadata time; distinct from the image capture. */
  viewUpdatedAt: string | null;
  viewDirection?: number;
  fieldOfView?: CameraFieldOfView;
  reportedOnline: boolean | null;
  imageStatus: "available" | "unavailable";
  freshness: CameraFreshness;
}
export interface CameraResponse {
  cameras: Camera[];
  status: "available" | "empty" | "outside-coverage";
  fetchedAt: string;
  radiusKm: number;
  source: string;
  attribution: string;
  licenseUrl: string;
  coverageLabel: string;
  warnings: string[];
}
export interface CameraFeature {
  attributes?: Record<string, unknown>;
  geometry?: { x?: number; y?: number; rings?: number[][][] };
}

export function parseCameraLocation(params: URLSearchParams): { lat: number; lon: number } | null {
  const latitude = params.get("lat"), longitude = params.get("lon");
  if (!latitude?.trim() || !longitude?.trim()) return null;
  const lat = Number(latitude), lon = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

export function cameraDistanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * rad / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin((b.lon - a.lon) * rad / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

/** A broad California envelope plus the query radius, not a visibility claim. */
export function nearCameraCoverage(lat: number, lon: number): boolean {
  return cameraDistanceKm({ lat, lon }, { lat: Math.max(32.3, Math.min(42.1, lat)), lon: Math.max(-124.7, Math.min(-114, lon)) }) <= CAMERA_RADIUS_KM;
}

export function cameraTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = value.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T");
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(timestamp)) return null;
  const date = new Date(`${timestamp.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== timestamp.slice(0, 10)) return null;
  const parsed = new Date(timestamp);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function allowedCameraImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "cameras.alertcalifornia.org" || url.username || url.password || url.port || url.search || url.hash) return null;
    const sourceImage = /^\/public-camera-data\/[A-Za-z0-9._-]+\/latest-frame\.jpg$/;
    const resolvedImage = /^\/insight\/[A-Za-z0-9._-]+\/image\/\d{4}-\d{2}-\d{2}T\d{2}\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_\d+Z-[A-Za-z0-9]+\.jpg$/;
    return sourceImage.test(url.pathname) || resolvedImage.test(url.pathname) ? url.toString() : null;
  } catch { return null; }
}

function allowedCameraPage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const id = url.searchParams.get("id");
    return url.protocol === "https:" && url.hostname === "cameras.alertcalifornia.org" && !url.username && !url.password && !url.port && url.pathname === "/" && id && /^[A-Za-z0-9._-]+$/.test(id) ? url.toString() : null;
  } catch { return null; }
}

export function normalizeCamera(feature: CameraFeature, center: { lat: number; lon: number }): Camera | null {
  const a = feature.attributes ?? {}, lat = feature.geometry?.y, lon = feature.geometry?.x;
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const sourceUrl = allowedCameraPage(a.cameraURL), latestImageUrl = allowedCameraImageUrl(a.imageURL);
  if (!sourceUrl || !latestImageUrl || typeof a.cameraName !== "string" || !a.cameraName.trim()) return null;
  if (typeof a.isActive === "string" && a.isActive.toLowerCase() !== "active") return null;
  const sourceId = new URL(sourceUrl).searchParams.get("id")!;
  const direction = typeof a.positionPan === "number" && Number.isFinite(a.positionPan) && a.positionPan >= 0 && a.positionPan <= 360 ? a.positionPan % 360 : undefined;
  return {
    id: `alertcalifornia:${sourceId}`, name: a.cameraName.trim(), lat, lon,
    distanceKm: cameraDistanceKm(center, { lat, lon }), county: typeof a.county === "string" ? a.county : "",
    sourceUrl, latestImageUrl, imageUrl: null, capturedAt: null, fileUpdatedAt: null,
    viewUpdatedAt: cameraTimestamp(a.viewTime), ...(direction !== undefined ? { viewDirection: direction } : {}),
    reportedOnline: a.isOnline === "online" ? true : a.isOnline === "offline" ? false : null,
    imageStatus: "unavailable", freshness: "unknown",
  };
}

export function cameraFreshness(capturedAt: string | null, now: string): CameraFreshness {
  const capture = cameraTimestamp(capturedAt), checked = cameraTimestamp(now);
  if (!capture || !checked) return "unknown";
  const age = Date.parse(checked) - Date.parse(capture);
  if (age < -60_000) return "future";
  return age > 5 * 60_000 ? "stale" : "recent";
}

/** Parse only the public source-image timestamp; HTTP Date is not a capture time. */
export function capturedAtFromHeaders(headers: Headers): string | null {
  const context = headers.get("x-amz-meta-context");
  if (!context || context.length > 32_768) return null;
  try {
    const metadata = JSON.parse(context) as { headers?: Record<string, unknown> };
    const entry = Object.entries(metadata.headers ?? {}).find(([key]) => key.toLowerCase() === "x-data-context")?.[1];
    const encoded = Array.isArray(entry) ? entry[0] : entry;
    if (typeof encoded !== "string" || encoded.length > 16_384) return null;
    const image = JSON.parse(atob(encoded)) as { timestamp?: unknown };
    return cameraTimestamp(image.timestamp);
  } catch { return null; }
}

export function cameraViewshed(feature: CameraFeature, camera: Camera): CameraFieldOfView | undefined {
  const rings = feature.geometry?.rings;
  // This public layer publishes single-ring view sectors. Do not reinterpret
  // an unfamiliar multi-part geometry as a polygon with holes.
  if (!Array.isArray(rings) || rings.length !== 1 || rings[0].length < 4 || rings[0].length > 1000) return undefined;
  if (!rings[0].every((point) => Array.isArray(point) && point.length >= 2 && point.slice(0, 2).every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90)) return undefined;
  const coordinates = rings.map((ring) => ring.map((point) => point.slice(0, 2)));
  const first = coordinates[0][0], last = coordinates[0].at(-1)!;
  if (first[0] !== last[0] || first[1] !== last[1]) coordinates[0].push([...first]);
  return {
    type: "Feature", properties: { cameraId: camera.id, viewUpdatedAt: cameraTimestamp(feature.attributes?.viewTime), source: CAMERA_SOURCE },
    geometry: { type: "Polygon", coordinates },
  };
}
