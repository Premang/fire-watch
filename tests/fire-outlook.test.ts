import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";

// Resolve the application's source aliases/JSON imports without a dev server.
const root = fileURLToPath(new URL("../", import.meta.url));
const hooks = registerHooks({
  resolve(specifier, context, next) {
    let path: string | undefined;
    if (specifier.startsWith("@/")) path = `${root}${specifier.slice(2)}`;
    else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) path = fileURLToPath(new URL(specifier, context.parentURL));
    if (path && !existsSync(path) && existsSync(`${path}.ts`)) path += ".ts";
    return next(path ? pathToFileURL(path).href : specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("file:") && url.endsWith(".json")) return { format: "module", source: `export default ${readFileSync(fileURLToPath(url), "utf8")}`, shortCircuit: true };
    return next(url, context);
  },
});
// @ts-expect-error Explicit source extension supports the direct Node test runner.
const { createFireOutlook, fireMask, pointCell } = await import("../lib/fire-outlook.ts");
// @ts-expect-error Explicit source extension supports the direct Node test runner.
const { toUtm, fromUtm } = await import("../lib/fire-predictor.ts");
// @ts-expect-error Explicit source extension supports the direct Node test runner.
const { GET } = await import("../app/api/prediction/route.ts");
hooks.deregister();

const DAY = 86400000;
const date = (at: number) => new Date(at).toISOString().slice(0, 10);
type Scenario = { extraRow?: (issue: string) => string; platform?: string; confidence?: string; lowRecentOnly?: boolean; failCode?: string; gridLagDays?: number; pdsiLagDays?: number; fallbackGfs?: boolean; noRecent?: boolean; noPriorDay?: boolean; malformedPriorTime?: boolean; noTerrain?: boolean; hour?: number; at?: string; healthGap?: 'recent' | 'prior'; noHealth?: boolean };
let scenarioDay = 0;
function fixture(t: TestContext, options: Scenario = {}) {
  // Distinct UTC days prevent cross-test source caches from hiding failures.
  const defaultTime = Date.UTC(2026, 7, 10 + scenarioDay++) + (options.hour ?? 7) * 3600000;
  const now = options.at ? Date.parse(options.at) : defaultTime, midnight = Math.floor(now / DAY) * DAY;
  const issue = date(midnight), weatherDate = date(midnight - 2 * DAY), calls: string[] = [];
  t.mock.method(Date, "now", () => now);
  const raw: Record<string, number> = { pr: 1, tmmn: 285, tmmx: 300, sph: .006, vs: 3, th: 90, erc: 50, pdsi: -1, fm100: 10, fm1000: 8 };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); calls.push(url.toString());
    if (url.hostname === "modaps.modaps.eosdis.nasa.gov") {
      if (options.noHealth) return new Response("Unavailable", { status: 503 });
      const gap = new Date(options.healthGap ? midnight - (options.healthGap === 'recent' ? 1 : 2) * DAY : Date.UTC(2025, 0, 1));
      const doy = Math.floor((gap.getTime() - Date.UTC(gap.getUTCFullYear(), 0, 1)) / DAY) + 1;
      const updated = new Date(midnight).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
      return new Response(`<p>Last Update: ${updated}</p><table summary="VIIRS/NOAA-20(NOAA20) Data Outages Since Start of NOAA-20 Mission"><tr><th>Year-Day</th><th>Date</th><th>Start Time (UTC)</th><th>End Time (UTC)</th><th>Comments</th></tr><tr><td>${gap.getUTCFullYear()}-${String(doy).padStart(3, '0')}</td><td>${date(gap.getTime())}</td><td>00:12:00</td><td>02:06:00</td><td>Missing science granules</td></tr></table>`);
    }
    if (url.hostname === "elevation.nationalmap.gov") {
      if (options.noTerrain) return new Response("Unavailable", { status: 503 });
      const body = new URLSearchParams(String(init?.body));
      const points = (JSON.parse(body.get("geometry")!) as { points: [number, number][] }).points;
      return Response.json({ samples: points.map(([x, y], locationId) => ({ locationId, location: { x, y }, value: "400", resolution: 1 / 3600, attributes: { VerticalDatum: "NAVD88", AcquisitionDate: Date.UTC(2020, 0, 1) } })) });
    }
    if (url.hostname === "api.weather.gov") return Response.json({ features: [] });
    if (url.pathname === "/v1/elevation") {
      const count = url.searchParams.get("latitude")!.split(",").length;
      if (options.noTerrain && count > 1) return new Response("Unavailable", { status: 503 });
      return Response.json({ elevation: Array(count).fill(400) });
    }
    if (url.hostname.includes("single-runs")) {
      const run = url.searchParams.get("run")!;
      if (options.fallbackGfs && run.startsWith(issue)) return new Response("Unavailable", { status: 404 });
      return Response.json({ latitude: 39.8, longitude: -121.6, elevation: 400, utc_offset_seconds: 0,
        hourly_units: { temperature_2m: "°C", dew_point_2m: "°C", surface_pressure: "hPa", wind_speed_10m: "m/s", precipitation: "mm" },
        hourly: { time: Array.from({ length: 72 }, (_, i) => new Date(Date.parse(`${run}Z`) + i * 3600000).toISOString().slice(0, 16)), temperature_2m: Array(72).fill(20), dew_point_2m: Array(72).fill(5), surface_pressure: Array(72).fill(950), relative_humidity_2m: Array(72).fill(40), wind_speed_10m: Array(72).fill(3), wind_direction_10m: Array(72).fill(90), wind_gusts_10m: Array(72).fill(5), precipitation: [null, ...Array(71).fill(0)] } });
    }
    if (url.hostname === "firms.modaps.eosdis.nasa.gov") {
      const rows = [`latitude,longitude,acq_date,acq_time,satellite,instrument,confidence,frp,daynight`];
      const sat = options.platform ?? "N20", conf = options.confidence ?? "nominal";
      if (options.lowRecentOnly) rows.push(`39.8,-121.6,${date(midnight - DAY)},2000,${sat},VIIRS,low,10,D`);
      else if (!options.noRecent) rows.push(`39.8,-121.6,${date(midnight - DAY)},2000,${sat},VIIRS,${conf},10,D`);
      else rows.push(`30,-90,${date(midnight - DAY)},2000,${sat},VIIRS,${conf},10,D`);
      if (!options.noPriorDay) rows.push(`39.8,-121.6,${weatherDate},${options.malformedPriorTime ? "9999" : "2000"},${sat},VIIRS,nominal,10,D`);
      rows.push(`30,-90,${issue},0400,${sat},VIIRS,high,10,N`);
      if (options.extraRow) rows.push(options.extraRow(issue));
      return new Response(rows.join("\n"));
    }
    if (url.hostname === "thredds.northwestknowledge.net") {
      const code = url.pathname.match(/agg_met_(\w+)_1979/)?.[1]; assert.ok(code);
      if (code === options.failCode) return new Response("Unavailable", { status: 503 });
      const sourceDate = midnight - (2 + (code === "pdsi" ? options.pdsiLagDays ?? 2 : options.gridLagDays ?? 0)) * DAY;
      if (url.pathname.endsWith("dataset.xml")) return new Response(`<gridDataset><axis name="day"><values start="${(sourceDate - Date.UTC(1900, 0, 1)) / DAY}" increment="1" npts="1" /></axis><axis name="lat"><values start="40.4" increment="${-1 / 24}" npts="31" /></axis><axis name="lon"><values start="-122.4" increment="${1 / 24}" npts="50" /></axis><grid name="v_${code}" desc="${code}"><attribute name="units" value="1" /><attribute name="scale_factor" value="1" /><attribute name="add_offset" value="0" /><attribute name="_FillValue" value="32767" /></grid></gridDataset>`);
      const matches = [...decodeURIComponent(url.search).matchAll(/\[(\d+):1:(\d+)\]/g)];
      const rows = Number(matches[1][2]) - Number(matches[1][1]) + 1, columns = Number(matches[2][2]) - Number(matches[2][1]) + 1;
      return new Response(`Dataset { v_${code} }\n---------------------------------------------\nv_${code}.v_${code}[1][${rows}][${columns}]\n${Array.from({ length: rows }, (_, i) => `[0][${i}], ${Array(columns).fill(raw[code]).join(", ")}`).join("\n")}\n`);
    }
    throw new Error(`Unexpected upstream: ${url}`);
  });
  return { now, issue, weatherDate, calls };
}

test("live outlook produces bounded next-day cells only with complete required sources", async t => {
  const f = fixture(t), out = await createFireOutlook(39.8, -121.6);
  assert.equal(out.status, "experimental"); assert.deepEqual(out.reasons, []);
  assert.equal(out.issueDate, f.issue); assert.equal(out.targetDate, date(Date.parse(f.issue) + DAY));
  assert.equal(out.weatherDate, f.weatherDate); assert.ok(out.cells.length > 0 && out.cells.length <= 289);
  assert.ok(out.cells.every(cell => Number.isFinite(cell.p) && cell.p >= 0 && cell.p <= 1 && cell.polygon.length === 5));
  assert.equal(out.inputs?.gfs?.antecedent.forecastHourStart, 1); assert.equal(out.inputs?.gfs?.antecedent.forecastHourEnd, 24);
  assert.equal(out.satelliteHealth?.status, "no-reported-gap"); assert.equal(out.satelliteHealth?.observationalCoverage, "unknown");
  assert.equal(out.featureCoverage.completeCells, out.cells.length); assert.ok(f.calls.length <= 40);
});
test("a missing required GRIDMET field causes abstention before terrain retrieval", async t => {
  const f = fixture(t, { failCode: "sph" }), out = await createFireOutlook(39.8, -121.6);
  assert.equal(out.status, "abstained"); assert.equal(out.cells.length, 0);
  assert.ok(out.reasons.some(reason => reason.includes("sph")));
  assert.equal(f.calls.filter(url => url.includes("/v1/elevation")).length, 1);
});
test("a previous-day forecast is context only and cannot drive inference", async t => {
  fixture(t, { fallbackGfs: true }); const out = await createFireOutlook(39.8, -121.6);
  assert.equal(out.status, "abstained"); assert.equal(out.inputs?.gfs?.status, "stale"); assert.equal(out.cells.length, 0);
  assert.ok(out.reasons.some(reason => reason.includes("older run")));
});
test("daily GRIDMET cannot silently substitute an older analysis", async t => {
  fixture(t, { gridLagDays: 1 }); const out = await createFireOutlook(39.8, -121.6);
  assert.equal(out.status, "abstained"); assert.ok(out.reasons.some(reason => reason.includes("required lagged date")));
});
test("a missing national source day is unknown, not an empty fire mask", async t => {
  fixture(t, { noPriorDay: true }); const out = await createFireOutlook(39.8, -121.6);
  assert.equal(out.status, "abstained"); assert.ok(out.reasons.some(reason => reason.includes("required NOAA-20 day")));
});
test("no recent local detections abstains without an existing-fire starting pattern", async t => {
  fixture(t, { noRecent: true }); const out = await createFireOutlook(39.8, -121.6);
  assert.equal(out.status, "abstained"); assert.ok(out.reasons.some(reason => reason.includes("starting pattern")));
});
test("a terrain source failure cannot turn into a zero-height forecast", async t => {
  fixture(t, { noTerrain: true }); const out = await createFireOutlook(39.85, -121.6);
  assert.equal(out.status, "abstained"); assert.ok(out.reasons.some(reason => reason.includes("Terrain grid")));
});
test("invalid public requests and outside-domain points do not call upstream services", async t => {
  const f = fixture(t);
  for (const query of ["lat=&lon=-121", "lat=Infinity&lon=-121", "lat=40&lon=20"]) {
    const response = await GET(new Request(`https://ember.test/api/prediction?${query}`)); assert.equal(response.status, 400);
  }
  const out = await createFireOutlook(65, -150); assert.equal(out.status, "abstained"); assert.equal(f.calls.length, 0);
});
for (const age of [0, 6]) test(`PDSI age${age} days cannot enter live inference`, async t => {
  fixture(t, { pdsiLagDays: age }); const out = await createFireOutlook(39.8, -121.6);
  assert.equal(out.status, "abstained"); assert.equal(out.cells.length, 0);
  assert.ok(out.reasons.some(reason => reason.toLowerCase().includes("pdsi")));
  if (age === 0) assert.equal(out.inputs?.gridmet.grids.pdsi, undefined);
  else assert.equal(out.inputs?.sources.find(source => source.id === "gridmet:pdsi")?.status, "stale");
});
test("PDSI from five days before the weather day remains eligible at a pentad boundary", async t => {
  const f = fixture(t, { pdsiLagDays: 5 }), out = await createFireOutlook(39.8, -121.6);
  assert.equal(out.inputs?.gridmet.grids.pdsi?.date, date(Date.parse(f.weatherDate) - 5 * DAY));
  assert.equal(out.status, "experimental"); assert.ok(out.cells.length > 0); assert.deepEqual(out.reasons, []);
});
test("before06UTC the current-day GFS run is ineligible and the outlook abstains", async t => {
  fixture(t, { hour: 5 + 59 / 60 }); const out = await createFireOutlook(39.8, -121.6);
  assert.equal(out.status, "abstained"); assert.equal(out.cells.length, 0);
  assert.ok(out.reasons.some(reason => reason.includes("not eligible until06:00UTC")));
});
test("a malformed prior-day acquisition time does not establish national day availability", async t => {
  fixture(t, { malformedPriorTime: true }); const out = await createFireOutlook(39.8, -121.6);
  assert.equal(out.status, "abstained"); assert.equal(out.cells.length, 0); assert.equal(out.fireSource?.priorCount, 0);
  assert.ok(out.reasons.some(reason => reason.includes("required NOAA-20 day has no source records")));
});
test("NOAA-20 inputs keep the outlook available after the S-NPP stop time", async t => {
  const f = fixture(t, { at: "2026-11-03T07:00:00Z" }); const out = await createFireOutlook(39.8, -121.6);
  assert.equal(out.status, "experimental"); assert.deepEqual(out.reasons, []); assert.ok(out.cells.length > 0);
  assert.equal(out.fireSource?.sensor, "VIIRS NOAA-20");
  assert.ok(f.calls.some(url => url.includes("/noaa-20-viirs-c2/") && url.includes("J1_VIIRS_C2")));
  assert.ok(!f.calls.some(url => url.includes("suomi-npp")));
  assert.ok(f.calls.some(url => url.endsWith("/outages_noaa_20.html")));
  assert.equal(out.satelliteHealth?.sourceUrl, "https://modaps.modaps.eosdis.nasa.gov/services/production/outages_noaa_20.html");
  assert.ok(out.warnings.some(w => w.includes("trained on S-NPP") && w.includes("calibration is unproven")));
  assert.ok(out.warnings.some(w => w.includes("no fire-type field")));
});
test("rows from another platform (legacy S-NPP code) fail closed", async t => {
  fixture(t, { platform: "N" }); const out = await createFireOutlook(39.8, -121.6);
  assert.equal(out.status, "abstained"); assert.equal(out.cells.length, 0);
  assert.ok(out.reasons.some(reason => reason.includes("Unexpected platform")));
});
test("an unrecognized confidence vocabulary fails closed instead of emptying the masks", async t => {
  fixture(t, { confidence: "medium" }); const out = await createFireOutlook(39.8, -121.6);
  assert.equal(out.status, "abstained"); assert.ok(out.reasons.some(reason => reason.includes("Unsupported NOAA-20 confidence")));
});
test("another platform with a malformed acquisition time still fails the whole feed closed", async t => {
  fixture(t, { extraRow: issue => `30,-90,${issue},9999,N21,VIIRS,nominal,10,N` }); const out = await createFireOutlook(39.8, -121.6);
  assert.equal(out.status, "abstained"); assert.ok(out.reasons.some(reason => reason.includes("Unexpected platform")));
});
test("an unrecognized confidence outside the two mask days still fails the whole feed closed", async t => {
  fixture(t, { extraRow: issue => `30,-90,${issue},0500,N20,VIIRS,medium,10,N` }); const out = await createFireOutlook(39.8, -121.6);
  assert.equal(out.status, "abstained"); assert.ok(out.reasons.some(reason => reason.includes("Unsupported NOAA-20 confidence")));
});
test("low-confidence detections are excluded from the fire masks", async t => {
  fixture(t, { lowRecentOnly: true }); const out = await createFireOutlook(39.8, -121.6);
  assert.equal(out.status, "abstained"); assert.equal(out.fireSource?.recentCount, 0);
  assert.ok(out.reasons.some(reason => reason.includes("starting pattern")));
});
test("point-centre rasterization matches the evaluated NOAA-20 masks and never spills into neighbours", () => {
  const left = 600000, top = 4400000;
  assert.deepEqual(pointCell(left + 1, top - 1, left, top), [0, 0]);
  assert.deepEqual(pointCell(left + 1499.9, top - 1499.9, left, top), [0, 0]);
  assert.deepEqual(pointCell(left + 1500, top - 1500, left, top), [1, 1]);
  assert.deepEqual(pointCell(left - .1, top + .1, left, top), [-1, -1]);
  // A detection 100 m inside a cell edge occupies one cell (the old 375 m footprint occupied two).
  const zone = 10, x = left + 1500 * 3 + 100, y = top - 1500 * 5 - 750;
  const point = { lat: 0, lon: 0, acquiredAt: "2026-11-02T20:00:00Z" } as { lat: number; lon: number; acquiredAt: string };
  // Invert with the app's own projection, then confirm the round trip used by fireMask.
  const [lon, lat] = fromUtm(x, y, zone), back = toUtm(lat, lon, zone);
  assert.ok(Math.hypot(back.x - x, back.y - y) < 0.01, "projection round trip");
  point.lat = lat; point.lon = lon;
  const mask = fireMask([point] as never, "2026-11-02", zone, left, top, 10);
  assert.equal(mask.filter(Boolean).length, 1); assert.equal(mask[5 * 10 + 3], true);
});
for (const healthGap of ['recent', 'prior'] as const) test(`a known partial-day ${healthGap} satellite gap blocks inference even when national records are fresh`, async t => {
  const f = fixture(t, { healthGap }), out = await createFireOutlook(39.8, -121.6);
  assert.equal(out.status, 'abstained'); assert.equal(out.cells.length, 0);
  assert.equal(out.fireSource?.recentCount, 1); assert.equal(out.fireSource?.priorCount, 1);
  assert.equal(out.satelliteHealth?.status, 'reported-gap');
  assert.ok(out.reasons.some(reason => reason.includes('NASA-reported outage') && reason.includes('Geographic impact is unknown')));
  assert.ok(!f.calls.some(url => url.includes('elevation.nationalmap.gov')));
});
test('unavailable satellite source health blocks inference before terrain retrieval', async t => {
  const f = fixture(t, { noHealth: true }), out = await createFireOutlook(39.8, -121.6);
  assert.equal(out.status, 'abstained'); assert.equal(out.cells.length, 0);
  assert.equal(out.satelliteHealth?.status, 'unavailable');
  assert.ok(out.reasons.some(reason => reason.includes('source health is unavailable')));
  assert.ok(!f.calls.some(url => url.includes('elevation.nationalmap.gov')));
});
test("live displacement/aspect vectors are re-expressed in true-north axes (pyproj parity)", async () => {
  // @ts-expect-error Explicit source extension supports the direct Node test runner.
  const { toGeographicAxes, northOffset } = await import("../lib/fire-predictor.ts");
  const { cases } = JSON.parse(readFileSync(new URL("./fixtures/geographic-axes.json", import.meta.url), "utf8")) as { cases: { lon: number; lat: number; zone: number; localNorthOffsetDeg: number; zone10RotationDeg: number; local: [number, number]; geographic: [number, number] }[] };
  assert.ok(cases.some(c => c.zone10RotationDeg < -40), "fixture covers New England, where zone-10 axes are ~45 deg off true north");
  assert.ok(cases.some(c => Math.abs(c.localNorthOffsetDeg) > 1.5), "fixture covers zone edges");
  for (const c of cases) {
    const offDeg = northOffset(c.zone, c.lon, c.lat) * 180 / Math.PI;
    assert.ok(Math.abs(offDeg - c.localNorthOffsetDeg) < 0.01, `convergence ${offDeg} vs pyproj ${c.localNorthOffsetDeg} at ${c.lon},${c.lat}`);
    const [e, n] = toGeographicAxes(c.local[0], c.local[1], c.lon, c.lat, c.zone);
    assert.ok(Math.hypot(e - c.geographic[0], n - c.geographic[1]) < 1e-3 * Math.hypot(...c.geographic), `vector mismatch at ${c.lon},${c.lat}`);
  }
});
test("flat terrain keeps the training aspect placeholder; downwind stays aligned with geographic wind", async () => {
  // @ts-expect-error Explicit source extension supports the direct Node test runner.
  const { alignFeatureAxes, toGeographicAxes } = await import("../lib/fire-predictor.ts");
  const flat = Array(25).fill(1) as (number | null)[]; flat[9] = 0; flat[10] = -0; flat[11] = 1; flat[6] = 3; flat[7] = 0;
  alignFeatureAxes(flat, -67.5, 44.9, 19);
  assert.equal(flat[10], -0); assert.equal(flat[11], 1);  // unchanged placeholder
  assert.notEqual(flat[6], 3);                             // displacement still rotated
  const sloped = Array(25).fill(1) as (number | null)[]; sloped[9] = 4; sloped[10] = 0; sloped[11] = 1;
  alignFeatureAxes(sloped, -67.5, 44.9, 19);
  assert.ok(Math.abs(Math.hypot(sloped[10]!, sloped[11]!) - 1) < 1e-12 && sloped[10] !== 0);
  // A cell due geographic-east of the fire, under a wind blowing from geographic west, is downwind.
  const [lon, lat, zone] = [-71.1, 42.4, 19], eastLocal = toGeographicAxes(1, 0, lon, lat, zone);
  const inv = (v: [number, number]) => { const t = -Math.atan2(eastLocal[1], eastLocal[0]); return [v[0] * Math.cos(t) - v[1] * Math.sin(t), v[0] * Math.sin(t) + v[1] * Math.cos(t)]; };
  const [e, n] = toGeographicAxes(...(inv([1, 0]) as [number, number]), lon, lat, zone);
  const windFrom = 270 * Math.PI / 180, downwind = -(e * Math.sin(windFrom) + n * Math.cos(windFrom));
  assert.ok(downwind > 0.999, `downwind alignment ${downwind}`);
});
test("origin snapping is deterministic and masks translate exactly by whole cells", () => {
  const left = 417000, top = 5119500;
  for (const [dx, dy] of [[0, 0], [1500, 0], [0, -1500], [4500, -3000]]) {
    const [r, c] = pointCell(left + 700 + dx, top - 800 + dy, left, top);
    assert.deepEqual([r, c], [0 - dy / 1500, 0 + dx / 1500]);
  }
});
