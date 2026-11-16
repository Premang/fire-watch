// @ts-expect-error -- Native Node TypeScript tests require explicit extensions.
import { decodeGoesFrame } from "./goes-decode.ts";
// @ts-expect-error -- Native Node TypeScript tests require explicit extensions.
import { footprintIntersectsBounds } from "./goes-projection.ts";
// @ts-expect-error -- Native Node TypeScript tests require explicit extensions.
import { knownGoesFrame, parseGoesKey } from "./goes-source.ts";
import type { GoesBounds, GoesFrame, GoesPlatform } from "./goes-types";

// Keep only one small, decoded GeoJSON frame per satellite, never full grids.
const frames = new Map<GoesPlatform, GoesFrame>();
const pending = new Map<string, Promise<GoesFrame>>();
let decodeQueue: Promise<unknown> = Promise.resolve();

async function loadFrame(platform: GoesPlatform, key: string): Promise<GoesFrame> {
  const metadata = knownGoesFrame(platform, key) ?? parseGoesKey(key, platform);
  const response = await fetch(metadata.url, { signal: AbortSignal.timeout(20_000), cache: "no-store" });
  if (!response.ok) throw new Error(`NOAA frame unavailable (${response.status}).`);
  const length = Number(response.headers.get("content-length"));
  if (length > 8_000_000) throw new Error("NOAA frame exceeds the file-size limit.");
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 8_000_000) throw new Error("NOAA frame exceeds the file-size limit.");
  const modified = response.headers.get("last-modified");
  if (modified && Number.isFinite(Date.parse(modified))) metadata.publishedAt = new Date(modified).toISOString();
  metadata.sizeBytes = buffer.byteLength;
  return decodeGoesFrame(buffer, metadata);
}

export async function getGoesFrame(platform: GoesPlatform, key: string, bounds?: GoesBounds): Promise<GoesFrame> {
  parseGoesKey(key, platform); // Validate even before consulting cache.
  let frame = frames.get(platform);
  if (frame?.frame.key !== key) {
    let request = pending.get(key);
    if (!request) {
      if (pending.size >= 8) throw new Error("The NOAA decoder is busy. Please retry shortly.");
      // Serialize downloads and large-grid decode to cap peak isolate memory.
      request = decodeQueue.then(() => loadFrame(platform, key));
      decodeQueue = request.catch(() => undefined);
      pending.set(key, request);
    }
    try { frame = await request; frames.set(platform, frame); }
    finally { if (pending.get(key) === request) pending.delete(key); }
  }
  if (!bounds) return frame;
  const filtered = frame.features.features.filter((feature) => footprintIntersectsBounds(feature.geometry.coordinates[0], bounds));
  return { ...frame, detectionCount: filtered.length, features: { type: "FeatureCollection", features: filtered } };
}
