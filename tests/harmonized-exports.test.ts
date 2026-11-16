import assert from "node:assert/strict";
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
const x = await import("../lib/harmonized/exports.ts");
// @ts-expect-error Explicit source extension supports the direct Node test runner.
const a = await import("../lib/harmonized/analytics.ts");
hooks.deregister();

const julys = [10, 12, 8, 11, 9, 40].map((h, i) => ({ month: `${2015 + i}-07`, h, lo: h * 0.9, hi: h * 1.1, source: "snpp" as const, coveredDays: 31, days: 31 }));

test("calendar CSV: period filter, shared anomaly policy, coverage and provenance columns, CSV quoting", () => {
  const pts = [...julys, { month: "2021-07", h: 3, partial: true, coveredDays: 20, days: 31 }];
  const csv = x.calendarCsv(pts, 'Córdoba, "AR"', "2016-01", "2021-12", [2015, 2021], "NASA FIRMS; test");
  const rows = csv.trim().split("\r\n"), head = rows[0].split(",");
  assert.equal(rows.length, 1 + 6); // 2016-07 .. 2021-07 inclusive
  for (const c of ["ratio_to_median_same_month_other_years", "ratio_to_mean_same_month_other_years", "percentile_vs_same_month_other_years", "bridge_error_envelope_low", "covered_days", "days_in_month", "provenance"]) assert.ok(head.includes(c), c);
  const r2020 = rows.find(r => r.startsWith("2020-07"))!;
  const map = a.anomalyMap(pts, "h", [2015, 2021]);
  assert.ok(r2020.includes(`,${map.get("2020-07")!.ratioToMedian!.toFixed(2)},`)); // same number as the KPI/calendar
  assert.ok(rows.find(r => r.startsWith("2021-07"))!.includes("not compared (partial month)"));
  assert.ok(rows[1].includes('"Córdoba, ""AR"""')); // quoted label
  assert.ok(rows[1].endsWith("NASA FIRMS; test"));
});

test("share links round-trip place, period, series, colour, month and language; invalid input is ignored", () => {
  const q = x.encodeView({ aoi: null, presetId: "admin1:AR-X", from: "2003-01", to: "2025-12", key: "modis", mode: "anomaly", ramp: "viridis", month: "2020-09", lang: "es" });
  const v = x.decodeView(`?${q}`);
  assert.deepEqual([v.presetId, v.from, v.to, v.key, v.mode, v.ramp, v.month, v.lang], ["admin1:AR-X", "2003-01", "2025-12", "modis", "anomaly", "viridis", "2020-09", "es"]);
  const bad = x.decodeView("?place=<script>&from=2025-13&series=evil&lang=fr&circle=0,0,99999");
  assert.equal(bad.presetId, undefined); assert.equal(bad.from, undefined); assert.equal(bad.key, undefined); assert.equal(bad.lang, undefined); assert.equal(bad.aoi, undefined);
  const c = x.decodeView("?circle=-64.18,-31.42,100"); assert.equal(c.aoi?.kind, "circle");
});

test("ordinal: English suffixes, including the teens and the 91st percentile shown for October 2020", async () => {
  // @ts-expect-error Explicit source extension supports the direct Node test runner.
  const { ordinal, STR } = await import("../lib/harmonized/i18n.ts");
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 91, 100, 101, 111].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "91st", "100th", "101st", "111th"]);
  assert.equal(STR.en.pctile(91), " (91st percentile)");
});
