import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    let path: string | undefined;
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) path = fileURLToPath(new URL(specifier, context.parentURL));
    if (path && !existsSync(path) && existsSync(`${path}.ts`)) path += ".ts";
    return next(path ? pathToFileURL(path).href : specifier, context);
  },
});
// @ts-expect-error Explicit source extension supports the direct Node test runner.
const d = await import("../lib/harmonized/data.ts");
hooks.deregister();
type Aoi = Parameters<typeof d.containsPoint>[0];

const fixture = JSON.parse(readFileSync(new URL("./fixtures/tile-fixture.json", import.meta.url), "utf8")) as { level: number; cellKm: number; tileCells: number; tx: number; ty: number; cells: { index: number; records: number[][] }[] };

test("the TypeScript reader decodes the Python EAT1 tile writer exactly", () => {
  const tile = d.parseTile(new Uint8Array(gunzipSync(readFileSync(new URL("./fixtures/tile-fixture.bin.gz", import.meta.url)))));
  assert.equal(tile.level, fixture.level); assert.equal(tile.cellKm, fixture.cellKm); assert.equal(tile.tileCells, fixture.tileCells);
  assert.equal(tile.tx, fixture.tx); assert.equal(tile.ty, fixture.ty); assert.equal(tile.fields, d.TILE_FIELDS.length);
  assert.equal(tile.cells.length, fixture.cells.length);
  fixture.cells.forEach((c, i) => {
    assert.equal(tile.cells[i].index, c.index);
    c.records.forEach((r, k) => { assert.equal(tile.cells[i].months[k], r[0]); assert.deepEqual(Array.from(tile.cells[i].values.slice(k * tile.fields, (k + 1) * tile.fields)), r.slice(1)); });
  });
});

test("corrupt or truncated tiles are rejected", () => {
  assert.throws(() => d.parseTile(new Uint8Array([1, 2, 3, 4, 5])), /Not an Fire Watch tile/);
  const good = new Uint8Array(gunzipSync(readFileSync(new URL("./fixtures/tile-fixture.bin.gz", import.meta.url))));
  assert.throws(() => d.parseTile(good.slice(0, good.length - 3)), /Truncated/);
  assert.throws(() => d.parseTile(new Uint8Array([...good, 0])), /Trailing/);
});

test("equal-area grid round-trips and cell centres land inside their tile", () => {
  for (const [lon, lat] of [[-64.18, -31.42], [120, 45], [-179.9, 0], [0, 84]] as [number, number][]) {
    const [x, y] = d.lonLatToXY(lon, lat), [lo, la] = d.xyToLonLat(x, y);
    assert.ok(Math.abs(lo - lon) < 1e-9 && Math.abs(la - lat) < 1e-9);
  }
  const tile = { tx: -3, ty: 5, tileCells: 32, cellKm: 10 };
  const [lon, lat] = d.cellCenter(tile, 0), [x, y] = d.lonLatToXY(lon, lat);
  assert.equal(Math.floor(x / 10), -96); assert.equal(Math.floor(y / 10), 160);
  assert.deepEqual(d.tilesForBounds({ west: lon - 0.01, south: lat - 0.01, east: lon + 0.01, north: lat + 0.01 }, 10, 32), [[-3, 5]]);
});

test("AOI containment handles holes, multipolygons and circles; area is equal-area", () => {
  const sq = (w: number, s: number, e: number, n: number) => [[w, s], [e, s], [e, n], [w, n], [w, s]] as [number, number][];
  const aoi: Aoi = { kind: "polygon", label: "t", rings: [[sq(0, 0, 10, 10), sq(4, 4, 6, 6)], [sq(20, 0, 22, 2)]] };
  assert.equal(d.containsPoint(aoi, 1, 1), true); assert.equal(d.containsPoint(aoi, 5, 5), false); assert.equal(d.containsPoint(aoi, 21, 1), true); assert.equal(d.containsPoint(aoi, 15, 5), false);
  const c: Aoi = { kind: "circle", label: "c", lon: 0, lat: 0, radiusKm: 100 };
  assert.equal(d.containsPoint(c, 0.8, 0), true); assert.equal(d.containsPoint(c, 1.0, 0), false);
  const oneDeg = d.ringAreaKm2(sq(0, 0, 1, 1)); assert.ok(Math.abs(oneDeg - 12364) / 12364 < 0.01, `1x1 deg at equator ~12,364 km2, got ${oneDeg}`);
  assert.ok(Math.abs(d.aoiAreaKm2(c) - Math.PI * 1e4) < 1e-6);
});

test("aggregation sums only cells whose centres are inside the AOI and builds flagged month points", () => {
  const tile = d.parseTile(new Uint8Array(gunzipSync(readFileSync(new URL("./fixtures/tile-fixture.bin.gz", import.meta.url)))));
  const [lon0, lat0] = d.cellCenter(tile, 5);
  const aoi: Aoi = { kind: "circle", label: "c", lon: lon0, lat: lat0, radiusKm: 3 };
  const agg = d.aggregateTiles([tile], aoi);
  assert.equal(agg.cellsInside, 1); assert.deepEqual([...agg.months.keys()], [0, 1, 250]); assert.equal(agg.months.get(250)![0], 99999);
  const meta = { firstMonth: "2000-01", lastMonth: "2000-03", relativeError: [{ unitAreaKm2: 1600, aqua: 0.2, terra: 0.3, noaa20: 0.1 }],
    months: [{ month: "2000-01", partial: false, provisional: false, source: "aqua" as const, coveredDays: 31, days: 31 }, { month: "2000-02", partial: true, provisional: true, source: "terra" as const, coveredDays: 20, days: 29 }] };
  const pts = d.toMonthPoints(meta, agg.months, 100);
  assert.equal(pts.length, 3); assert.equal(pts[0].h, 1.2); assert.equal(pts[0].hi, 1.2 + 0.2 * 34.5); assert.equal(pts[1].partial, true); assert.equal(pts[1].source, "terra");
  // A month without any platform coverage is "no satellite record" (null), never zero activity.
  assert.equal(pts[2].h, null); assert.equal(pts[2].partial, true);
  const covered = d.toMonthPoints({ ...meta, months: [...meta.months, { month: "2000-03", partial: false, provisional: false, source: "snpp" as const, coveredDays: 31, days: 31 }] }, agg.months, 100);
  assert.equal(covered[2].h, 0); assert.equal(covered[2].partial, false);
});

test("areas crossing the antimeridian are split into two boxes and select tiles on both sides", () => {
  const circle = { kind: "circle" as const, lon: 179.5, lat: -17, radiusKm: 150, label: "Fiji" };
  const boxes = d.aoiBoxes(circle);
  assert.equal(boxes.length, 2); assert.ok(boxes.every((b: { west: number; east: number }) => b.west >= -180 && b.east <= 180 && b.west < b.east));
  const tiles = d.tilesForAoi(circle, 10, 32), xs = tiles.map((t: [number, number]) => t[0]);
  assert.ok(Math.min(...xs) < 0 && Math.max(...xs) > 0);
  assert.equal(d.aoiBoxes({ kind: "circle" as const, lon: 0, lat: 0, radiusKm: 10, label: "x" }).length, 1);
});

test("circle bounds are spherical: a cap around a pole spans every longitude and keeps contained points", () => {
  const polar = { kind: "circle" as const, lon: 0, lat: 85, radiusKm: 1000, label: "polar" };
  const b = d.aoiBounds(polar);
  assert.equal(b.west, -180); assert.equal(b.east, 180); assert.equal(b.north, 90);
  assert.ok(d.containsPoint(polar, 150, 89)); // ~655 km away: inside, and inside the bounds
  assert.ok(150 >= b.west && 150 <= b.east && 89 <= b.north && 89 >= b.south);
  const mid = d.aoiBounds({ kind: "circle" as const, lon: 10, lat: 60, radiusKm: 500, label: "m" });
  // Exact half-width asin(sin r / cos lat) is wider than the small-angle estimate at high latitude.
  assert.ok(mid.east - 10 > 500 / 111.2 / Math.cos(60 * Math.PI / 180) * 0.99);
});

test("preset series: platforms not yet operating are null, not zero", () => {
  const meta = { months: ["2005-07", "2015-07", "2019-07"].map(month => ({ month, partial: false, provisional: false, source: "aqua" as const, coveredDays: 31, days: 31 })) };
  const p = { id: "x", name: "x", kind: "country", areaKm2: 1, start: "2005-07", fields: ["h", "modis", "terra", "aqua", "snpp", "noaa20"], rows: [] as (number | null)[][] };
  const rows: (number | null)[][] = []; for (let i = 0; i < 169; i++) rows.push([5, 3, 1, 2, 0, 0]); p.rows = rows; // 2005-07 .. 2019-07
  const pts = d.presetToMonthPoints(meta, p);
  const at = (m: string) => pts.find((x: { month: string }) => x.month === m)!;
  assert.equal(at("2005-07").snpp, null); assert.equal(at("2005-07").noaa20, null); assert.equal(at("2005-07").aqua, 2);
  assert.equal(at("2015-07").snpp, 0); assert.equal(at("2015-07").noaa20, null); assert.equal(at("2019-07").noaa20, 0);
});

test("error envelopes use the largest validated scale that fits inside the area (conservative between scales)", () => {
  const meta = { relativeError: [{ scale: "40km", unitAreaKm2: 1600, aqua: 0.42, terra: 0.72, noaa20: 0.16 }, { scale: "320km", unitAreaKm2: 102400, aqua: 0.16, terra: 0.26, noaa20: 0.05 },
    { scale: "1280km", unitAreaKm2: 1638400, aqua: 0.10, terra: 0.17, noaa20: 0.03 }, { scale: "global", unitAreaKm2: null, aqua: 0.04, terra: 0.07, noaa20: 0.01 }] };
  assert.equal(d.relativeErrorFor(meta, 500).scale, "40km");      // smaller than any unit: finest scale
  assert.equal(d.relativeErrorFor(meta, 168000).scale, "320km");  // Córdoba: between 320 km and 1,280 km -> 320 km
  assert.equal(d.relativeErrorFor(meta, 2.8e6).scale, "1280km");  // Argentina
  assert.equal(d.relativeErrorFor(meta, 1e8).scale, "1280km");    // never the global-total row
});
