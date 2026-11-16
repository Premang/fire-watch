import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
// @ts-expect-error Explicit source extension supports the direct Node test runner.
import { fromUtm, makeFireFeatures, outlookDates, predictFire, toUtm } from '../lib/fire-predictor.ts';
// @ts-expect-error Explicit source extension supports the direct Node test runner.
import { priorContextPadding } from '../lib/fire-prior-context.ts';
import type { AntecedentCell, FittedFireModel, WeatherCell } from '../lib/fire-predictor';

type FeatureQuery = { row: number; col: number; weather: WeatherCell; gfs: AntecedentCell; expected: (number | null)[] };
type FeatureCase = { name: string; size: number; recent: boolean[]; prior: boolean[]; elevation: (number | null)[]; queries: FeatureQuery[] };
type Reference = { featureNames: string[]; cases: FeatureCase[]; projections: { lat: number; lon: number; zone: number; x: number; y: number }[] };
const fixture = JSON.parse(readFileSync(new URL('./fixtures/fire-features.json', import.meta.url), 'utf8')) as Reference;
const parity = JSON.parse(readFileSync(new URL('./fixtures/fire-model-parity.json', import.meta.url), 'utf8')) as { modelSha256: string; vectors: (number | null)[][]; probabilities: number[] };
const modelText = readFileSync(new URL('../public/data/ml/model.json', import.meta.url), 'utf8');
const model = JSON.parse(modelText) as FittedFireModel;
const evaluation = JSON.parse(readFileSync(new URL('../public/data/ml/evaluation.json', import.meta.url), 'utf8')) as { test: { model: { cells: number } } };
const weather: WeatherCell = { precip: 0, tmin: 273.15, tmax: 300.15, q: .005, wind: 8, direction: 0, erc: 50, pdsi: -1 };
const gfs: AntecedentCell = { temperatureC: 22, q: .007, vectorWind: 4 };
function close(actual: number, expected: number, tolerance: number, label: string) {
  assert.ok(Number.isFinite(actual), `${label}: received nonfinite ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} differs from ${expected} by ${Math.abs(actual - expected)}`);
}
function predictCase(item: FeatureCase, query: FeatureQuery) {
  return makeFireFeatures(query.row, query.col, item.size, item.recent, item.prior, item.elevation, query.weather, query.gfs);
}

test('every held-out Python model probability matches the deployed JavaScript model', () => {
  assert.equal(createHash('sha256').update(modelText).digest('hex'), parity.modelSha256, 'Regenerate parity fixtures when replacing the model; do not compare a stale export.');
  assert.equal(parity.vectors.length, evaluation.test.model.cells, 'Parity must cover every held-out cell, without sampling.');
  assert.equal(parity.probabilities.length, parity.vectors.length);
  assert.ok(parity.vectors.length >= 80);
  assert.deepEqual(model.features, fixture.featureNames);
  parity.vectors.forEach((vector, index) => {
    close(predictFire(model, vector), parity.probabilities[index], 5e-12, `held-out vector ${index}`);
  });
});

test('fitted prior-distance splits are inside the dynamically fetched live context', () => {
  const index = model.features.indexOf('distance_prior_km');
  assert.ok(index >= 0);
  const thresholds = model.trees.flatMap(tree => tree.filter(node => !node[6] && node[1] === index).map(node => node[2]));
  assert.ok(thresholds.length > 0);
  const coveredDistance = (8.5 + priorContextPadding(model)) * 1.5 - 1.5;
  assert.ok(Math.max(...thresholds) < coveredDistance);
  for (const original of parity.vectors) {
    const bounded = [...original], sentinel = [...original];
    bounded[index] = coveredDistance;
    sentinel[index] = 150;
    assert.equal(predictFire(model, bounded), predictFire(model, sentinel), 'An unseen fire outside the fetched context must not alter a tree decision.');
  }
});

for (const item of fixture.cases) {
  test(`Python/JavaScript feature construction: ${item.name}`, () => {
    for (const query of item.queries) {
      const actual = predictCase(item, query);
      assert.equal(actual.length, fixture.featureNames.length);
      query.expected.forEach((expected, index) => {
        const label = `${item.name} [${query.row},${query.col}] ${fixture.featureNames[index]}`;
        if (expected === null) assert.equal(actual[index], null, label);
        else close(actual[index]!, expected, 1e-10, label);
      });
      // Trees can split on tiny rounding differences in rational densities;
      // tolerance-only feature comparisons are insufficient for this contract.
      assert.equal(actual[4], query.expected[4], '3x3 density must be the identical integer count /9');
      assert.equal(actual[5], query.expected[5], '7x7 density must be the identical integer count /49');
      close(predictFire(model, actual), predictFire(model, query.expected), 5e-12,
        `${item.name} [${query.row},${query.col}] feature-to-score parity`);
    }
  });
}

test('nearest-fire ties choose the first row-major point, including its elevation and compass offset', () => {
  const size = 3, recent = Array<boolean>(size * size).fill(false);
  recent[1] = true; // north of the query; first in row-major order
  recent[3] = true; // west of the query; equal distance
  const elevation = [100, 200, 300, 700, 800, 900, 1000, 1100, 1200];
  const f = makeFireFeatures(1, 1, size, recent, Array(9).fill(false), elevation, weather, gfs);
  assert.equal(f[2], 1.5);
  assert.equal(f[6], 0);
  assert.equal(f[7], -1.5); // queried cell is south of its nearest fire
  assert.equal(f[12], 600);
  assert.equal(f[3], 150);
});

test('density uses fixed zero-padded neighborhoods, including finite domain edges', () => {
  const mask = Array<boolean>(25).fill(true), elevation = Array<number>(25).fill(10);
  const corner = makeFireFeatures(0, 0, 5, mask, mask, elevation, weather, gfs);
  const center = makeFireFeatures(2, 2, 5, mask, mask, elevation, weather, gfs);
  assert.equal(corner[4], 4 / 9);
  assert.equal(corner[5], 16 / 49);
  assert.equal(center[4], 1);
  assert.equal(center[5], 25 / 49);
});

test('terrain slope and downslope compass aspect have physical scale at interior and boundaries', () => {
  const size = 5, mask = Array<boolean>(25).fill(false); mask[12] = true;
  const elevation = Array.from({ length: 25 }, (_, i) => 1000 + 30 * (i % size) + 15 * Math.floor(i / size));
  for (const [row, col] of [[0, 0], [0, 4], [2, 2], [4, 0], [4, 4]]) {
    const f = makeFireFeatures(row, col, size, mask, mask, elevation, weather, gfs);
    close(f[9]!, Math.atan(Math.hypot(.02, .01)) * 180 / Math.PI, 1e-12, 'slope');
    close(f[10]!, -.02 / Math.hypot(.02, .01), 1e-12, 'downslope west component');
    close(f[11]!, .01 / Math.hypot(.02, .01), 1e-12, 'downslope north component');
  }
});

test('wind wraps continuously through north and Kelvin temperatures convert exactly once', () => {
  const mask = Array<boolean>(9).fill(true), elevation = Array<number>(9).fill(10);
  const features = (direction: number) => makeFireFeatures(1, 1, 3, mask, mask, elevation, { ...weather, direction }, gfs);
  const a = features(359), b = features(-1), north = features(360);
  close(a[18]!, b[18]!, 1e-14, '359deg and -1deg wind sine');
  close(a[19]!, b[19]!, 1e-14, '359deg and -1deg wind cosine');
  close(north[18]!, 0, 1e-14, 'north sine');
  close(north[19]!, 1, 1e-14, 'north cosine');
  assert.equal(a[14], 0);
  close(a[15]!, 27, 1e-12, 'gridMET K to C');
  assert.equal(a[22], 22, 'GFS training feature is already Celsius');
});

test('WGS84 UTM agrees with pyproj across CONUS and either side of a zone boundary', () => {
  for (const expected of fixture.projections) {
    const actual = toUtm(expected.lat, expected.lon);
    assert.equal(actual.zone, expected.zone);
    close(actual.x, expected.x, .02, `easting ${expected.lat},${expected.lon}`);
    close(actual.y, expected.y, .02, `northing ${expected.lat},${expected.lon}`);
    const [lon, lat] = fromUtm(expected.x, expected.y, expected.zone);
    close(lat, expected.lat, 1e-7, 'inverse latitude');
    close(lon, expected.lon, 1e-7, 'inverse longitude');
    const [roundLon, roundLat] = fromUtm(actual.x, actual.y, actual.zone);
    close(roundLat, expected.lat, 1e-7, 'round-trip latitude');
    close(roundLon, expected.lon, 1e-7, 'round-trip longitude');
  }
});

test('date protocol separates prior observations, issue day and next-day target across boundaries', () => {
  assert.deepEqual(outlookDates('2026-01-01'), { issueDate: '2026-01-01', targetDate: '2026-01-02', recentFireDate: '2025-12-31', priorFireDate: '2025-12-30', weatherDate: '2025-12-30' });
  assert.deepEqual(outlookDates('2024-03-01'), { issueDate: '2024-03-01', targetDate: '2024-03-02', recentFireDate: '2024-02-29', priorFireDate: '2024-02-28', weatherDate: '2024-02-28' });
  assert.equal(outlookDates('2024-02-29').targetDate, '2024-03-01');
  assert.equal(outlookDates('2026-12-31').targetDate, '2027-01-01');
  for (const invalid of ['', '2026-02-29', '2026-02-30', '2026-13-01', '2026-2-01', '2026-10-23T00:00:00Z']) {
    assert.throws(() => outlookDates(invalid), /Invalid issue date/);
  }
});

test('tree traversal preserves equality, learned missing branches and Platt calibration', () => {
  const tiny: FittedFireModel = { id: 'unit-test-only', features: ['x'], base: .1, threshold: .5,
    trees: [[[0, 0, .5, 1, 1, 2, 0], [.7, 0, 0, 0, 0, 0, 1], [-.2, 0, 0, 0, 0, 0, 1]]], calibration: { slope: 2, intercept: -.3 } };
  const expectedLeft = 1 / (1 + Math.exp(-(2 * .8 - .3)));
  const expectedRight = 1 / (1 + Math.exp(-(2 * -.1 - .3)));
  close(predictFire(tiny, [.5]), expectedLeft, 1e-14, 'threshold equality');
  close(predictFire(tiny, [.50001]), expectedRight, 1e-14, 'greater-than branch');
  for (const value of [null, NaN, Infinity]) close(predictFire(tiny, [value]), expectedLeft, 1e-14, 'missing branch');
  tiny.trees[0][0][3] = 0;
  close(predictFire(tiny, [null]), expectedRight, 1e-14, 'missing goes right');
});

test('invalid model schema and cyclic tree fail instead of producing misleading scores', () => {
  assert.throws(() => predictFire(model, []), /schema mismatch/);
  const malformed: FittedFireModel = { id: 'invalid-test-only', features: ['x'], base: 0, threshold: .5,
    calibration: { slope: 1, intercept: 0 }, trees: [[[0, 0, .5, 1, 0, 0, 0]]] };
  assert.throws(() => predictFire(malformed, [1]), /cycle/);
  malformed.trees[0][0][5] = 30;
  assert.throws(() => predictFire(malformed, [1]), /Invalid fitted tree/);
});

test('v2 persistence mixture follows calibration and preserves exact endpoint behavior', () => {
  const base: FittedFireModel = { id: 'mixture-test-only', features: ['fire_recent'], base: .4, threshold: .05,
    trees: [], calibration: { slope: 1, intercept: -.7 }, mixture: { treeWeight: .25, baselineFeatureIndex: 0, baselineRates: [.02, .6] } };
  const calibrated = 1 / (1 + Math.exp(.3));
  close(predictFire(base, [0]), .25 * calibrated + .75 * .02, 1e-14, 'absent recent fire');
  close(predictFire(base, [1]), .25 * calibrated + .75 * .6, 1e-14, 'present recent fire');
  base.mixture!.treeWeight = 0;
  assert.equal(predictFire(base, [1]), .6);
  base.mixture!.treeWeight = 1;
  close(predictFire(base, [1]), calibrated, 1e-14, 'pure calibrated tree');
  for (const weight of [-.1, 1.1, NaN]) {
    base.mixture!.treeWeight = weight;
    assert.throws(() => predictFire(base, [1]), /Invalid fitted persistence mixture/);
  }
  base.mixture!.treeWeight = .5;
  for (const value of [null, .5, 2]) assert.throws(() => predictFire(base, [value]), /Invalid fitted persistence mixture/);
});
