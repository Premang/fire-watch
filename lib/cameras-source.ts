// @ts-expect-error Explicit extension also permits direct Node integration tests.
import { allowedCameraImageUrl, capturedAtFromHeaders, cameraFreshness, cameraViewshed, nearCameraCoverage, normalizeCamera, CAMERA_ATTRIBUTION, CAMERA_LAYER, CAMERA_LICENSE, CAMERA_RADIUS_KM, CAMERA_SOURCE } from "./cameras.ts";
import type { Camera, CameraFeature, CameraResponse } from "./cameras";

type Fetcher = typeof fetch;
const catalogueCache = new Map<string, { at: number; cameras: Camera[] }>();
const fields = "OBJECTID,cameraName,siteId,isActive,isOnline,county,cameraURL,imageURL,positionPan,viewTime";

async function queryLayer(layer: 0 | 1, params: Record<string, string>, fetcher: Fetcher): Promise<{ features: CameraFeature[]; exceededTransferLimit?: boolean }> {
  const url = new URL(`${CAMERA_LAYER}/${layer}/query`);
  url.search = new URLSearchParams({ f: "json", outSR: "4326", returnGeometry: "true", ...params }).toString();
  const response = await fetcher(url, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Camera catalogue returned HTTP ${response.status}.`);
  const body = await response.json() as { features?: CameraFeature[]; error?: unknown; exceededTransferLimit?: boolean };
  if (body.error || !Array.isArray(body.features)) throw new Error("The camera catalogue returned an invalid response.");
  return { features: body.features, exceededTransferLimit: body.exceededTransferLimit };
}

async function discover(lat: number, lon: number, fetcher: Fetcher, now: number, useCache: boolean): Promise<Camera[]> {
  const key = `${lat},${lon}`;
  const cached = catalogueCache.get(key);
  if (useCache && cached && now - cached.at < 120_000) return cached.cameras;
  const cameras = new Map<string, Camera>();
  let complete = false;
  for (let page = 0; page < 30; page += 1) {
    const result = await queryLayer(0, {
      where: "isActive='active'", geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
      spatialRel: "esriSpatialRelIntersects", distance: String(CAMERA_RADIUS_KM), units: "esriSRUnit_Kilometer",
      outFields: fields, resultRecordCount: "50", resultOffset: String(page * 50), orderByFields: "OBJECTID ASC",
    }, fetcher);
    for (const feature of result.features) {
      const camera = normalizeCamera(feature, { lat, lon });
      if (camera && camera.distanceKm <= CAMERA_RADIUS_KM) cameras.set(camera.id, camera);
    }
    if (!result.exceededTransferLimit) { complete = true; break; }
    if (!result.features.length) break;
  }
  if (!complete) throw new Error("The camera catalogue was incomplete. Please try again.");
  const nearest = [...cameras.values()].sort((a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name)).slice(0, 6);
  if (useCache) {
    if (catalogueCache.size >= 20) catalogueCache.delete(catalogueCache.keys().next().value!);
    catalogueCache.set(key, { at: now, cameras: nearest });
  }
  return nearest;
}

/** Follow only documented public camera-image paths, never an arbitrary URL. */
export async function resolveCameraImage(camera: Camera, fetcher: Fetcher = fetch, checkedAt = new Date().toISOString()): Promise<Camera> {
  let url = allowedCameraImageUrl(camera.latestImageUrl);
  if (!url) return { ...camera, imageUrl: null, capturedAt: null, fileUpdatedAt: null, imageStatus: "unavailable", freshness: "unknown" };
  try {
    for (let redirect = 0; redirect < 4; redirect += 1) {
      const response: Response = await fetcher(url, { method: "HEAD", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (response.status >= 300 && response.status < 400) {
        const target: string | null = response.headers.get("location");
        url = target ? allowedCameraImageUrl(new URL(target, url).toString()) : null;
        if (!url) break;
        continue;
      }
      if (!response.ok) break;
      const capturedAt = capturedAtFromHeaders(response.headers);
      const modified = response.headers.get("last-modified");
      const fileUpdatedAt = modified && Number.isFinite(Date.parse(modified)) ? new Date(modified).toISOString() : null;
      return { ...camera, imageUrl: url, capturedAt, fileUpdatedAt, imageStatus: "available", freshness: cameraFreshness(capturedAt, checkedAt) };
    }
  } catch { /* One failed camera must not erase the other nearby views. */ }
  return { ...camera, imageUrl: null, capturedAt: null, fileUpdatedAt: null, imageStatus: "unavailable", freshness: "unknown" };
}

export async function loadNearbyCameras(lat: number, lon: number, options: { fetcher?: Fetcher; now?: () => number } = {}): Promise<CameraResponse> {
  const fetcher = options.fetcher ?? fetch, now = options.now ?? Date.now;
  const base = {
    radiusKm: CAMERA_RADIUS_KM, source: CAMERA_SOURCE, attribution: CAMERA_ATTRIBUTION, licenseUrl: CAMERA_LICENSE,
    coverageLabel: "ALERTCalifornia camera network · California and nearby border areas",
    warnings: ["Nearby cameras do not establish that this fire is visible. Camera direction, terrain, darkness, haze and smoke affect the view.", "Images can update ahead of orientation and viewshed metadata, which update approximately every two minutes."],
  };
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new RangeError("Valid latitude and longitude are required.");
  if (!nearCameraCoverage(lat, lon)) return { ...base, cameras: [], status: "outside-coverage", fetchedAt: new Date(now()).toISOString() };
  const nearest = await discover(lat, lon, fetcher, now(), options.fetcher === undefined);
  if (!nearest.length) return { ...base, cameras: [], status: "empty", fetchedAt: new Date(now()).toISOString() };
  const viewPromise = queryLayer(1, {
    where: `cameraURL IN (${nearest.map((camera) => `'${camera.sourceUrl.replace(/'/g, "''")}'`).join(",")})`,
    outFields: "cameraURL,viewTime,positionPan", resultRecordCount: "50",
  }, fetcher).catch(() => null);
  const cameras = await Promise.all(nearest.map((camera) => resolveCameraImage(camera, fetcher, new Date(now()).toISOString())));
  const views = await viewPromise;
  if (views) {
    for (const camera of cameras) {
      const view = views.features.find((feature) => feature.attributes?.cameraURL === camera.sourceUrl);
      if (view) camera.fieldOfView = cameraViewshed(view, camera);
    }
  } else base.warnings.push("The source viewshed layer is temporarily unavailable; camera images may still be available.");
  const fetchedAt = new Date(now()).toISOString();
  for (const camera of cameras) camera.freshness = cameraFreshness(camera.capturedAt, fetchedAt);
  return { ...base, cameras, status: "available", fetchedAt };
}
