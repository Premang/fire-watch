import type { GoesBounds, GoesProjection } from "./goes-types";

export const HIGH_CONFIDENCE_FIRE_CLASSES = [10, 11, 30, 31] as const;
export function isHighConfidenceFire(mask: number): boolean {
  return mask === 10 || mask === 11 || mask === 30 || mask === 31;
}

/** NOAA ABI fixed-grid navigation, using scan angles in radians. */
export function goesToLonLat(x: number, y: number, projection: GoesProjection): [number, number] | null {
  const a = projection.semiMajorAxis;
  const b = projection.semiMinorAxis;
  const height = projection.perspectivePointHeight + a;
  if (![x, y, a, b, height, projection.longitudeOfProjectionOrigin].every(Number.isFinite) || a <= 0 || b <= 0 || height <= a) return null;
  const sinX = Math.sin(x), cosX = Math.cos(x), sinY = Math.sin(y), cosY = Math.cos(y);
  const ratio = a * a / (b * b);
  const qa = sinX * sinX + cosX * cosX * (cosY * cosY + ratio * sinY * sinY);
  const qb = -2 * height * cosX * cosY;
  const qc = height * height - a * a;
  const discriminant = qb * qb - 4 * qa * qc;
  if (discriminant < 0) return null; // Ray views space, not Earth's surface.
  const range = (-qb - Math.sqrt(discriminant)) / (2 * qa);
  const sx = range * cosX * cosY;
  const sy = -range * sinX;
  const sz = range * cosX * sinY;
  const longitude = projection.longitudeOfProjectionOrigin + Math.atan2(-sy, height - sx) * 180 / Math.PI;
  const latitude = Math.atan(ratio * sz / Math.hypot(height - sx, sy)) * 180 / Math.PI;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return [longitude, latitude];
}

/** Cell corner navigation preserves the actual off-nadir pixel footprint. */
export function pixelFootprint(x: number, y: number, dx: number, dy: number, projection: GoesProjection): number[][] | null {
  if (![dx, dy].every(Number.isFinite) || dx === 0 || dy === 0) return null;
  const points = [
    goesToLonLat(x - Math.abs(dx) / 2, y - Math.abs(dy) / 2, projection),
    goesToLonLat(x + Math.abs(dx) / 2, y - Math.abs(dy) / 2, projection),
    goesToLonLat(x + Math.abs(dx) / 2, y + Math.abs(dy) / 2, projection),
    goesToLonLat(x - Math.abs(dx) / 2, y + Math.abs(dy) / 2, projection),
  ];
  if (points.some((point) => point === null)) return null;
  const ring = (points as [number, number][]).map(([lon, lat]) => [Number(lon.toFixed(6)), Number(lat.toFixed(6))]);
  ring.push([...ring[0]]);
  return ring;
}

export function parseGoesBounds(value: string | null): GoesBounds | undefined {
  if (value === null || value === "") return undefined;
  const parts = value.split(",");
  if (parts.length !== 4 || parts.some((part) => part.trim() === "")) throw new Error("bbox must be west,south,east,north.");
  const [west, south, east, north] = parts.map(Number);
  if (![west, south, east, north].every(Number.isFinite) || west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
    throw new Error("bbox must be a valid non-crossing geographic bounding box.");
  }
  return { west, south, east, north };
}

export function footprintIntersectsBounds(ring: number[][], bounds: GoesBounds): boolean {
  const lons = ring.map((point) => point[0]), lats = ring.map((point) => point[1]);
  return Math.max(...lons) >= bounds.west && Math.min(...lons) <= bounds.east && Math.max(...lats) >= bounds.south && Math.min(...lats) <= bounds.north;
}
