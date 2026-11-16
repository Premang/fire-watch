export const TERRAIN_SERVICE = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer";
export type TerrainPoint = [number, number];
export type TerrainSource = {
  provider: "USGS"; product: "3DEP bare-earth DEM"; url: string; fetchedAt: string;
  units: "m"; sampling: "Bilinear point samples at model cell centers";
  requestedPixelSizeM: 30; verticalDatums: string[]; acquisitionDates: string[];
  resolutions: { value: number; units: "source coordinate units" }[]; warnings: string[];
};
export type ElevationGrid = { values: (number | null)[]; completeCount: number; totalCount: number; source: TerrainSource };
type TerrainOptions = { fetcher?: typeof fetch; now?: () => number };
type TerrainSample = { locationId?: unknown; location?: { x?: unknown; y?: unknown }; value?: unknown; resolution?: unknown; attributes?: Record<string, unknown> };
const DAY = 86400000, CHUNK = 600;
const cache = new Map<string, { at: number; value: ElevationGrid }>();
const pending = new Map<string, Promise<ElevationGrid>>();
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function validatePoints(coords: TerrainPoint[]) {
  if (!Array.isArray(coords) || coords.length < 1 || coords.length > 1200) throw new RangeError("Provide 1–1200 bounded terrain coordinates.");
  if (coords.some(p => !Array.isArray(p) || p.length !== 2 || !finite(p[0]) || !finite(p[1]) || p[0] < -125 || p[0] > -66 || p[1] < 24 || p[1] > 50)) throw new RangeError("Terrain coordinates must be within the contiguous U.S. envelope.");
  const lon = coords.map(p => p[0]), lat = coords.map(p => p[1]);
  if (Math.max(...lon) - Math.min(...lon) > 1.5 || Math.max(...lat) - Math.min(...lat) > 1) throw new RangeError("Terrain area exceeds the bounded request size.");
}

/** Location IDs are checked against coordinates; missing coverage remains null. */
export function normalizeTerrainSamples(value: unknown, coords: TerrainPoint[], now: number): {
  values: (number | null)[]; verticalDatums: string[]; acquisitionDates: string[]; resolutions: number[];
} {
  const data = value as { error?: { message?: unknown }; samples?: TerrainSample[] };
  if (data?.error) throw new Error(`USGS terrain: ${typeof data.error.message === "string" ? data.error.message : "source error"}`);
  if (!Array.isArray(data?.samples) || data.samples.length > coords.length) throw new Error("Invalid USGS terrain response.");
  const values: (number | null)[] = Array(coords.length).fill(null), seen = new Set<number>();
  const datums = new Set<string>(), dates = new Set<string>(), resolutions = new Set<number>();
  for (const sample of data.samples) {
    const id = sample.locationId, point = sample.location;
    if (!finite(id) || !Number.isInteger(id) || id < 0 || id >= coords.length || seen.has(id)) throw new Error("Invalid USGS terrain location IDs.");
    if (!finite(point?.x) || !finite(point?.y) || Math.abs(point.x - coords[id][0]) > .00001 || Math.abs(point.y - coords[id][1]) > .00001) throw new Error("USGS terrain coordinates do not match the requested grid.");
    seen.add(id);
    const n = typeof sample.value === "string" && sample.value.trim() ? Number(sample.value) : sample.value;
    values[id] = finite(n) && n >= -500 && n <= 9000 ? n : null;
    if (finite(sample.resolution) && sample.resolution > 0) resolutions.add(sample.resolution);
    const a = sample.attributes ?? {}, acquired = a.AcquisitionDate;
    if (typeof a.VerticalDatum === "string" && a.VerticalDatum.trim()) datums.add(a.VerticalDatum.trim().slice(0, 200));
    if (finite(acquired) && acquired >= 0 && acquired <= now) dates.add(new Date(acquired).toISOString().slice(0, 10));
  }
  return { values, verticalDatums: [...datums], acquisitionDates: [...dates].sort(), resolutions: [...resolutions] };
}

async function sampleChunk(coords: TerrainPoint[], options: TerrainOptions, now: number) {
  const body = new URLSearchParams({ f: "json", geometryType: "esriGeometryMultipoint",
    geometry: JSON.stringify({ points: coords.map(p => p.map(n => Number(n.toFixed(6)))), spatialReference: { wkid: 4326 } }),
    returnFirstValueOnly: "true", interpolation: "RSP_BilinearInterpolation", pixelSize: "30,30",
    outFields: "Name,Resolution_X,Resolution_Y,VerticalDatum,AcquisitionDate" });
  const response = await (options.fetcher ?? fetch)(`${TERRAIN_SERVICE}/getSamples`, { method: "POST", body, headers: { Accept: "application/json" }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`USGS terrain returned HTTP ${response.status}.`);
  if (!response.body || Number(response.headers.get("content-length")) > 1_000_000) throw new Error("Invalid USGS terrain response size.");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 1_000_000) throw new Error("USGS terrain exceeded the response size limit."); chunks.push(value); } }
  catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const joined = new Uint8Array(bytes); let offset = 0; for (const part of chunks) { joined.set(part, offset); offset += part.byteLength; }
  return normalizeTerrainSamples(JSON.parse(new TextDecoder().decode(joined)), coords, now);
}

/** At most two POSTs; no arbitrary upstream URL or invented terrain fallback. */
export async function fetchElevationGrid(coords: TerrainPoint[], key: string, options: TerrainOptions = {}): Promise<ElevationGrid> {
  validatePoints(coords); if (typeof key !== "string" || key.length > 256) throw new RangeError("Invalid terrain cache key.");
  const now = (options.now ?? Date.now)(), identity = `${key}/${JSON.stringify(coords)}`, existing = cache.get(identity);
  if (!options.fetcher && existing && now >= existing.at && now - existing.at < 7 * DAY) return existing.value;
  if (!options.fetcher && pending.has(identity)) return pending.get(identity)!;
  const task = (async () => {
    const parts = await Promise.all(Array.from({ length: Math.ceil(coords.length / CHUNK) }, (_, i) => sampleChunk(coords.slice(i * CHUNK, (i + 1) * CHUNK), options, now)));
    const values = parts.flatMap(p => p.values), unique = (v: string[]) => [...new Set(v)].sort();
    const result: ElevationGrid = { values, completeCount: values.filter(finite).length, totalCount: coords.length,
      source: { provider: "USGS", product: "3DEP bare-earth DEM", url: TERRAIN_SERVICE, fetchedAt: new Date(now).toISOString(), units: "m", sampling: "Bilinear point samples at model cell centers", requestedPixelSizeM: 30,
        verticalDatums: unique(parts.flatMap(p => p.verticalDatums)), acquisitionDates: unique(parts.flatMap(p => p.acquisitionDates)),
        resolutions: [...new Set(parts.flatMap(p => p.resolutions))].map(value => ({ value, units: "source coordinate units" })),
        warnings: ["USGS 3DEP cell-center point samples replace the historical SRTM cell means; this terrain transfer is unvalidated.", "The requested 30 m service pixel size selects source imagery; it is not a 1.5 km cell average or a guarantee of uniform ground resolution.", "Source resolution values retain their source coordinate units. Acquisition dates, when supplied, describe source DEMs rather than this request."] } };
    if (!options.fetcher) { if (cache.size >= 8) cache.delete(cache.keys().next().value!); cache.set(identity, { at: now, value: result }); }
    return result;
  })();
  if (!options.fetcher) pending.set(identity, task);
  try { return await task; } finally { if (!options.fetcher && pending.get(identity) === task) pending.delete(identity); }
}
