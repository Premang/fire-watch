import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Explicit source extension supports the direct Node test runner.
import { deriveGfsAntecedent, deriveGfsDaily, fetchGfsPoint, fetchGridmetArea, fetchPredictionInputs, normalizeFireAlerts, normalizeGfsResponse, parseGridmetAscii, parseGridmetMetadata, parsePredictionLocation, selectGfsCycle, specificHumidityFromDewpoint } from "../lib/prediction-inputs.ts";
import type { GridmetCode, GfsHour } from "../lib/prediction-inputs";

const now = Date.parse("2026-10-23T06:30:00Z");
const dayNumber = (date: string) => (Date.parse(date) - Date.UTC(1900, 0, 1)) / 86400000;
function metadata(code: GridmetCode = "sph") {
  const [variable, scale, offset] = code === "pdsi" ? ["daily_mean_palmer_drought_severity_index", .01, -15] : code === "erc" ? ["daily_mean_energy_release_component-g", 1, 0] : ["daily_mean_specific_humidity", .00001, 0];
  const dayAxis = code === "pdsi" ? `<values>${dayNumber("2026-10-12")} ${dayNumber("2026-10-17")}</values>` : `<values start="${dayNumber("2026-10-20")}" increment="1" npts="2" />`;
  return `<gridDataset><axis name="day">${dayAxis}</axis><axis name="lat"><values start="39.85" increment="-0.05" npts="3" /></axis><axis name="lon"><values start="-121.65" increment="0.05" npts="3" /></axis><grid name="${variable}" desc="${code}"><attribute name="units" value="kg/kg" /><attribute name="scale_factor" value="${scale}" /><attribute name="add_offset" value="${offset}" /><attribute name="_FillValue" value="32767" /></grid></gridDataset>`;
}
function ascii(variable: string, values = [[751]]) { return `Dataset { ${variable} }
---------------------------------------------
${variable}.${variable}[1][${values.length}][${values[0].length}]
${values.map((row, i) => `[0][${i}], ${row.join(", ")}`).join("\n")}

${variable}.day[1]
46314
`; }
function gfsFixture(run = "2026-10-23T00:00:00Z", count = 72) {
  return { latitude: 39.7722, longitude: -121.640625, elevation: 674, utc_offset_seconds: 0,
    hourly_units: { temperature_2m: "°C", dew_point_2m: "°C", surface_pressure: "hPa", wind_speed_10m: "m/s", precipitation: "mm" },
    hourly: { time: Array.from({ length: count }, (_, i) => new Date(Date.parse(run) + i * 3600000).toISOString().slice(0, 16)), temperature_2m: Array(count).fill(10), dew_point_2m: Array(count).fill(5), surface_pressure: Array(count).fill(1000), relative_humidity_2m: Array(count).fill(70), wind_speed_10m: Array(count).fill(2), wind_direction_10m: Array(count).fill(90), wind_gusts_10m: Array(count).fill(4), precipitation: [null, ...Array(count - 1).fill(0)] } };
}
function hours24(): GfsHour[] { return normalizeGfsResponse(gfsFixture(), "2026-10-23T00:00:00Z", "2026-10-23", "https://example.test", new Date(now).toISOString()).hourly.slice(0, 24); }

test("point parameters reject blanks, nonfinite numbers and out-of-envelope coordinates", () => {
  assert.deepEqual(parsePredictionLocation(new URLSearchParams("lat=39.8&lon=-121.6")), { lat: 39.8, lon: -121.6 });
  for (const value of ["lat=&lon=-121", "lat=Infinity&lon=-121", "lat=91&lon=-121", "lat=40&lon=20"]) assert.equal(parsePredictionLocation(new URLSearchParams(value)), null);
});
test("GFS00Z eligibility uses UTC and never selects a run less than six hours old", () => {
  assert.equal(selectGfsCycle(Date.parse("2026-10-23T05:59:59Z")), "2026-10-22T00:00:00.000Z");
  assert.equal(selectGfsCycle(Date.parse("2026-10-23T06:00:00Z")), "2026-10-23T00:00:00.000Z");
  assert.equal(selectGfsCycle(Date.parse("2026-10-22T23:00:00-07:00")), "2026-10-23T00:00:00.000Z");
});
test("specific humidity uses dewpoint and pressure in physical units and keeps missing inputs missing", () => {
  const q = specificHumidityFromDewpoint(20, 100000)!; assert.ok(q > .014 && q < .015);
  assert.ok(specificHumidityFromDewpoint(20, 85000)! > q);
  assert.equal(specificHumidityFromDewpoint(null, 100000), null);
  assert.equal(specificHumidityFromDewpoint(20, 1000), null);
});
test("GFS normalization preserves first-hour rain null, source initialization and vector direction", () => {
  const d = normalizeGfsResponse(gfsFixture(), "2026-10-23T00:00:00Z", "2026-10-23", "https://example.test", new Date(now).toISOString());
  assert.equal(d.hourly[0].temperatureK, 283.15); assert.equal(d.hourly[0].surfacePressurePa, 100000);
  assert.equal(d.hourly[0].precipMm, null); assert.equal(d.sourcePublishedAt, null);
  assert.ok(Math.abs(d.hourly[0].uMs! + 2) < 1e-10); assert.ok(Math.abs(d.hourly[0].vMs!) < 1e-10);
  const invalid = gfsFixture(); invalid.hourly_units.wind_speed_10m = "km/h";
  assert.throws(() => normalizeGfsResponse(invalid, "2026-10-23T00:00:00Z", "2026-10-23", "x", "x"), /units/);
});
test("daily summaries require 24 distinct hours and distinguish scalar wind from vector mean", () => {
  const hours = hours24().map((hour, i) => ({ ...hour, uMs: i % 2 ? 2 : -2, vMs: 0 }));
  const complete = deriveGfsDaily([...hours, hours[0], { ...hours[0], validAt: "2026-10-22T17:00:00-07:00" }], "2026-10-23");
  assert.equal(complete.meanWindSpeedMs, 2); assert.equal(complete.vectorMeanWindSpeedMs, 0); assert.equal(complete.windDirectionDeg, null);
  assert.equal(complete.precipMm, null); assert.equal(complete.coverageHours.temperatureK, 24);
  const gap = deriveGfsDaily(hours.slice(1), "2026-10-23"); assert.equal(gap.temperatureK, null); assert.equal(gap.coverageHours.temperatureK, 23);
});
test("antecedent model window includes F24 and excludes F00 instead of using a calendar-day mean", () => {
  const hours = normalizeGfsResponse(gfsFixture(), "2026-10-23T00:00:00Z", "2026-10-23", "x", "x").hourly;
  hours[0].temperatureK = 1000; hours[24].temperatureK = 307.15;
  const a = deriveGfsAntecedent(hours, "2026-10-23");
  assert.ok(Math.abs(a.temperatureK! - 284.15) < 1e-8);
  assert.equal(a.windowStart, "2026-10-23T01:00:00.000Z"); assert.equal(a.windowEnd, "2026-10-24T00:00:00.000Z"); assert.equal(a.endInclusive, true);
  assert.equal(a.precipMm, 0);
});
test("gridMET packed values are decoded once and fill values are masked before offsets", () => {
  const sph = parseGridmetMetadata(metadata(), "sph"); assert.equal(sph.days.length, 2);
  assert.deepEqual(parseGridmetAscii(ascii(sph.variable, [[751, 32767]]), sph, 1, 2), [[.00751, null]]);
  const pdsi = parseGridmetMetadata(metadata("pdsi").replace('value="kg/kg"', 'value=""'), "pdsi"); assert.equal(pdsi.units, "1");
  assert.ok(Math.abs(parseGridmetAscii(ascii(pdsi.variable, [[1386]]), pdsi, 1, 1)[0][0]! + 1.14) < 1e-8);
  assert.throws(() => parseGridmetAscii(ascii(sph.variable, [[751]]), sph, 2, 1), /rows/);
});
test("gridMET point/AOI fetch chooses a nonfuture pentad and includes native coordinates", async () => {
  const requests: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => { const url = String(input); requests.push(url); return new Response(url.endsWith("dataset.xml") ? metadata("pdsi") : ascii("daily_mean_palmer_drought_severity_index", [[1386]])); }) as typeof fetch;
  const r = await fetchGridmetArea({ west: -121.6, east: -121.6, south: 39.8, north: 39.8 }, "2026-10-21", { fetcher, now: () => now, codes: ["pdsi"] });
  assert.equal(r.grids.pdsi?.date, "2026-10-17"); assert.equal(r.grids.pdsi?.nominalWindowStart, "2026-10-17T07:00:00.000Z");
  assert.ok(Math.abs(r.grids.pdsi!.longitudes[0] + 121.6) < 1e-8); assert.match(decodeURIComponent(requests[1]), /\[1:1:1\]\[1:1:1\]\[1:1:1\]/);
});
test("gridMET rejects unbounded/future requests and marks outside coverage without fetching", async () => {
  let count = 0; const fetcher = (async () => { count++; throw new Error("Unexpected fetch"); }) as typeof fetch;
  await assert.rejects(fetchGridmetArea({ west: -125, east: -67, south: 25, north: 49 }, "2026-10-21", { fetcher }), /bounded/);
  await assert.rejects(fetchGridmetArea({ west: -121, east: -121, south: 40, north: 40 }, "2027-01-01", { fetcher, now: () => now }), /Future/);
  const outside = await fetchGridmetArea({ west: -150, east: -150, south: 65, north: 65 }, "2026-10-21", { fetcher, codes: ["erc"] });
  assert.equal(outside.sources[0].status, "unsupported"); assert.equal(count, 0);
});
test("PDSI keeps the prior pentad on its date boundary while daily fields retain their same-day value", async () => {
  const requests: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => { const url = String(input); requests.push(url); return new Response(url.endsWith("dataset.xml") ? metadata("pdsi") : ascii("daily_mean_palmer_drought_severity_index", [[1386]])); }) as typeof fetch;
  const r = await fetchGridmetArea({ west: -121.6, east: -121.6, south: 39.8, north: 39.8 }, "2026-10-17", { fetcher, now: () => now, codes: ["pdsi"] });
  assert.equal(r.grids.pdsi?.date, "2026-10-12"); assert.equal(r.sources[0].status, "available");
  assert.match(decodeURIComponent(requests[1]), /\[0:1:0\]/);
});
test("a failed gridMET field is reported without erasing successful fields", async () => {
  const fetcher = (async (input: RequestInfo | URL) => { const url = String(input); if (url.includes("_sph_")) return new Response("unavailable", { status: 503 }); return new Response(url.endsWith("dataset.xml") ? metadata("erc") : ascii("daily_mean_energy_release_component-g", [[50]])); }) as typeof fetch;
  const r = await fetchGridmetArea({ west: -121.6, east: -121.6, south: 39.8, north: 39.8 }, "2026-10-21", { fetcher, now: () => now, codes: ["erc", "sph"] });
  assert.equal(r.grids.erc?.values[0][0], 50); assert.equal(r.grids.sph, undefined);
  assert.equal(r.sources.find(s => s.id === "gridmet:sph")?.status, "unavailable");
});
test("GFS fallback keeps the intended valid day but identifies the older initialization as stale", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => { calls.push(String(input)); return calls.length === 1 ? new Response("unavailable", { status: 404 }) : Response.json(gfsFixture("2026-10-22T00:00:00Z")); }) as typeof fetch;
  const gfs = await fetchGfsPoint(39.8, -121.6, { fetcher, now: () => now });
  assert.equal(calls.length, 2); assert.equal(gfs.runInitializedAt, "2026-10-22T00:00:00.000Z"); assert.equal(gfs.validDate, "2026-10-23"); assert.equal(gfs.status, "stale");
  assert.equal(gfs.antecedent.forecastHourStart, 25); assert.equal(gfs.antecedent.forecastHourEnd, 48);
  assert.ok(gfs.warnings.some(w => w.includes("not an exact feature match")));
});
test("NWS keeps actual unexpired fire warnings and rejects test/future/expired alerts", () => {
  const p = { event: "Red Flag Warning", status: "Actual", sent: "2026-10-23T05:00:00Z", expires: "2026-10-23T10:00:00Z", headline: "Official warning", instruction: "Follow official guidance." };
  const features = [p, { ...p, status: "Test" }, { ...p, sent: "2026-10-24T00:00:00Z" }, { ...p, expires: "2026-10-23T06:00:00Z" }, { ...p, event: "Flood Watch" }].map((properties, i) => ({ id: `https://api.weather.gov/alerts/${i}`, properties }));
  const alerts = normalizeFireAlerts({ features }, now); assert.equal(alerts.length, 1); assert.equal(alerts[0].instruction, p.instruction);
  assert.throws(() => normalizeFireAlerts({ error: "outage" }, now), /Invalid/);
});
test("full point response exposes partial errors, lagged date, and no model probability", async () => {
  const fetcher = (async (input: RequestInfo | URL) => { const url = String(input); if (url.includes("single-runs")) return Response.json(gfsFixture()); if (url.includes("/v1/elevation")) return Response.json({ elevation: [674] }); if (url.includes("api.weather.gov")) return new Response("outage", { status: 503 }); return new Response("outage", { status: 503 }); }) as typeof fetch;
  const d = await fetchPredictionInputs(39.8, -121.6, { fetcher, now: () => now });
  assert.equal(d.overallStatus, "partial"); assert.equal(d.officialAlerts, null); assert.equal(d.gridmet.requestedDate, "2026-10-21"); assert.equal(d.elevation?.meters, 674);
  assert.equal(d.modelCompatibility, "experimental-transfer"); assert.equal("probability" in d, false);
});
test("full response reuses an optional area request for gridMET while weather stays at the point", async () => {
  const requests: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input); requests.push(url);
    if (url.includes("single-runs")) return Response.json(gfsFixture());
    if (url.includes("/v1/elevation")) return Response.json({ elevation: [674] });
    if (url.includes("api.weather.gov")) return Response.json({ features: [] });
    if (!url.includes("_erc_")) return new Response("unavailable", { status: 503 });
    return new Response(url.endsWith("dataset.xml") ? metadata("erc") : ascii("daily_mean_energy_release_component-g", [[50, 51, 52], [53, 54, 55], [56, 57, 58]]));
  }) as typeof fetch;
  const d = await fetchPredictionInputs(39.8, -121.6, { fetcher, now: () => now, bounds: { west: -121.65, east: -121.55, south: 39.75, north: 39.85 } });
  assert.deepEqual(d.gridmet.grids.erc?.values, [[50, 51, 52], [53, 54, 55], [56, 57, 58]]);
  assert.equal(requests.filter(url => url.includes("_erc_") && url.includes(".ascii")).length, 1);
  assert.match(decodeURIComponent(requests.find(url => url.includes("_erc_") && url.includes(".ascii"))!), /\[1:1:1\]\[0:1:2\]\[0:1:2\]/);
  const gfsUrl = new URL(requests.find(url => url.includes("single-runs"))!);
  assert.equal(gfsUrl.searchParams.get("latitude"), "39.8"); assert.equal(gfsUrl.searchParams.get("longitude"), "-121.6");
});
test('a backward clock invalidates both metadata and gridded-value caches', async t => {
  let clock = now, metadataRequests = 0, gridRequests = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); assert.equal(url.hostname, 'thredds.northwestknowledge.net');
    if (url.pathname.endsWith('dataset.xml')) { metadataRequests++; return new Response(metadata('sph')); }
    gridRequests++;
    return new Response(ascii('daily_mean_specific_humidity', [[gridRequests === 1 ? 751 : 900]]));
  });
  const bounds = { west: -121.6, east: -121.6, south: 39.8, north: 39.8 };
  const options = { now: () => clock, codes: ['sph' as const] };
  const first = await fetchGridmetArea(bounds, '2026-10-21', options);
  assert.equal(first.grids.sph?.values[0][0], .00751);
  clock += 60_000;
  await fetchGridmetArea(bounds, '2026-10-21', options);
  assert.equal(metadataRequests, 1); assert.equal(gridRequests, 1, 'ordinary forward time should still use the caches');
  clock = now - 24 * 3600_000;
  const refreshed = await fetchGridmetArea(bounds, '2026-10-21', options);
  assert.equal(metadataRequests, 2); assert.equal(gridRequests, 2, 'negative cache age cannot make data fresh');
  assert.ok(Math.abs(refreshed.grids.sph!.values[0][0]! - .009) < 1e-12);
});
