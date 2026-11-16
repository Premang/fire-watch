/** Browser-safe perimeter types and validation. Boundaries are reported extents,
 * not a continuously observed burning edge. Source timestamps have distinct meanings. */
export type PerimeterBounds = { west: number; south: number; east: number; north: number };
export type PerimeterGeometry = { type: "Polygon"; coordinates: number[][][] } | { type: "MultiPolygon"; coordinates: number[][][][] };
export type PerimeterSummary = {
  id: string; perimeterId: string; name: string; state: string; lat: number; lon: number;
  acres: number | null; containment: number | null; updatedAt: string | null; discoveredAt: string | null;
  bounds: PerimeterBounds; capturedAt: string | null; editedAt: string | null; sourceUpdatedAt: string | null;
  mapMethod: string | null; source: string; sourceId: "nifc" | "calfire"; sourceUrl: string;
  quality: "mapped" | "approximate" | "unknown";
};
export type PerimeterFeature = { type: "Feature"; geometry: PerimeterGeometry; properties: PerimeterSummary };
export type PerimeterSourceStatus = { id: string; name: string; url: string; status: "ok" | "error" | "not-applicable"; error?: string };
export type StoredVersionSummary = {
  versionId: string; observedAt: string; capturedAt: string | null; editedAt: string | null;
  sourceUpdatedAt: string | null; source: string; sourceId: "nifc" | "calfire"; mapMethod: string | null;
  quality: PerimeterSummary["quality"]; bounds: PerimeterBounds;
};
export type PerimeterHistory = { status: "available" | "unavailable"; startedAt: string | null; note: string; truncated?: boolean };
export type PerimeterIndex = { incidents: PerimeterSummary[]; fetchedAt: string; sources: PerimeterSourceStatus[]; partial: boolean; warning: string; truncated: boolean };
export type PerimeterDetail = {
  incidentId: string; perimeters: PerimeterFeature[]; preferred: PerimeterFeature | null;
  versions: StoredVersionSummary[]; history: PerimeterHistory; fetchedAt: string;
  sources: PerimeterSourceStatus[]; partial: boolean; warning: string; capturedByAppAt?: string; selectedVersionId?: string;
};
export const PERIMETER_WARNING = "Official perimeters show the last reported mapped extent, not a live burning edge. Capture time, polygon edit time and incident report time are different. A current incident listing does not confirm active flames; missing boundaries do not mean no fire.";
export const HISTORY_NOTE = "History contains versions captured by this app starting with its first successful observation. It is not a complete earlier fire progression or a continuous recording; new versions are collected when this incident is requested.";
export const US_STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "));
export function canonicalIncidentId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().replace(/^\{([\da-f-]+)\}$/i, "$1");
  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(clean) ? `{${clean.toUpperCase()}}` : null;
}
export function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
export function nonnegative(value: unknown): number | null { const n = finite(value); return n !== null && n >= 0 ? n : null; }
export function textField(value: unknown, max = 200): string | null { return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null; }
export function sourceTime(value: unknown): string | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(n) && n > 0 && n < 8.64e15 ? new Date(n).toISOString() : null;
}
/** Rejects malformed/unbounded polygons without flattening rings or removing holes. */
export function validateGeometry(value: unknown, maxVertices = 300_000): { geometry: PerimeterGeometry; bounds: PerimeterBounds } | null {
  if (!value || typeof value !== "object") return null;
  const g = value as { type?: unknown; coordinates?: unknown };
  if (g.type !== "Polygon" && g.type !== "MultiPolygon") return null;
  const polygons = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  if (!Array.isArray(polygons) || !polygons.length || polygons.length > 10_000) return null;
  let vertices = 0; let west = Infinity; let east = -Infinity; let south = Infinity; let north = -Infinity;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !polygon.length || polygon.length > 10_000) return null;
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4) return null;
      vertices += ring.length;
      if (vertices > maxVertices) return null;
      for (const point of ring) {
        if (!Array.isArray(point) || point.length !== 2 || finite(point[0]) === null || finite(point[1]) === null || point[0] < -180 || point[0] > 180 || point[1] < -90 || point[1] > 90) return null;
        west = Math.min(west, point[0]); east = Math.max(east, point[0]); south = Math.min(south, point[1]); north = Math.max(north, point[1]);
      }
      const first = ring[0], last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) return null;
    }
  }
  if (west === east || south === north) return null;
  return { geometry: value as PerimeterGeometry, bounds: { west, south, east, north } };
}
export function mappingQuality(method: string | null): PerimeterSummary["quality"] {
  if (!method) return "unknown";
  if (/auto.?generated|hand sketch|buffer|approximate|estimated/i.test(method)) return "approximate";
  if (/mixed methods|IR Image|GPS|phone|tablet|aerial|FIRIS|digitized|image interpretation|infrared|satellite/i.test(method)) return "mapped";
  return "unknown";
}
export function comparePerimeters(a: PerimeterSummary, b: PerimeterSummary): number {
  const score = { mapped: 2, unknown: 1, approximate: 0 };
  const aDate = Date.parse(a.capturedAt ?? a.sourceUpdatedAt ?? a.editedAt ?? "") || 0;
  const bDate = Date.parse(b.capturedAt ?? b.sourceUpdatedAt ?? b.editedAt ?? "") || 0;
  return score[b.quality] - score[a.quality] || bDate - aDate || (b.acres ?? 0) - (a.acres ?? 0) || a.perimeterId.localeCompare(b.perimeterId);
}
