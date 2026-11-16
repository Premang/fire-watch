// Data access for the harmonized calendar: meta, preset series, binary AOI tiles and AOI aggregation.
// The tile format is written by scripts/global/build_web.py and covered by tests/harmonized-data.test.ts.
import { monthFromIndex, monthIndex, type MonthPoint, type Platform } from "./analytics";

export const R_KM = 6371;
const COS30 = Math.cos(Math.PI / 6);

export interface MonthFlag { month: string; partial: boolean; provisional: boolean; source: Platform | null; coveredDays: number; days: number }
export interface HarmonizedMeta {
  version: number;
  unit: string;
  firstMonth: string;
  lastMonth: string;
  baseline: [number, number];
  generatedAt: string;
  months: MonthFlag[];
  levels: { level: number; cellKm: number; tileCells: number; path: string; tiles: string[] }[];
  /** Held-out bridge error by validation scale (empirical error envelopes, not confidence intervals). */
  relativeError: { scale?: string; unitAreaKm2: number | null; aqua: number; terra: number; noaa20: number }[];
  validation?: unknown;
  presetsWithData?: string[];
  sources: { name: string; url: string; citation?: string }[];
}

export const TILE_FIELDS = ["h10", "hb10", "modis", "snpp", "noaa20", "det_modis", "det_snpp", "det_noaa20"] as const;
export type TileField = typeof TILE_FIELDS[number];
export interface TileCell { index: number; months: Int32Array; values: Int32Array /* months.length x nFields */ }
export interface Tile { level: number; cellKm: number; tx: number; ty: number; tileCells: number; monthBase: number; fields: number; cells: TileCell[] }

class Reader {
  pos = 0;
  private buf: Uint8Array;
  constructor(buf: Uint8Array) { this.buf = buf; }
  byte(): number { if (this.pos >= this.buf.length) throw new RangeError("Truncated tile"); return this.buf[this.pos++]; }
  varint(): number {
    let result = 0, shift = 0, b: number;
    do { b = this.byte(); result += (b & 0x7f) * 2 ** shift; shift += 7; if (shift > 49) throw new RangeError("Varint too long"); } while (b & 0x80);
    return result;
  }
  zigzag(): number { const v = this.varint(); return v % 2 ? -(v + 1) / 2 : v / 2; }
}

/** Parse an (already decompressed) EAT1 tile. */
export function parseTile(bytes: Uint8Array): Tile {
  if (bytes.length < 4 || String.fromCharCode(...bytes.slice(0, 4)) !== "EAT1") throw new Error("Not an Fire Watch tile");
  const r = new Reader(bytes); r.pos = 4;
  const level = r.varint(), cellKm = r.varint(), tx = r.zigzag(), ty = r.zigzag(), tileCells = r.varint(), monthBase = r.varint(), fields = r.varint();
  if (fields !== TILE_FIELDS.length) throw new Error(`Unexpected tile field count ${fields}`);
  const nCells = r.varint(), cells: TileCell[] = [];
  let index = 0;
  for (let c = 0; c < nCells; c++) {
    index += r.varint();
    const n = r.varint(), months = new Int32Array(n), values = new Int32Array(n * fields);
    let m = monthBase;
    for (let k = 0; k < n; k++) {
      m += r.varint(); months[k] = m;
      for (let f = 0; f < fields; f++) values[k * fields + f] = r.varint();
    }
    cells.push({ index, months, values });
  }
  if (r.pos !== bytes.length) throw new Error("Trailing bytes in tile");
  return { level, cellKm, tx, ty, tileCells, monthBase, fields, cells };
}

export async function gunzip(data: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** Hosts differ: some serve .gz with Content-Encoding (the browser already decoded it), others as raw gzip. */
export async function maybeGunzip(data: ArrayBuffer): Promise<Uint8Array> {
  const b = new Uint8Array(data);
  return b.length > 2 && b[0] === 0x1f && b[1] === 0x8b ? gunzip(data) : b;
}

// ---- grid geometry (spherical cylindrical equal-area, standard parallel 30 deg) ----
export function lonLatToXY(lon: number, lat: number): [number, number] {
  return [R_KM * (lon * Math.PI / 180) * COS30, R_KM * Math.sin(lat * Math.PI / 180) / COS30];
}
export function xyToLonLat(x: number, y: number): [number, number] {
  return [x / (R_KM * COS30) * 180 / Math.PI, Math.asin(Math.max(-1, Math.min(1, y * COS30 / R_KM))) * 180 / Math.PI];
}
export function cellCenter(tile: Pick<Tile, "tx" | "ty" | "tileCells" | "cellKm">, index: number): [number, number] {
  const ix = index % tile.tileCells, iy = Math.floor(index / tile.tileCells);
  const cx = tile.tx * tile.tileCells + ix, cy = tile.ty * tile.tileCells + iy;
  return xyToLonLat((cx + 0.5) * tile.cellKm, (cy + 0.5) * tile.cellKm);
}
export function tilesForBounds(bounds: { west: number; south: number; east: number; north: number }, cellKm: number, tileCells: number): [number, number][] {
  const [x0, y0] = lonLatToXY(bounds.west, bounds.south), [x1, y1] = lonLatToXY(bounds.east, bounds.north);
  const span = cellKm * tileCells, out: [number, number][] = [];
  for (let tx = Math.floor(Math.min(x0, x1) / span); tx <= Math.floor(Math.max(x0, x1) / span); tx++)
    for (let ty = Math.floor(Math.min(y0, y1) / span); ty <= Math.floor(Math.max(y0, y1) / span); ty++) out.push([tx, ty]);
  return out;
}

// ---- areas of interest ----
export type Ring = [number, number][]; // [lon, lat]
export type Aoi =
  | { kind: "polygon"; rings: Ring[][]; label: string; presetId?: string } // multipolygon: polygons -> rings (outer first)
  | { kind: "circle"; lon: number; lat: number; radiusKm: number; label: string; presetId?: string };

export function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}
function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function containsPoint(aoi: Aoi, lon: number, lat: number): boolean {
  if (aoi.kind === "circle") return haversineKm(aoi.lon, aoi.lat, lon, lat) <= aoi.radiusKm;
  return aoi.rings.some(poly => poly.length > 0 && inRing(lon, lat, poly[0]) && !poly.slice(1).some(hole => inRing(lon, lat, hole)));
}
export function aoiBounds(aoi: Aoi): { west: number; south: number; east: number; north: number } {
  if (aoi.kind === "circle") {
    // Exact spherical bounds: angular radius r; if the cap reaches a pole every longitude is inside (Astra 15a).
    const r = aoi.radiusKm / R_KM, phi = aoi.lat * Math.PI / 180, deg = 180 / Math.PI;
    const south = Math.max(-90, (phi - r) * deg), north = Math.min(90, (phi + r) * deg);
    if (Math.abs(phi) + r >= Math.PI / 2) return { west: -180, east: 180, south: phi > 0 ? south : -90, north: phi > 0 ? 90 : north };
    const dLon = Math.asin(Math.min(1, Math.sin(r) / Math.cos(phi))) * deg;
    return { west: aoi.lon - dLon, east: aoi.lon + dLon, south, north };
  }
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const poly of aoi.rings) for (const [lon, lat] of poly[0] ?? []) { west = Math.min(west, lon); east = Math.max(east, lon); south = Math.min(south, lat); north = Math.max(north, lat); }
  return { west, south, east, north };
}
export type Bounds = { west: number; south: number; east: number; north: number };
/** The AOI's bounding box split at the antimeridian (a circle near +/-180 deg becomes two boxes inside [-180, 180]). */
export function aoiBoxes(aoi: Aoi): Bounds[] {
  const b = aoiBounds(aoi);
  if (b.east - b.west >= 360) return [{ ...b, west: -180, east: 180 }];
  if (b.west < -180) return [{ ...b, west: -180 }, { ...b, west: b.west + 360, east: 180 }];
  if (b.east > 180) return [{ ...b, east: 180 }, { ...b, west: -180, east: b.east - 360 }];
  return [b];
}
/** Tiles covering every box of the AOI (deduplicated). */
export function tilesForAoi(aoi: Aoi, cellKm: number, tileCells: number): [number, number][] {
  const seen = new Set<string>(), out: [number, number][] = [];
  for (const b of aoiBoxes(aoi)) for (const t of tilesForBounds(b, cellKm, tileCells)) { const k = `${t[0]}_${t[1]}`; if (!seen.has(k)) { seen.add(k); out.push(t); } }
  return out;
}

/** Spherical area (km^2) of a ring via the equal-area projection (shoelace in CEA space). */
export function ringAreaKm2(ring: Ring): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [x1, y1] = lonLatToXY(...ring[j]), [x2, y2] = lonLatToXY(...ring[i]); s += x1 * y2 - x2 * y1; }
  return Math.abs(s) / 2;
}
export function aoiAreaKm2(aoi: Aoi): number {
  if (aoi.kind === "circle") return Math.PI * aoi.radiusKm ** 2;
  return aoi.rings.reduce((t, poly) => t + (poly[0] ? ringAreaKm2(poly[0]) : 0) - poly.slice(1).reduce((h, r) => h + ringAreaKm2(r), 0), 0);
}

/** Pick the finest level whose tile count across the AOI's bounding box(es) stays within budget. */
export function chooseLevel(meta: Pick<HarmonizedMeta, "levels">, area: Bounds | Aoi, maxTiles = 24) {
  const levels = [...meta.levels].sort((a, b) => a.cellKm - b.cellKm);
  const count = (l: { cellKm: number; tileCells: number }) => "kind" in area ? tilesForAoi(area, l.cellKm, l.tileCells).length : tilesForBounds(area, l.cellKm, l.tileCells).length;
  for (const l of levels) if (count(l) <= maxTiles) return l;
  return levels.at(-1)!;
}

export interface AoiAggregate { months: Map<number, number[]>; cellsInside: number; cellKm: number }
/** Sum tile fields over cells whose centres fall inside the AOI. */
export function aggregateTiles(tiles: Tile[], aoi: Aoi): AoiAggregate {
  const months = new Map<number, number[]>(); let cellsInside = 0, cellKm = tiles[0]?.cellKm ?? 0;
  for (const t of tiles) {
    cellKm = t.cellKm;
    for (const c of t.cells) {
      const [lon, lat] = cellCenter(t, c.index);
      if (!containsPoint(aoi, lon, lat)) continue;
      cellsInside++;
      for (let k = 0; k < c.months.length; k++) {
        const acc = months.get(c.months[k]) ?? new Array(t.fields).fill(0);
        for (let f = 0; f < t.fields; f++) acc[f] += c.values[k * t.fields + f];
        months.set(c.months[k], acc);
      }
    }
  }
  return { months, cellsInside, cellKm };
}

/** Error of the largest validated scale whose unit area fits inside the AOI (an AOI between scales gets the smaller,
 *  more conservative scale); areas smaller than the finest unit use the finest scale. The global row is for global totals. */
export function relativeErrorFor(meta: Pick<HarmonizedMeta, "relativeError">, areaKm2: number) {
  const rows = meta.relativeError.filter(r => r.unitAreaKm2).sort((a, b) => a.unitAreaKm2! - b.unitAreaKm2!);
  if (!rows.length) return { scale: "none", unitAreaKm2: null, aqua: 0, terra: 0, noaa20: 0 };
  return rows.filter(r => r.unitAreaKm2! <= areaKm2).at(-1) ?? rows[0];
}

/** Turn aggregated tile sums (or a preset's rows) into calendar MonthPoints with flags and an uncertainty band. */
export function toMonthPoints(meta: Pick<HarmonizedMeta, "months" | "relativeError" | "firstMonth" | "lastMonth">, sums: Map<number, number[]>, areaKm2: number): MonthPoint[] {
  const flags = new Map(meta.months.map(f => [f.month, f])), err = relativeErrorFor(meta, areaKm2);
  const out: MonthPoint[] = [];
  for (let i = monthIndex(meta.firstMonth); i <= monthIndex(meta.lastMonth); i++) {
    const month = monthFromIndex(i), f = flags.get(month), v = sums.get(i);
    if (!f || f.coveredDays === 0) { out.push({ month, h: null, source: null, modis: null, snpp: null, noaa20: null, detections: null, partial: true, provisional: false }); continue; }
    const h = v ? v[0] / 10 : 0, hb = v ? v[1] / 10 : 0;
    const rel = f?.source === "terra" ? Math.max(err.terra, err.aqua) : f?.source === "noaa20" ? err.noaa20 : err.aqua;
    out.push({ month, h, lo: Math.max(0, h - rel * hb), hi: h + rel * hb, source: f?.source ?? null, modis: v ? v[2] : 0, snpp: f && i >= monthIndex("2012-01") ? (v ? v[3] : 0) : null,
      noaa20: i >= monthIndex("2018-01") ? (v ? v[4] : 0) : null, detections: v ? v[5] + v[6] + v[7] : 0, partial: f?.partial ?? false, provisional: f?.provisional ?? false, coveredDays: f.coveredDays, days: f.days });
  }
  return out;
}

export interface PresetSeries { id: string; name: string; nameEs?: string; kind: string; areaKm2: number; start: string; fields: string[]; rows: (number | null)[][] }
export function presetToMonthPoints(meta: Pick<HarmonizedMeta, "months">, p: PresetSeries): MonthPoint[] {
  const flags = new Map(meta.months.map(f => [f.month, f])), idx = Object.fromEntries(p.fields.map((f, i) => [f, i]));
  const start = monthIndex(p.start);
  return p.rows.map((r, k) => {
    const month = monthFromIndex(start + k), f = flags.get(month), g = (name: string) => (idx[name] === undefined ? null : r[idx[name]]);
    if (!f || f.coveredDays === 0) return { month, h: null, source: null, modis: null, snpp: null, noaa20: null, detections: null, partial: true, provisional: false };
    // A platform that was not yet operating has no value (null), not zero, so raw-series baselines are not diluted (Astra 15a).
    const op = (name: string, first: string) => (month >= first ? g(name) : null);
    return { month, h: g("h"), lo: g("lo"), hi: g("hi"), source: f?.source ?? null, modis: g("modis"), terra: op("terra", "2000-02"), aqua: op("aqua", "2002-07"), snpp: op("snpp", "2012-01"), noaa20: op("noaa20", "2018-01"),
      detections: (g("det_modis") ?? 0) + (g("det_snpp") ?? 0) + (g("det_noaa20") ?? 0), partial: f?.partial ?? false, provisional: f?.provisional ?? false, coveredDays: f.coveredDays, days: f.days };
  });
}
