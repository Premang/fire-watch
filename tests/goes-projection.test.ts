import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Native Node TypeScript execution uses explicit file extensions.
import { footprintIntersectsBounds, goesToLonLat, isHighConfidenceFire, parseGoesBounds, pixelFootprint } from "../lib/goes-projection.ts";

const projection = { semiMajorAxis: 6378137, semiMinorAxis: 6356752.31414, perspectivePointHeight: 35786023, longitudeOfProjectionOrigin: -75 };

// Independent forward navigation: geodetic location -> ECEF -> satellite angles.
function forward(lon: number, lat: number, origin: number) {
  const latitude = lat * Math.PI / 180, longitude = (lon - origin) * Math.PI / 180;
  const { semiMajorAxis: a, semiMinorAxis: b, perspectivePointHeight: h } = projection;
  const eccentricity = 1 - b * b / (a * a);
  const n = a / Math.sqrt(1 - eccentricity * Math.sin(latitude) ** 2);
  const x = n * Math.cos(latitude) * Math.cos(longitude);
  const y = n * Math.cos(latitude) * Math.sin(longitude);
  const z = n * (1 - eccentricity) * Math.sin(latitude);
  const distance = Math.hypot(h + a - x, y, z);
  return [Math.asin(y / distance), Math.atan2(z, h + a - x)];
}

test("ABI inverse navigation round-trips independent ECEF locations across both US views", () => {
  for (const origin of [-75, -137]) {
    for (const [lon, lat] of [[-122.42, 37.77], [-111.9, 40.7], [-97.7, 30.3], [-80.2, 25.8]]) {
      const [x, y] = forward(lon, lat, origin);
      const point = goesToLonLat(x, y, { ...projection, longitudeOfProjectionOrigin: origin });
      assert.ok(point);
      assert.ok(Math.abs(point[0] - lon) < 1e-8, `longitude at ${lon},${lat} from ${origin}`);
      assert.ok(Math.abs(point[1] - lat) < 1e-8, `latitude at ${lon},${lat} from ${origin}`);
    }
  }
  assert.deepEqual(goesToLonLat(0, 0, projection), [-75, 0]);
  assert.equal(goesToLonLat(0.5, 0.5, projection), null, "space pixels have no fabricated geographic location");
  assert.equal(goesToLonLat(NaN, 0, projection), null);
});

test("pixel footprint is a closed off-nadir quadrilateral, not a fixed centroid square", () => {
  const [x, y] = forward(-122.42, 37.77, -137);
  const p = { ...projection, longitudeOfProjectionOrigin: -137 };
  const ring = pixelFootprint(x, y, 0.000056, -0.000056, p)!;
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring.at(-1));
  const angles = ring.slice(0, 4).map(([lon, lat]) => forward(lon, lat, -137));
  for (const [cx, cy] of angles) {
    assert.ok(Math.abs(Math.abs(cx - x) - 0.000028) < 2e-9);
    assert.ok(Math.abs(Math.abs(cy - y) - 0.000028) < 2e-9);
  }
  assert.ok(footprintIntersectsBounds(ring, { west: -122.421, east: -122.419, south: 37.769, north: 37.771 }));
  assert.equal(footprintIntersectsBounds(ring, { west: -75, east: -74, south: 30, north: 31 }), false);
  assert.equal(pixelFootprint(0.5, 0.5, 0.000056, 0.000056, p), null);
});

test("quality gate retains processed and saturated fire only, including temporal classes", () => {
  assert.deepEqual(Array.from({ length: 256 }, (_, value) => value).filter(isHighConfidenceFire), [10, 11, 30, 31]);
  for (const value of [-99, NaN, 10.5, 12, 13, 14, 15, 32, 33, 34, 35, 100, 200, 240]) assert.equal(isHighConfidenceFire(value), false);
});

test("bbox rejects malformed bounds and retains a pixel crossing the AOI edge", () => {
  assert.deepEqual(parseGoesBounds("-125,24,-66,50"), { west: -125, south: 24, east: -66, north: 50 });
  for (const bad of ["1,2,3", "-125,,1,2", "-66,24,-125,50", "-181,24,0,50", "0,0,1,91", "NaN,0,1,2"]) assert.throws(() => parseGoesBounds(bad));
  assert.ok(footprintIntersectsBounds([[-1, 0], [1, 0], [1, 1], [-1, 1], [-1, 0]], { west: 0.9, east: 2, south: 0.1, north: 0.2 }));
});
