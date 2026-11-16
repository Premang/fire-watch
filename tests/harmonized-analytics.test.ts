import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Explicit source extension supports the direct Node test runner.
import * as a from "../lib/harmonized/analytics.ts";

const pts = (vals: Record<string, number | null>, extra: Partial<Record<string, unknown>> = {}) =>
  Object.entries(vals).map(([month, h]) => ({ month, h, ...extra }));

test("month index round-trips and rejects malformed months", () => {
  assert.equal(a.monthIndex("2000-01"), 0); assert.equal(a.monthIndex("2012-01"), 144); assert.equal(a.monthFromIndex(310), "2025-11");
  assert.throws(() => a.monthIndex("2025-13")); assert.throws(() => a.monthIndex("25-01"));
});

test("climatology excludes partial months, the evaluated month, and years outside the baseline", () => {
  const p = [...pts({ "2010-08": 10, "2011-08": 20, "2012-08": 30, "2013-08": 40, "2014-08": 1000 }), { month: "2015-08", h: 999, partial: true }];
  const c = a.climatology(p, "h", 2010, 2014, "2014-08")[7];
  assert.equal(c.n, 4); assert.equal(c.median, 25); assert.equal(c.mean, 25); assert.deepEqual(c.values, [10, 20, 30, 40]);
});

test("anomaly reports ratio to median, mid-rank percentile and a category", () => {
  const c = a.climatology(pts({ "2001-03": 1, "2002-03": 2, "2003-03": 3, "2004-03": 4, "2005-03": 5, "2006-03": 6, "2007-03": 7, "2008-03": 8, "2009-03": 9, "2010-03": 10 }), "h", 2001, 2010)[2];
  const hi = a.anomaly(20, c); assert.equal(hi.median, 5.5); assert.ok(Math.abs(hi.ratioToMedian! - 20 / 5.5) < 1e-12); assert.equal(hi.percentileRank, 100); assert.equal(hi.category, "much-above");
  assert.equal(a.anomaly(5.5, c).category, "typical"); assert.equal(a.anomaly(0, c).category, "much-below");
  const few = a.climatology(pts({ "2001-03": 1, "2002-03": 2 }), "h", 2001, 2010)[2]; assert.equal(a.anomaly(3, few).category, "unknown");
});

test("calendar grid is newest-first with null for missing months", () => {
  const g = a.calendarGrid(pts({ "2024-01": 5, "2025-12": 7 }), "h", 2024, 2025);
  assert.deepEqual(g.map(r => r.year), [2025, 2024]); assert.equal(g[0].cells[11].v, 7); assert.equal(g[1].cells[0].v, 5); assert.equal(g[0].cells[0].v, null);
});

test("annual totals flag incomplete and provisional years", () => {
  const p = [...Array.from({ length: 12 }, (_, i) => ({ month: `2020-${String(i + 1).padStart(2, "0")}`, h: 1 })), { month: "2021-01", h: 4, provisional: true }];
  const t = a.annualTotals(p, "h"); assert.deepEqual(t.map(x => [x.year, x.total, x.complete, x.provisional]), [[2020, 12, true, false], [2021, 4, false, true]]);
});

test("range summary totals, peak and detections over an inclusive month range", () => {
  const p = [{ month: "2020-01", h: 2, detections: 10 }, { month: "2020-02", h: 9, detections: 30 }, { month: "2020-03", h: null, detections: 0 }, { month: "2020-04", h: 1, detections: 5 }];
  const s = a.rangeSummary(p, "h", "2020-02", "2020-04");
  assert.equal(s.months, 3); assert.equal(s.monthsWithData, 2); assert.equal(s.total, 10); assert.equal(s.peakMonth, "2020-02"); assert.equal(s.detections, 35);
});

test("Theil-Sen and Mann-Kendall detect a clean increasing series and not a flat one", () => {
  const up = a.trend(Array.from({ length: 15 }, (_, i) => ({ x: 2010 + i, y: 3 * i + 7 })));
  assert.equal(up.slopePerYear, 3); assert.equal(up.tau, 1); assert.ok(up.p! < 0.001);
  const flat = a.trend(Array.from({ length: 15 }, (_, i) => ({ x: 2010 + i, y: 5 }))); assert.equal(flat.slopePerYear, 0); assert.ok(flat.p! > 0.9);
  assert.equal(a.trend([{ x: 1, y: 1 }]).slopePerYear, null);
});

test("latest complete month is compared with the same calendar month in baseline years", () => {
  const p = [...pts({ "2015-07": 10, "2016-07": 12, "2017-07": 8, "2018-07": 11, "2019-07": 9, "2020-07": 40 }), { month: "2020-08", h: 1, partial: true }];
  const r = a.latestVsMedian(p, "h", [2015, 2020])!;
  assert.equal(r.month, "2020-07"); assert.equal(r.median, 10); assert.equal(r.ratioToMedian, 4); assert.equal(r.percentileRank, 100);
});

test("colour ramps are monotone in luminance and anomaly colours diverge around the median", () => {
  const lum = (c: string) => { const [r, g, b] = c.match(/\d+/g)!.map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const seq = [1, 3, 10, 30, 100].map(v => lum(a.sequentialColor(v, 100, "cividis")));
  assert.ok(seq.every((x, i) => i === 0 || x > seq[i - 1]));
  assert.equal(a.sequentialColor(0, 100), "var(--atlas-zero)");
  assert.notEqual(a.anomalyColor(5), a.anomalyColor(95)); assert.equal(a.anomalyColor(null), "var(--atlas-missing)");
});

test("one baseline policy: the KPI, calendar and exports agree; a month is left out of its own baseline", () => {
  const p = pts({ "2015-07": 10, "2016-07": 12, "2017-07": 8, "2018-07": 11, "2019-07": 9, "2020-07": 40 });
  const clim = a.climatology(p, "h", 2015, 2020), map = a.anomalyMap(p, "h", [2015, 2020], clim), latest = a.latestVsMedian(p, "h", [2015, 2020], clim)!;
  assert.equal(map.get("2020-07")!.ratioToMedian, latest.ratioToMedian); assert.equal(map.get("2020-07")!.percentileRank, latest.percentileRank);
  assert.equal(latest.ratioToMedian, 4); // median of the OTHER five Julys = 10
  assert.equal(map.get("2017-07")!.median, 11); // 2017 compared with 10, 12, 11, 9, 40
});

test("partial months are never ranked and short histories stay unknown", () => {
  const p = [...pts({ "2015-07": 10, "2016-07": 12, "2017-07": 8, "2018-07": 11, "2019-07": 9 }), { month: "2020-07", h: 2, partial: true }];
  const map = a.anomalyMap(p, "h", [2015, 2020]);
  const m = map.get("2020-07")!; assert.equal(m.partial, true); assert.equal(m.category, "unknown"); assert.equal(m.percentileRank, null); assert.equal(m.ratioToMedian, null);
  assert.equal(map.get("2019-07")!.category, "unknown"); // 4 other years < 5
});

test("season share and legend ticks", () => {
  const clim = a.climatology(pts({ "2001-01": 1, "2001-08": 6, "2001-09": 2, "2001-10": 1 }), "h", 2001, 2001);
  assert.equal(a.seasonShare(clim, [7, 8, 9]), 0.9);
  const t = a.activityTicks(1234); assert.ok(t.length <= 5 && t.every((x, i) => i === 0 || x.t > t[i - 1].t) && t.at(-1)!.v <= 1234 && t[0].v >= 1);
});

test("season windows: fire year starts after the quietest month; onset/mid/end interpolate the cumulative share", () => {
  // Southern-summer season peaking in Dec-Jan: the fire year must start in Jul (after the quietest month, Jun).
  const p: { month: string; h: number }[] = [];
  const shape = [30, 10, 2, 1, 1, 0.5, 1, 2, 5, 10, 20, 40]; // Jan..Dec
  for (let y = 2010; y <= 2013; y++) shape.forEach((v, i) => p.push({ month: `${y}-${String(i + 1).padStart(2, "0")}`, h: v * (y === 2012 ? 2 : 1) }));
  const clim = a.climatology(p, "h", 2010, 2013), r = a.seasonWindows(p, "h", clim);
  assert.equal(r.startMonth, 6); // July
  assert.deepEqual(r.years.map(w => w.year), [2010, 2011, 2012]); // 2013's fire year runs into 2014: incomplete
  const w = r.years[0]; assert.ok(w.onset < w.mid && w.mid < w.end && w.end <= 12);
  assert.ok(w.mid > 5 && w.mid < 7, `midpoint near Dec/Jan, got ${w.mid}`); // Jul=0 ... Dec=5, Jan=6
  // A uniform year has its midpoint exactly in the middle.
  const flat = Array.from({ length: 24 }, (_, i) => ({ month: `${2001 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`, h: 1 }));
  const f = a.seasonWindows(flat, "h", a.climatology(flat, "h", 2001, 2002));
  assert.ok(Math.abs(f.years[0].mid - 6) < 1e-9 && Math.abs(f.years[0].onset - 1.2) < 1e-9);
});
