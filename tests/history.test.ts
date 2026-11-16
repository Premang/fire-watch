import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Node executes TypeScript directly; app imports use bundler resolution.
import { activityValue, calibrate, hasPartialAvailability, seasonalBaseline } from "../lib/history.ts";
import type { HistoryRegion, HistoryRow } from "../lib/history";

function month(year: number, monthNumber = 1, changes: Partial<HistoryRow> = {}): HistoryRow {
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    date: `${year}-${String(monthNumber).padStart(2, "0")}`,
    modis: 10, viirs: 20, modisObservedDays: days, viirsObservedDays: days,
    totalDays: days, partialSensors: [], ...changes,
  };
}

test("seasonal calibration excludes holdout and post-2025 data from fitting and metrics", () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => month(2012 + i)),
    month(2011, 1, { modis: 10_000, viirs: 1 }),
    month(2022, 1, { modis: 10, viirs: 30 }),
    month(2023, 1, { modis: 20, viirs: 20 }),
    month(2026, 1, { modis: 1_000_000, viirs: 1 }),
  ];
  const result = calibrate(rows);
  assert.equal(result.factors[0], 0.5);
  assert.equal(result.factors[1], null);
  assert.equal(result.trainingMonths, 10);
  assert.equal(result.evaluationMonths, 2);
  assert.deepEqual(result.evaluationDates, ["2022-01", "2023-01"]);
  assert.equal(result.baselineError, 10);
  assert.equal(result.adjustedError, 7.5);
});

test("flagged and numerically incomplete months cannot supply the five required training pairs", () => {
  const rows = [
    ...Array.from({ length: 4 }, (_, i) => month(2013 + i)),
    month(2012, 1, { partialSensors: ["VIIRS"], viirsObservedDays: 12 }),
    month(2017, 1, { modisObservedDays: 30 }),
    month(2022),
  ];
  const result = calibrate(rows);
  assert.equal(result.factors[0], null);
  assert.equal(result.trainingMonthsByMonth[0], 4);
  assert.equal(result.excludedTrainingPartialMonths, 2);
  assert.equal(result.evaluationMonths, 0);
  assert.equal(result.baselineError, null);
  assert.equal(result.adjustedError, null);
});

test("partial held-out months are excluded without changing the fitted scale", () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => month(2013 + i, 7)),
    month(2022, 7, { partialSensors: ["VIIRS"], viirsObservedDays: 26, viirs: 9999 }),
    month(2023, 7, { modis: 20, viirs: 60 }),
    month(2024, 7, { modisObservedDays: 20, modis: 9999 }),
  ];
  const result = calibrate(rows);
  assert.equal(result.factors[6], 0.5);
  assert.equal(result.evaluationMonths, 1);
  assert.equal(result.excludedEvaluationPartialMonths, 2);
  assert.equal(result.baselineError, 40);
  assert.equal(result.adjustedError, 10);
});

test("adjusted partial activity is a gap while individual sensor totals remain inspectable", () => {
  const factors = Array<number | null>(12).fill(0.5);
  const flagged = month(2022, 7, { partialSensors: ["VIIRS"] });
  const inferred = month(2022, 7, { viirsObservedDays: 26 });
  for (const row of [flagged, inferred]) {
    assert.equal(activityValue(row, "adjusted", factors), null);
    assert.equal(activityValue(row, "modis", factors), 10);
    assert.equal(activityValue(row, "viirs", factors), 20);
  }
  assert.equal(activityValue(month(2023, 7), "adjusted", factors), 10);
});

test("inactive VIIRS era, null values and unavailable factors never invent zero activity", () => {
  const factors = Array<number | null>(12).fill(null);
  const old = month(2005, 1, { viirs: null, viirsObservedDays: 0 });
  assert.equal(hasPartialAvailability(old), false);
  assert.equal(activityValue(old, "adjusted", factors), 10);
  assert.equal(activityValue(month(2022, 1, { modis: null, viirs: null }), "adjusted", factors), null);
  assert.equal(activityValue(month(2022, 1, { modis: null }), "adjusted", factors), null);
  assert.equal(activityValue(month(2022), "adjusted", []), 10);
  assert.equal(activityValue(month(2022, 1, { modis: Number.NaN, viirs: null }), "adjusted", factors), null);
  assert.equal(activityValue(month(2022, 1, { modis: 0, viirs: 0 }), "adjusted", factors), 0);
});

test("zero and null calibration pairs are not ratios; complete zero months may be evaluated", () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => month(2013 + i)),
    month(2018, 1, { modis: 0 }),
    month(2019, 1, { viirs: null }),
    month(2020, 1, { modis: null }),
    month(2022, 1, { modis: 0, viirs: 0 }),
  ];
  const result = calibrate(rows);
  assert.equal(result.trainingMonths, 5);
  assert.equal(result.factors[0], 0.5);
  assert.equal(result.evaluationMonths, 1);
  assert.equal(result.baselineError, 0);
  assert.equal(result.adjustedError, 0);
});

test("seasonal norms exclude incomplete months in raw and adjusted views and omit held-out years", () => {
  const rows = [month(2013), month(2014), month(2012, 1, { modis: 9999, viirs: 9999, partialSensors: ["VIIRS"] }), month(2022, 1, { modis: 9999 })];
  const factors = Array<number | null>(12).fill(0.5);
  assert.equal(seasonalBaseline(rows, "modis", factors)[0], 10);
  assert.equal(seasonalBaseline(rows, "viirs", factors)[0], 20);
  assert.equal(seasonalBaseline(rows, "adjusted", factors)[0], 10);
  assert.equal(seasonalBaseline(rows, "adjusted", factors)[1], null);
});

test("daily inputs cannot accidentally inflate monthly calibration sample sizes", () => {
  const daily = Array.from({ length: 10 }, (_, i) => ({ date: `2020-01-${String(i + 1).padStart(2, "0")}`, modis: 10, viirs: 20 }));
  const result = calibrate(daily);
  assert.equal(result.trainingMonths, 0);
  assert.equal(result.factors[0], null);
});

test("real US archive excludes known launch/outage months and has 40 held-out complete months", () => {
  const data = JSON.parse(readFileSync(new URL("../public/data/history/US.json", import.meta.url), "utf8")) as HistoryRegion;
  const result = calibrate(data.monthly);
  assert.equal(result.trainingMonths, 118);
  assert.equal(result.trainingMonthsByMonth[0], 9);
  assert.equal(result.trainingMonthsByMonth[2], 9);
  assert.equal(result.excludedTrainingPartialMonths, 2);
  assert.equal(result.evaluationMonths, 40);
  assert.equal(result.excludedEvaluationPartialMonths, 8);
  assert.ok(!result.evaluationDates.includes("2022-07"));
  assert.ok(!result.evaluationDates.includes("2024-07"));
  assert.ok(result.factors.every((factor: number | null) => factor !== null && Number.isFinite(factor) && factor > 0));
  for (const date of ["2012-01", "2022-07", "2022-08", "2024-07"]) {
    const row = data.monthly.find((entry) => entry.date === date)!;
    assert.equal(activityValue(row, "adjusted", result.factors), null);
    assert.ok(activityValue(row, "viirs", result.factors)! > 0);
  }
  assert.ok(result.coverageNote.includes("do not measure local clear-sky"));
});
