import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Explicit source extension supports the direct Node test runner.
import { fetchElevationGrid, normalizeTerrainSamples } from "../lib/prediction-terrain.ts";
import type { TerrainPoint } from "../lib/prediction-terrain";

const now = Date.parse("2026-10-23T07:00:00Z");
const points: TerrainPoint[] = [[-121.7, 46.9], [-121.71, 46.91], [-121.72, 46.92]];
function sample(id: number, value: unknown = "1704.5") {
  return { locationId: id, location: { x: points[id][0], y: points[id][1] }, value, resolution: 1 / 3600, attributes: { VerticalDatum: "NAVD88", AcquisitionDate: Date.UTC(2020, 7, 22) } };
}
test("USGS terrain matches location IDs rather than result order and preserves missing data", () => {
  const data = normalizeTerrainSamples({ samples: [sample(2, "NoData"), sample(0)] }, points, now);
  assert.deepEqual(data.values, [1704.5, null, null]); assert.deepEqual(data.verticalDatums, ["NAVD88"]);
  assert.deepEqual(data.acquisitionDates, ["2020-08-22"]); assert.equal(data.resolutions[0], 1 / 3600);
});
test("USGS rejects duplicate IDs, wrong locations and service errors", () => {
  assert.throws(() => normalizeTerrainSamples({ samples: [sample(0), sample(0)] }, points, now), /location IDs/);
  assert.throws(() => normalizeTerrainSamples({ samples: [{ ...sample(0), location: { x: -120, y: 46 } }] }, points, now), /coordinates/);
  assert.throws(() => normalizeTerrainSamples({ error: { message: "Source unavailable" } }, points, now), /Source unavailable/);
  assert.deepEqual(normalizeTerrainSamples({ samples: [sample(0, ""), sample(1, 99999)] }, points, now).values, [null, null, null]);
});
test("a full1089-point grid uses two bounded POSTs with truthful provenance", async () => {
  const coords: TerrainPoint[] = Array.from({ length: 1089 }, (_, i) => [-121.8 + i % 33 * .01, 46.8 + Math.floor(i / 33) * .01]);
  const sizes: number[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples"); assert.equal(init?.method, "POST");
    const form = new URLSearchParams(String(init?.body)), geometry = JSON.parse(form.get("geometry")!) as { points: TerrainPoint[] };
    sizes.push(geometry.points.length); assert.equal(form.get("pixelSize"), "30,30");
    return Response.json({ samples: geometry.points.map(([x, y], locationId) => ({ locationId, location: { x, y }, value: "400.25", resolution: 1 / 3600, attributes: { VerticalDatum: "NAVD88", AcquisitionDate: Date.UTC(2020, 0, 1) } })) });
  }) as typeof fetch;
  const result = await fetchElevationGrid(coords, "test-grid", { fetcher, now: () => now });
  assert.deepEqual(sizes, [600, 489]); assert.equal(result.completeCount, 1089); assert.equal(result.totalCount, 1089);
  assert.ok(result.values.every(value => value === 400.25)); assert.equal(result.source.provider, "USGS");
  assert.equal(result.source.units, "m"); assert.equal(result.source.resolutions[0].units, "source coordinate units");
  assert.equal(result.source.fetchedAt, new Date(now).toISOString());
});
test("terrain request limits reject before fetching and HTTP failures have no fabricated fallback", async () => {
  let calls = 0; const fetcher = (async () => { calls++; return new Response("Unavailable", { status: 503 }); }) as typeof fetch;
  await assert.rejects(fetchElevationGrid([], "empty", { fetcher }), /1–1200/);
  await assert.rejects(fetchElevationGrid([[-121, 40], [-115, 40]], "wide", { fetcher }), /bounded/);
  await assert.rejects(fetchElevationGrid([[0, 0]], "outside", { fetcher }), /contiguous/);
  assert.equal(calls, 0);
  await assert.rejects(fetchElevationGrid(points, "outage", { fetcher }), /HTTP 503/); assert.equal(calls, 1);
});
