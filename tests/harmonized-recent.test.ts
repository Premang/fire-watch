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
const r = await import("../lib/harmonized/recent.ts");
hooks.deregister();

const HEAD = "latitude,longitude,acq_date,acq_time,satellite,instrument,confidence,frp,daynight,type,source_dataset";
const row = (lat: number, lon: number, date: string, sat: string, conf: string, inst = "VIIRS") => `${lat},${lon},${date},1200,${sat},${inst},${conf},3,D,,VIIRS NOAA-20 NRT`;
const aoi = { kind: "circle" as const, lon: -64, lat: -31, radiusKm: 100, label: "t" };

test("hotspot CSV parsing skips notes and malformed rows", () => {
  const rows = r.parseHotspotCsv([HEAD, row(-31, -64, "2026-11-01", "N20", "n"), "# notes: x", "bad,row"].join("\n"));
  assert.equal(rows.length, 1); assert.equal(rows[0].satellite, "N20");
});

const W = { first: "2026-10-28", last: "2026-11-04" };
const DAYS = ["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"];
const AV = { noaa20: Object.fromEntries(DAYS.map(d => [d, d === "2026-10-30" ? 100 : 1000])), noaa21: Object.fromEntries(DAYS.map(d => [d, 1000])) };

test("daily unique cells over the window's complete days: filters, static mask, availability-based platform, observed zeros", () => {
  const lines = [HEAD,
    row(-31, -64, "2026-10-28", "N20", "n"),                       // first (partial) day: outside the comparison
    row(-31, -64, "2026-10-29", "N20", "n"), row(-31, -64, "2026-10-29", "N20", "h"), // same 5 km cell twice -> 1
    row(-31.2, -64.2, "2026-10-29", "N20", "nominal"),              // static-source cell: masked
    row(-31.3, -64.3, "2026-10-29", "N20", "l"),                    // low confidence: excluded
    row(-31.4, -64.4, "2026-10-29", "N21", "n"),                    // NOAA-21 counted separately
    row(-40, -70, "2026-10-29", "N20", "n"),                        // outside AOI
    row(-31.5, -64.5, "2026-10-30", "N21", "h"),                    // NOAA-20 not delivering globally that day -> NOAA-21
    row(-31.6, -64.6, "2026-10-30", "T", "85", "MODIS"),
    row(-31, -64, "2026-11-04", "N20", "n")];                       // last (partial) day: outside the comparison
  const rows = r.parseHotspotCsv(lines.join("\n"));
  const staticSet = new Set([r.cellKey(-64.2, -31.2)]);
  const q = Array(12).fill(1); q[9] = 1.5;
  const res = r.recentDaily(rows, aoi, staticSet, q, W, AV);
  assert.deepEqual(res.days.map(d => d.date), DAYS);
  const d29 = res.days[0]; assert.equal(d29.noaa20, 1); assert.equal(d29.noaa21, 1); assert.equal(d29.source, "noaa20"); assert.equal(d29.harmonized, 1.5);
  const d30 = res.days[1]; assert.equal(d30.source, "noaa21"); assert.equal(d30.harmonized, 1.5); assert.equal(d30.modis, 1);
  assert.deepEqual(res.days.slice(2).map(d => [d.source, d.harmonized]), [["noaa20", 0], ["noaa20", 0], ["noaa20", 0], ["noaa20", 0]]); // quiet days are zeros, not gaps
  assert.equal(res.maskedStatic, 1); assert.equal(res.lowConfidence, 1); assert.equal(res.outsideAoi, 1); assert.ok(res.availabilityChecked);
});

test("a day with no VIIRS platform delivering data is left out instead of counted as zero", () => {
  const av = { noaa20: { ...AV.noaa20, "2026-11-02": 0 }, noaa21: { ...AV.noaa21, "2026-11-02": 0 } };
  const res = r.recentDaily([], aoi, new Set(), Array(12).fill(1), W, av);
  assert.equal(res.days.find(d => d.date === "2026-11-02")!.harmonized, null);
  assert.equal(res.days.filter(d => d.harmonized === 0).length, 5);
  const unchecked = r.recentDaily([], aoi, new Set(), Array(12).fill(1), W, null); // no coverage information: nothing is assumed observed
  assert.equal(unchecked.availabilityChecked, false); assert.ok(unchecked.days.every(d => d.source === null && d.harmonized === null));
  const flags = r.recentDaily([], aoi, new Set(), Array(12).fill(1), W, { noaa20: Object.fromEntries(DAYS.map(d => [d, d === "2026-11-01" ? 0 : 1])), noaa21: {} }); // keyed path: 1/0 flags
  assert.equal(flags.days.find(d => d.date === "2026-11-01")!.harmonized, null); assert.equal(flags.days.filter(d => d.harmonized === 0).length, 5);
});

test("window dates exclude both partial ends", () => {
  assert.deepEqual(r.windowDates({ first: "2026-12-30", last: "2027-01-02" }), ["2026-12-31", "2027-01-01"]);
  assert.deepEqual(r.windowDates({ first: "2026-11-01", last: "2026-11-02" }), []);
});

test("static cells round-trip through the int16 pair file", () => {
  const k = r.cellKey(10, 45);
  const x = Math.floor(k / 8192) - 4096, y = (k % 8192) - 4096;
  const set = r.staticSetFromBin(new Int16Array([x, y]).buffer);
  assert.ok(set.has(k));
});

test("usual pace is built day by day from each day's own month, across a month boundary", () => {
  const med = Array(12).fill(null); med[9] = 310; med[10] = 300; // Oct: 10/day, Nov: 10/day
  assert.equal(r.expectedForDays(["2026-10-31", "2026-11-01"], med), 20);
  med[10] = 600; assert.equal(r.expectedForDays(["2026-10-31", "2026-11-01"], med), 30);
  assert.equal(r.expectedForDays(["2026-12-01"], med), null);
});

test("pace labels describe the ratio without claiming a percentile", () => {
  assert.equal(r.paceLabel(2.4).tone, "much-above"); assert.equal(r.paceLabel(1.3).tone, "above"); assert.equal(r.paceLabel(1).tone, "typical");
  assert.equal(r.paceLabel(0.6).tone, "below"); assert.equal(r.paceLabel(0.2).tone, "much-below"); assert.equal(r.paceLabel(null).tone, "unknown");
});

test("server warnings are read from the CSV", () => {
  assert.deepEqual(r.csvNotes("a,b\r\n1,2\r\n# notes: VIIRS NOAA-21 NRT: HTTP 503; MODIS timeout\r\n"), ["VIIRS NOAA-21 NRT: HTTP 503", "MODIS timeout"]);
});

test("a month without a conversion factor leaves its days unknown (never factor 1)", () => {
  const q = Array(12).fill(1.2); q[10] = undefined as unknown as number; // November factor missing
  const rows = r.parseHotspotCsv([HEAD, row(-31, -64, "2026-10-29", "N20", "n"), row(-31, -64, "2026-11-01", "N20", "n")].join("\n"));
  const res = r.recentDaily(rows, aoi, new Set(), q, W, AV);
  assert.equal(res.days.find(d => d.date === "2026-10-29")!.harmonized, 1.2);
  assert.ok(res.days.filter(d => d.date.startsWith("2026-11")).every(d => d.harmonized === null && d.source === null));
});

test("day-of-year slots skip 29 February and quantile classes are bounded by p10/p25/p75/p90", () => {
  assert.equal(r.daySlot("2026-01-01"), 0); assert.equal(r.daySlot("2026-03-01"), 59); assert.equal(r.daySlot("2024-02-29"), null); assert.equal(r.daySlot("2026-12-31"), 364);
  const q = [1, 2, 4, 6, 9];
  assert.equal(r.classifyAgainst(q, 10), "much-above"); assert.equal(r.classifyAgainst(q, 7), "above"); assert.equal(r.classifyAgainst(q, 4), "typical");
  assert.equal(r.classifyAgainst(q, 1.5), "below"); assert.equal(r.classifyAgainst(q, 0.5), "much-below"); assert.equal(r.classifyAgainst([1, null, 4, 6, 9], 5), null);
  assert.equal(r.classifyAgainst([0, 0, 0, 0, 0], 0), "typical"); assert.equal(r.classifyAgainst([0, 0, 0, 0, 0], 0.4), "much-above"); // burning on rarely-burning dates
});

test("same-days comparison: 7-day window on the last counted day, or month-to-date when the days start on the 1st", () => {
  const week = Array.from({ length: 365 }, () => [1, 2, 4, 6, 9]), mtd = Array.from({ length: 12 }, () => Array.from({ length: 31 }, () => [0.5, 1, 2, 3, 5]));
  const clim = { baseline: [2003, 2025] as [number, number], q: [10, 25, 50, 75, 90], window: 7, week, n: Array(365).fill(23), mtd };
  const days = (dates: string[], v: number) => ({ days: dates.map(date => ({ date, noaa20: 0, noaa21: 0, modis: 0, harmonized: v, source: "noaa20" as const })), detections: 0, maskedStatic: 0, outsideAoi: 0, lowConfidence: 0, window: null, availabilityChecked: true });
  const w = r.sameDaysComparison(days(["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"], 8), clim)!;
  assert.equal(w.mode, "week"); assert.equal(w.mean, 8); assert.equal(w.tone, "above"); assert.equal(w.ratio, 2); assert.equal(w.years, 23);
  const m = r.sameDaysComparison(days(["2026-11-01", "2026-11-02", "2026-11-03"], 6), clim)!;
  assert.equal(m.mode, "mtd"); assert.equal(m.tone, "much-above"); assert.equal(m.ratio, 3);
  assert.equal(r.sameDaysComparison(days(["2026-11-01"], 1), null), null);
  const few = { ...clim, n: Array(365).fill(3) }; assert.equal(r.sameDaysComparison(days(["2026-10-29", "2026-10-30"], 8), few), null);
});
