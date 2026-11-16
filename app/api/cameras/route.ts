import { parseCameraLocation, CAMERA_SOURCE } from "@/lib/cameras";
import { loadNearbyCameras } from "@/lib/cameras-source";
import type { CameraResponse } from "@/lib/cameras";

const cache = new Map<string, { at: number; data: CameraResponse }>();
const pending = new Map<string, Promise<CameraResponse>>();

export async function GET(request: Request) {
  const location = parseCameraLocation(new URL(request.url).searchParams);
  if (!location) return Response.json({ error: "Provide valid lat and lon coordinates to find nearby cameras." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const key = `${location.lat},${location.lon}`;
  try {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < 10_000) return Response.json(cached.data, { headers: { "Cache-Control": "private, max-age=5" } });
    let task = pending.get(key);
    if (!task) {
      task = loadNearbyCameras(location.lat, location.lon).finally(() => pending.delete(key));
      pending.set(key, task);
    }
    const data = await task;
    if (cache.size >= 20) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), data });
    return Response.json(data, { headers: { "Cache-Control": "private, max-age=5" } });
  } catch {
    return Response.json({ error: "ALERTCalifornia camera data could not be reached. Nearby-camera availability is unknown. Please try again.", source: CAMERA_SOURCE }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
