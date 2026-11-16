import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

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
const lib = await import("../scripts/shadow/shadow-lib.ts");
// @ts-expect-error Explicit source extension supports the direct Node test runner.
const { toUtm, fromUtm } = await import("../lib/fire-predictor.ts");
hooks.deregister();

const HEAD = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight";
const row = (lat: number, lon: number, d: string, conf = "nominal", sat = "N20") => `${lat},${lon},300,0.4,0.4,${d},1200,${sat},${conf},2.0NRT,280,2,D`;
const csv = (...rows: string[]) => [HEAD, ...rows].join("\n");

test("trial feed parser applies the live contract", () => {
  const f = lib.parseNoaa20(csv(row(40, -120, "2026-11-03"), row(40, -120, "2026-11-03", "low"), row(41, -121, "2026-11-02", "high")));
  assert.equal(f.kept.length, 2); assert.equal(f.days["2026-11-03"], 2);
  assert.throws(() => lib.parseNoaa20(csv(row(40, -120, "2026-11-03", "nominal", "N"))), /platform/);
  assert.throws(() => lib.parseNoaa20(csv(row(40, -120, "2026-11-03", "medium"))), /confidence/);
});

test("cohort uses only yesterday's detections, minimum density, separation and cap", () => {
  const all = () => true, d = "2026-11-03", pts = [];
  for (let i = 0; i < 5; i++) pts.push({ lat: 40.01, lon: -120.01 - i * 1e-4, date: d });           // dense bin
  pts.push({ lat: 40.02, lon: -120.30, date: d }, { lat: 40.03, lon: -120.31, date: d });       // second bin ~25 km away: too close
  pts.push({ lat: 42.0, lon: -110.0, date: d }, { lat: 42.01, lon: -110.0, date: d });          // far bin
  pts.push({ lat: 44.0, lon: -100.0, date: d });                                                 // single detection: below minimum
  for (let i = 0; i < 9; i++) pts.push({ lat: 35.1, lon: -90.0 + i, date: "2026-11-04" });      // target-day detections: ignored
  const c = lib.selectCohort(pts, d, all);
  assert.equal(c.length, 2); assert.equal(c[0].detections, 5); assert.ok(Math.abs(c[1].lat - 42.005) < 1e-6);
  assert.equal(lib.selectCohort(pts, d, () => false).length, 0);
  const many = Array.from({ length: 40 }, (_, i) => [{ lat: 30 + i * 0.5, lon: -100, date: d }, { lat: 30 + i * 0.5 + 0.01, lon: -100, date: d }]).flat();
  assert.equal(lib.selectCohort(many, d, all).length, lib.COHORT.maxWindows);
});

test("labels use target-day point centres on the archived grid; a missing day is unlabelable", () => {
  const zone = 10, left = 600000, top = 4400000;
  const [lon, lat] = fromUtm(left + 1500 * 2 + 300, top - 1500 * 4 - 300, zone);
  const out = { targetDate: "2026-11-05", grid: { zone, left, top, cell: 1500, size: 33 }, cellFeatures: { "4-2": { row: 4, col: 2, features: [] }, "4-3": { row: 4, col: 3, features: [] } } };
  const feed = lib.parseNoaa20(csv(row(lat, lon, "2026-11-05"), row(lat, lon, "2026-11-04")));
  assert.deepEqual(lib.labelWindow(feed, out), { status: "labeled", labels: { "4-2": 1, "4-3": 0 } });
  assert.equal(lib.labelWindow(lib.parseNoaa20(csv(row(lat, lon, "2026-11-04"))), out).status, "unlabelable");
  const v = toUtm(lat, lon, zone); assert.ok(Math.abs(v.x - (left + 3300)) < 0.01);
});

test("invariants catch sensor, date and abstention violations", () => {
  const base = { issueDate: "2026-11-04", targetDate: "2026-11-05", modelId: "ember-day-ahead-v2", status: "abstained", reasons: ["x"], cells: [],
    fireSource: { url: lib.NOAA20_FEED, sensor: "VIIRS NOAA-20" }, satelliteHealth: { sourceUrl: lib.NOAA20_OUTAGES }, grid: {}, cellFeatures: {} } as never;
  assert.deepEqual(lib.invariants(base, "2026-11-04", "ember-day-ahead-v2", [lib.NOAA20_FEED]), []);
  assert.ok(lib.invariants(base, "2026-11-04", "ember-day-ahead-v2", ["https://x/suomi-npp-viirs-c2/a.csv"]).includes("S-NPP source fetched"));
  assert.ok(lib.invariants({ ...(base as object), targetDate: "2026-11-06" } as never, "2026-11-04", "ember-day-ahead-v2", []).includes("target is not issue+1"));
  const exp = { ...(base as object), status: "experimental", reasons: [], cells: [{ id: "1-1", p: 0.1, previous: 0 }], cellFeatures: { "1-1": { row: 1, col: 1, features: [1, null] } } } as never;
  assert.ok(lib.invariants(exp, "2026-11-04", "ember-day-ahead-v2", []).some((s: string) => s.includes("incomplete features")));
});

test("new-cell alert fraction counts only previously unoccupied cells in eligible windows", () => {
  const o = { status: "experimental", cells: [{ p: 0.5, previous: 1 }, { p: 0.08, previous: 0 }, { p: 0.01, previous: 0 }, { p: 0.02, previous: 0 }] } as never;
  assert.equal(lib.newCellAlertFraction([o]), 1 / 3);
  assert.equal(lib.newCellAlertFraction([{ status: "abstained", cells: [] } as never]), null);
});

test("blank coordinates and impossible dates are not observations", () => {
  const f = lib.parseNoaa20(csv(`,-120,300,0.4,0.4,2026-11-03,1200,N20,nominal,2.0NRT,280,2,D`, row(40, -120, "2026-02-30"), row(95, -120, "2026-11-03"), row(40, -120, "2026-11-03")));
  assert.equal(f.kept.length, 1); assert.deepEqual(Object.keys(f.days), ["2026-11-03"]); assert.equal(f.days["2026-11-03"], 1);
  assert.equal(lib.validDay("2026-02-29"), false); assert.equal(lib.validDay("2028-02-29"), true);
});

test("label maturity, retry and expiry are explicit", () => {
  assert.equal(lib.labelState("2026-11-05", "2026-11-06", true), "pending");
  assert.equal(lib.labelState("2026-11-05", "2026-11-07", true), "ready");
  assert.equal(lib.labelState("2026-11-05", "2026-11-07", false), "retry");
  assert.equal(lib.labelState("2026-11-05", "2026-11-11", false), "expired");
  assert.equal(lib.labelState("2026-11-05", "2026-11-12", true), "expired");
});

test("missing provenance, unarchived grids, wrong-length features and feed contract failures are violations", () => {
  const ok = { issueDate: "2026-11-04", targetDate: "2026-11-05", modelId: "m", status: "abstained", reasons: ["x"], cells: [],
    fireSource: { url: lib.NOAA20_FEED, sensor: "VIIRS NOAA-20" }, satelliteHealth: { sourceUrl: lib.NOAA20_OUTAGES }, grid: {}, cellFeatures: {} };
  assert.deepEqual(lib.invariants(ok as never, "2026-11-04", "m", []), []);
  assert.ok(lib.invariants({ ...ok, fireSource: null } as never, "2026-11-04", "m", []).some((v: string) => v.includes("fire source provenance")));
  assert.ok(lib.invariants({ ...ok, grid: undefined } as never, "2026-11-04", "m", []).includes("grid/features not archived"));
  assert.ok(lib.invariants({ ...ok, reasons: ["Satellite history: Unexpected platform \"N\" in the NOAA-20 feed"], fireSource: null } as never, "2026-11-04", "m", []).includes("feed contract failure"));
  const exp = { ...ok, status: "experimental", reasons: [], cells: [{ id: "1-1", p: 0.1, previous: 0 }], cellFeatures: { "1-1": { row: 1, col: 1, features: [] } } };
  assert.ok(lib.invariants(exp as never, "2026-11-04", "m", []).some((v: string) => v.includes("incomplete features")));
  // Outside the model domain no provenance is fetched, which is not a violation.
  assert.deepEqual(lib.invariants({ ...ok, fireSource: null, satelliteHealth: null, grid: undefined, cellFeatures: undefined, reasons: ["This fitted pilot covers the contiguous United States only."] } as never, "2026-11-04", "m", []), []);
});

test("gridMET readiness separates failed retrieval from publication lag", () => {
  const g = (date: string) => ({ date });
  const all = (date: string) => Object.fromEntries(lib.GRIDMET_DAILY.map((c: string) => [c, g(date)]));
  assert.equal(lib.gridmetReadiness({ weatherDate: "2026-11-02", inputs: { gridmet: { grids: {} } } } as never), "unretrieved"); // empty object is not lag
  assert.equal(lib.gridmetReadiness({ weatherDate: "2026-11-02", inputs: null } as never), "unretrieved");
  const partial = all("2026-11-02"); delete partial.sph;
  assert.equal(lib.gridmetReadiness({ weatherDate: "2026-11-02", inputs: { gridmet: { grids: partial } } } as never), "unretrieved");
  assert.equal(lib.gridmetReadiness({ weatherDate: "2026-11-02", inputs: { gridmet: { grids: all("2026-11-01") } } } as never), "stale");
  assert.equal(lib.gridmetReadiness({ weatherDate: "2026-11-02", inputs: { gridmet: { grids: all("2026-11-02") } } } as never), "ready");
});

test("review triggers are reconstructed over the whole archive, so a later low day cannot hide them", () => {
  const d = (date: string, fraction: number) => ({ date, fraction });
  assert.deepEqual(lib.reviewTriggers([d("a", .06), d("b", .07), d("c", .08), d("e", .01)]), [["a", "b", "c"]]);
  assert.deepEqual(lib.reviewTriggers([d("a", .06), d("b", .05), d("c", .08)]), []); // exactly 5% is not above
  assert.equal(lib.reviewTriggers([d("a", .1), d("b", .1), d("c", .1), d("e", .1)]).length, 2);
});

test("halts are reconstructed from archived runs and deferred attempts after an interrupted write", () => {
  const recs = [{ name: "archive/2026-11-04/run.json", violations: [] }, { name: "attempts/2026-11-05/a.json", violations: ["x: S-NPP source fetched"] }, { name: "archive/2026-11-06/run.json" }];
  const h = lib.haltsFromRecords(recs);
  assert.equal(h.length, 1); assert.ok(h[0].includes("attempts/2026-11-05/a.json") && h[0].includes("S-NPP source fetched"));
  assert.deepEqual(lib.haltsFromRecords([{ name: "r", violations: [] }]), []);
  // The reconstructed reason is identical to the one persisted before the write, so it is not duplicated.
  assert.deepEqual(lib.haltsFromRecords([{ name: "attempts/2026-11-05/a.json", violations: ["x: S-NPP source fetched"] }]), h);
});
