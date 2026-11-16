import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node executes TypeScript directly; app imports use bundler resolution.
import { allowedCameraImageUrl, capturedAtFromHeaders, cameraFreshness, cameraTimestamp, cameraViewshed, nearCameraCoverage, normalizeCamera, parseCameraLocation } from "../lib/cameras.ts";
// @ts-expect-error Node executes TypeScript directly; app imports use bundler resolution.
import { loadNearbyCameras, resolveCameraImage } from "../lib/cameras-source.ts";
import type { Camera, CameraFeature } from "../lib/cameras";

const now = "2026-10-23T06:00:00.000Z";
const capture = "2026-10-23T05:59:48.322Z";
const image = "https://cameras.alertcalifornia.org/public-camera-data/Axis-DoeMillRd/latest-frame.jpg";
const immutable = "https://cameras.alertcalifornia.org/insight/doemillrd-cam01/image/2026-10-23T05/2026-10-23T05-59-48_000Z-84cb.jpg";
function feature(id = "Axis-DoeMillRd", lat = 39.8, lon = -121.6): CameraFeature {
  return { attributes: {
    OBJECTID: 1, cameraName: "Test fixture camera", cameraURL: `https://cameras.alertcalifornia.org/?id=${id}`,
    imageURL: `https://cameras.alertcalifornia.org/public-camera-data/${id}/latest-frame.jpg`,
    isActive: "active", isOnline: "online", positionPan: 70.5, viewTime: "2026-10-22 16:00:00-07:00", county: "butte",
  }, geometry: { x: lon, y: lat } };
}
function camera(): Camera { return normalizeCamera(feature(), { lat: 39.8, lon: -121.6 })!; }
function imageHeaders(timestamp = capture): Headers {
  return new Headers({
    "x-amz-meta-context": JSON.stringify({ headers: { "X-Data-Context": [btoa(JSON.stringify({ timestamp }))] } }),
    "last-modified": "Fri, 23 Oct 2026 05:59:49 GMT", date: "Fri, 23 Oct 2026 06:00:00 GMT",
  });
}
function urlOf(input: RequestInfo | URL): string { return input instanceof Request ? input.url : String(input); }

test("coordinates are validated without treating blanks as zero", () => {
  assert.deepEqual(parseCameraLocation(new URLSearchParams("lat=39.8&lon=-121.6")), { lat: 39.8, lon: -121.6 });
  for (const value of ["", "lat=&lon=-121", "lat=NaN&lon=0", "lat=91&lon=0", "lat=0&lon=181"]) assert.equal(parseCameraLocation(new URLSearchParams(value)), null);
  assert.equal(nearCameraCoverage(39.8, -121.6), true);
  assert.equal(nearCameraCoverage(30.3, -97.7), false);
});

test("image URL allowlist accepts observed public paths and rejects arbitrary hosts or encodings", () => {
  assert.equal(allowedCameraImageUrl(image), image);
  assert.equal(allowedCameraImageUrl(immutable), immutable);
  for (const value of ["https://example.com/camera.jpg", "https://cameras.alertcalifornia.org.evil.test/public-camera-data/Axis-A/latest-frame.jpg", "https://user@cameras.alertcalifornia.org/public-camera-data/Axis-A/latest-frame.jpg", image + "?redirect=https://example.com", image.replace("https:", "http:"), "https://cameras.alertcalifornia.org/private-camera/latest.jpg", image.replace("Axis-DoeMillRd", "%2e%2e")]) assert.equal(allowedCameraImageUrl(value), null);
});

test("camera normalization preserves source location and orientation time without inventing capture time", () => {
  const result = camera();
  assert.equal(result.lat, 39.8);
  assert.equal(result.distanceKm, 0);
  assert.equal(result.capturedAt, null);
  assert.equal(result.viewUpdatedAt, "2026-10-22T23:00:00.000Z");
  assert.equal(result.viewDirection, 70.5);
  assert.equal(result.imageUrl, null);
  assert.equal(normalizeCamera({ ...feature(), geometry: { x: -121, y: 100 } }, { lat: 39, lon: -121 }), null);
  const unsafe = feature(); unsafe.attributes!.imageURL = "https://example.com/image.jpg";
  assert.equal(normalizeCamera(unsafe, { lat: 39, lon: -121 }), null);
});

test("only explicit image metadata supplies capture time; HTTP check and file times do not", () => {
  assert.equal(capturedAtFromHeaders(imageHeaders()), capture);
  assert.equal(capturedAtFromHeaders(new Headers({ date: now, "last-modified": capture })), null);
  assert.equal(capturedAtFromHeaders(new Headers({ "x-amz-meta-context": "broken JSON" })), null);
  assert.equal(capturedAtFromHeaders(imageHeaders("2026-02-30T00:00:00Z")), null);
  assert.equal(cameraTimestamp("2026-10-22 22:59:48-07:00"), "2026-10-23T05:59:48.000Z");
  assert.equal(cameraTimestamp("2026-10-22 22:59:48"), null);
});

test("freshness uses source capture time and distinguishes stale, unknown, and future", () => {
  assert.equal(cameraFreshness(capture, now), "recent");
  assert.equal(cameraFreshness("2026-10-23T05:00:00Z", now), "stale");
  assert.equal(cameraFreshness(null, now), "unknown");
  assert.equal(cameraFreshness("2026-10-23T07:00:00Z", now), "future");
});

test("source-image redirects resolve only within the camera allowlist", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input); calls.push(url);
    assert.equal(init?.method, "HEAD"); assert.equal(init?.redirect, "manual");
    return url === image ? new Response(null, { status: 302, headers: { location: immutable } }) : new Response(null, { status: 200, headers: imageHeaders() });
  }) as typeof fetch;
  const result = await resolveCameraImage(camera(), fetcher, now);
  assert.deepEqual(calls, [image, immutable]);
  assert.equal(result.imageUrl, immutable);
  assert.equal(result.capturedAt, capture);
  assert.equal(result.fileUpdatedAt, "2026-10-23T05:59:49.000Z");
  assert.equal(result.imageStatus, "available");
  assert.equal(result.freshness, "recent");
});

test("unsafe redirects are never fetched and missing images remain explicitly unavailable", async () => {
  let calls = 0;
  const unsafe = (async () => { calls += 1; return new Response(null, { status: 302, headers: { location: "https://example.com/secret" } }); }) as typeof fetch;
  const result = await resolveCameraImage(camera(), unsafe, now);
  assert.equal(calls, 1);
  assert.equal(result.imageStatus, "unavailable");
  assert.equal(result.imageUrl, null);
  const missing = await resolveCameraImage(camera(), (async () => new Response(null, { status: 404 })) as typeof fetch, now);
  assert.equal(missing.capturedAt, null);
});

test("viewshed conversion retains source geometry and metadata instead of constructing a fake cone", () => {
  const source: CameraFeature = { attributes: { viewTime: "2026-10-22 22:58:00-07:00" }, geometry: { rings: [[[-121.6, 39.8], [-121.5, 39.8], [-121.5, 39.9], [-121.6, 39.8]]] } };
  const result = cameraViewshed(source, camera());
  assert.deepEqual(result?.geometry.coordinates, source.geometry?.rings);
  assert.equal(result?.properties.viewUpdatedAt, "2026-10-23T05:58:00.000Z");
  assert.equal(cameraViewshed({ geometry: { rings: [[[500, 90], [0, 0], [1, 1], [500, 90]]] } }, camera()), undefined);
});

test("outside-coverage lookups do not query unrelated sources", async () => {
  const fetcher = (async () => { throw new Error("must not fetch"); }) as typeof fetch;
  const result = await loadNearbyCameras(30.3, -97.7, { fetcher, now: () => Date.parse(now) });
  assert.equal(result.status, "outside-coverage");
  assert.deepEqual(result.cameras, []);
});

test("nearest cameras include later catalogue pages; viewshed failures do not erase images", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(urlOf(input)); calls.push(url.toString());
    if (init?.method === "HEAD") return new Response(null, { status: 200, headers: imageHeaders() });
    if (url.pathname.endsWith("/1/query")) return new Response(null, { status: 503 });
    const later = url.searchParams.get("resultOffset") === "50";
    return Response.json({ features: later ? [feature("Axis-Close", 39.8, -121.6)] : [feature("Axis-Far", 40.1, -121.6)], exceededTransferLimit: !later });
  }) as typeof fetch;
  const result = await loadNearbyCameras(39.8, -121.6, { fetcher, now: () => Date.parse(now) });
  assert.equal(result.cameras[0].id, "alertcalifornia:Axis-Close");
  assert.equal(result.cameras[1].id, "alertcalifornia:Axis-Far");
  assert.equal(result.cameras[0].capturedAt, capture);
  assert.ok(calls.some((url) => url.includes("resultOffset=50")));
  assert.ok(result.warnings.some((warning: string) => warning.includes("viewshed layer")));
});

test("camera list is limited to six and source errors are not disguised as empty coverage", async () => {
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(urlOf(input));
    if (init?.method === "HEAD") return new Response(null, { status: 404 });
    return Response.json({ features: url.pathname.endsWith("/0/query") ? Array.from({ length: 8 }, (_, i) => feature(`Axis-${i}`, 39.8 + i * 0.01, -121.6)) : [], exceededTransferLimit: false });
  }) as typeof fetch;
  const result = await loadNearbyCameras(39.8, -121.6, { fetcher, now: () => Date.parse(now) });
  assert.equal(result.cameras.length, 6);
  assert.ok(result.cameras.every((entry: Camera) => entry.imageStatus === "unavailable"));
  await assert.rejects(loadNearbyCameras(39.8, -121.6, { fetcher: (async () => Response.json({ error: { code: 500 } })) as typeof fetch }), /invalid response/);
});
