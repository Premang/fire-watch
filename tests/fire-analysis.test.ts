import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node executes this TypeScript file directly; the app uses bundler resolution.
import { compareSensors, dailyCalendar, deduplicateCellDays, filterPoints, monthlyCalendar, parseFirmsCsv } from "../lib/fire-analysis.ts";
import type { FirePoint, Sensor } from "../lib/fire-analysis";

function point(date: string, sensor: Sensor = "MODIS", cell = 0, extra: Partial<FirePoint> = {}): FirePoint {
  return {
    id: `${date}-${sensor}-${cell}`, lat: 35, lon: -120 + cell * 0.1,
    acquiredAt: `${date}T13:30:00.000Z`, sensor,
    platform: sensor === "MODIS" ? "Aqua" : "Suomi NPP",
    frp: 10, confidence: "nominal", daynight: "D", ...extra,
  };
}

test("FIRMS parsing handles BOM, quoted commas, CRLF, UTC padding and satellite names", () => {
  const csv = '\uFEFFlatitude,longitude,acq_date,acq_time,satellite,instrument,frp,confidence,daynight,scan,track,note\r\n35,-120,2024-02-29,5,N20,VIIRS,12.3,n,D,0.4,0.5,"a, b"\r\n';
  const result = parseFirmsCsv(csv);
  assert.equal(result.length, 1);
  assert.equal(result[0].acquiredAt, "2024-02-29T00:05:00.000Z");
  assert.equal(result[0].platform, "NOAA-20");
  assert.equal(result[0].frp, 12.3);
  assert.equal(result[0].confidence, "n");
  assert.equal(result[0].scan, 0.4);
});

test("invalid calendar dates, times, coordinates and unsupported instruments are skipped", () => {
  const csv = [
    "latitude,longitude,acq_date,acq_time,instrument,frp",
    "35,-120,2023-02-29,1300,MODIS,1",
    "35,-120,2024-02-29,2460,MODIS,1",
    "91,-120,2024-02-29,1300,MODIS,1",
    ",-120,2024-02-29,1300,MODIS,1",
    "35,-181,2024-02-29,1300,MODIS,1",
    "35,-120,2024-02-29,1300,ABI,1",
    "-20,135,2024-02-29,1300,VIIRS,-5",
  ].join("\n");
  const result = parseFirmsCsv(csv, "MODIS");
  assert.equal(result.length, 1);
  assert.equal(result[0].lat, -20, "parser does not clip to US");
  assert.equal(result[0].frp, null);
});

test("sensor inference and default sensor work without fabricating midnight acquisitions", () => {
  assert.equal(parseFirmsCsv("latitude,longitude,acq_date,acq_time,satellite\n35,-120,2024-06-01,0,A")[0].sensor, "MODIS");
  assert.equal(parseFirmsCsv("latitude,longitude,acq_date,acq_time\n35,-120,2024-06-01,0", "VIIRS")[0].sensor, "VIIRS");
  assert.equal(parseFirmsCsv("latitude,longitude,acq_date,acq_time\n35,-120,2024-06-01,", "VIIRS").length, 0);
  assert.throws(() => parseFirmsCsv("latitude,longitude\n35,-120"), /acq_date/);
  assert.throws(() => parseFirmsCsv('latitude,longitude\n"35,-120'), /unclosed/);
});

test("timezone timestamps normalize before UTC calendar grouping and reject ambiguous times", () => {
  const result = parseFirmsCsv([
    "lat,lon,acquired_at,sensor,note",
    '35,-120,2024-07-01T23:30:00-07:00,MODIS,"quoted\nmultiline"',
    "35,-120,2024-07-01T23:30:00,MODIS,invalid",
    "35,-120,2024-02-30T00:00:00Z,MODIS,invalid",
  ].join("\n"));
  assert.equal(result.length, 1);
  assert.equal(result[0].acquiredAt, "2024-07-02T06:30:00.000Z");
  assert.equal(dailyCalendar(result)[0].date, "2024-07-02");
});

test("filtering combines inclusive bounds, sensor and whole UTC dates", () => {
  const points = [point("2024-07-01"), point("2024-07-02"), point("2024-07-02", "VIIRS")];
  assert.equal(filterPoints(points, { west: -120, east: -119, south: 35, north: 36 }, { sensor: "MODIS", start: "2024-07-02", end: "2024-07-02" }).length, 1);
  const late = point("2024-07-02", "MODIS", 0, { acquiredAt: "2024-07-02T23:59:59.999Z" });
  assert.equal(filterPoints([late], undefined, { end: "2024-07-02" }).length, 1);
  assert.throws(() => filterPoints(points, undefined, { start: "2024-02-30" }), /valid/);
  assert.throws(() => filterPoints(points, undefined, { start: "2025-01-01", end: "2024-01-01" }), /after/);
});

test("antimeridian bounds include Alaska-style wrapped longitudes", () => {
  const points = [-179, 179, 0].map((lon) => point("2024-07-01", "MODIS", 0, { lon }));
  assert.equal(filterPoints(points, { west: 170, east: -170, south: -90, north: 90 }).length, 2);
});

test("deduplication merges same-sensor platforms within equal-area cell-days but retains sensors and dates", () => {
  const initial = point("2024-07-01");
  const repeat = { ...initial, id: "repeat", acquiredAt: "2024-07-01T23:00:00.000Z" };
  const otherPlatform = { ...initial, id: "terra", platform: "Terra" };
  const nextDay = point("2024-07-02");
  const viirs = point("2024-07-01", "VIIRS");
  const result = deduplicateCellDays([repeat, initial, otherPlatform, nextDay, viirs]);
  assert.equal(result.length, 3);
  assert.ok(result.some((p: FirePoint) => p.id === initial.id));
  assert.ok(!result.some((p: FirePoint) => p.id === "repeat"));
  assert.throws(() => deduplicateCellDays([initial], 0), /positive/);
});

test("calendar leaves missing dates absent and distinguishes raw detections from daily cell presence", () => {
  const points = [point("2024-07-01"), point("2024-07-01"), point("2024-07-03"), point("2024-07-03", "VIIRS")];
  const daily = dailyCalendar(points);
  assert.deepEqual(daily.map((bin: { date: string }) => bin.date), ["2024-07-01", "2024-07-03"]);
  assert.equal(daily[0].rawDetections, 2);
  assert.equal(daily[0].MODIS, 1);
  assert.equal(daily[0].coverage, "unknown");
  const monthly = monthlyCalendar(points);
  assert.equal(monthly[0].MODIS, 2);
  assert.equal(monthly[0].VIIRS, 1);
  assert.equal(monthly[0].total, 3);
});

test("comparison robustly fits training days and never leaks the final 20% into its ratio", () => {
  const points: FirePoint[] = [];
  for (let day = 1; day <= 10; day += 1) {
    const date = `2024-07-${String(day).padStart(2, "0")}`;
    points.push(point(date));
    const viirsCount = day === 1 ? 8 : day >= 9 ? 6 : 2;
    for (let cell = 0; cell < viirsCount; cell += 1) points.push(point(date, "VIIRS", cell));
  }
  const comparison = compareSensors(points);
  assert.equal(comparison.status, "provisional");
  assert.equal(comparison.ratio, 2);
  assert.equal(comparison.trainingDays, 8);
  assert.equal(comparison.evaluationDays, 2);
  assert.equal(comparison.evaluationStartsAt, "2024-07-09");
  assert.equal(comparison.evaluationMae, 2);
  assert.equal(comparison.baselineEvaluationMae, 5);
  assert.equal(comparison.daily[9].split, "evaluation");
  assert.equal(comparison.daily[9].adjustedVIIRS, 3);
  assert.ok(comparison.flags.some((flag: string) => flag.includes("coverage is unknown")));
});

test("six fitting days means six after holdout, and single-sensor dates never enter a ratio", () => {
  const points: FirePoint[] = [];
  for (let day = 1; day <= 7; day += 1) {
    const date = `2024-07-${String(day).padStart(2, "0")}`;
    points.push(point(date), point(date, "VIIRS"));
  }
  const result = compareSensors(points);
  assert.equal(result.pairedDays, 7);
  assert.equal(result.trainingDays, 5);
  assert.equal(result.ratio, null);
  assert.equal(result.status, "insufficient");
  assert.ok(result.daily.every((bin: { adjustedVIIRS: number | null }) => bin.adjustedVIIRS === null));
  const only = compareSensors([point("2024-07-01")]);
  assert.equal(only.pairedDays, 0);
  assert.equal(only.daily[0].split, "unpaired");
  assert.equal(only.evaluationMae, null);
});

test("multiple satellites trigger a sampling flag; empty data never create numbers", () => {
  const mixed = compareSensors([point("2024-07-01"), point("2024-07-01", "MODIS", 0, { platform: "Terra" })]);
  assert.ok(mixed.flags.some((flag: string) => flag.includes("MODIS includes multiple platforms")));
  const empty = compareSensors([]);
  assert.deepEqual(empty.daily, []);
  assert.equal(empty.ratio, null);
  assert.equal(empty.evaluationStartsAt, null);
  assert.equal(empty.evaluationMae, null);
});
