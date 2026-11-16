import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// @ts-expect-error Node executes this TypeScript file directly; the app uses bundler resolution.
import { assembleScene, distKm, groupPasses, parseDetections, peakOfMonth } from "../lib/scene-data.ts";
// @ts-expect-error Node executes this TypeScript file directly; the app uses bundler resolution.
import { layoutFire, type Det } from "../lib/scene3d/fire-layout.ts";
// @ts-expect-error Node executes this TypeScript file directly; the app uses bundler resolution.
import { LocalFrame, direction, sunMoon, windVector } from "../lib/scene3d/geo.ts";

const HEAD = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type";
const row = (lat: number, lon: number, date: string, time: string, sat = "N", frp = 10, dn = "D", inst = "VIIRS") => `${lat},${lon},330,0.4,0.4,${date},${time},${sat},${inst},n,2,290,${frp},${dn},0`;

test("parseDetections reads FIRMS rows, names the satellite and keeps only VIIRS", () => {
  const d = parseDetections([HEAD, row(-31, -64.9, "2020-10-02", "1735"), row(-31.01, -64.9, "2020-10-02", "511", "1", 4, "N"), row(-31, -64.8, "2020-10-02", "1400", "Terra", 9, "D", "MODIS"), "# notes: x", ""].join("\n"));
  assert.equal(d.length, 2);
  assert.equal(d[0].satellite, "Suomi NPP"); assert.equal(new Date(d[0].time).toISOString(), "2020-10-02T17:35:00.000Z"); assert.equal(d[0].night, false);
  assert.equal(d[1].satellite, "NOAA-20"); assert.equal(new Date(d[1].time).toISOString(), "2020-10-02T05:11:00.000Z"); assert.equal(d[1].night, true);
  assert.deepEqual(parseDetections("not,a,firms,file\n1,2,3,4"), []);
});

test("groupPasses splits one satellite's detections at gaps over 15 minutes, newest first", () => {
  const d = parseDetections([HEAD, row(-31, -64.9, "2020-10-02", "1735"), row(-31, -64.91, "2020-10-02", "1738"), row(-31, -64.9, "2020-10-02", "1554"), row(-31, -64.9, "2020-10-02", "1736", "1")].join("\n"));
  const p = groupPasses(d);
  assert.deepEqual(p.map(x => [x.info.satellite, x.info.count]), [["Suomi NPP", 2], ["NOAA-20", 1], ["Suomi NPP", 1]]);
  assert.ok(Date.parse(p[0].info.time) >= Date.parse(p[1].info.time) && Date.parse(p[1].info.time) >= Date.parse(p[2].info.time));
});

test("assembleScene shows one pass burning, earlier passes as burned ground, and nothing from the future", () => {
  const rows = [HEAD];
  for (let i = 0; i < 5; i++) rows.push(row(-31 + i * 0.004, -64.9, "2020-10-02", "1735", "N", 20));       // the pass to show
  for (let i = 0; i < 3; i++) rows.push(row(-31.02, -64.9 + i * 0.004, "2020-10-01", "1754", "N", 5));     // a day earlier
  rows.push(row(-31, -64.9, "2020-10-02", "1824", "1"));                                                    // a later pass by another satellite
  rows.push(row(-33, -64.9, "2020-10-02", "1735"));                                                         // 220 km away
  const s = assembleScene(parseDetections(rows.join("\n")), { lat: -31, lon: -64.9 }, 45, { wantDay: "2020-10-02" })!;
  assert.equal(s.timeUTC, "2020-10-02T17:35:00.000Z"); assert.equal(s.satellite, "VIIRS Suomi NPP");
  assert.equal(s.fires.filter(f => f.ageHours === 0).length, 5);
  const earlier = s.fires.filter(f => f.ageHours > 0); assert.equal(earlier.length, 3); assert.ok(earlier.every(f => Math.abs(f.ageHours - 23.68) < 0.05));
  assert.ok(Math.abs(s.center.lat - -30.992) < 0.002 && Math.abs(s.center.lon - -64.9) < 1e-6);
  assert.equal(s.passes.length, 3);
  // asking for a time picks the nearest pass instead
  assert.equal(assembleScene(parseDetections(rows.join("\n")), { lat: -31, lon: -64.9 }, 45, { wantTime: Date.parse("2020-10-02T18:20:00Z") })!.satellite, "VIIRS NOAA-20");
  assert.equal(assembleScene([], { lat: 0, lon: 0 }, 45), null);
  assert.ok(Math.abs(distKm(-31, -64.9, -32, -64.9) - 111.2) < 0.01);
});

test("peakOfMonth finds the busiest quarter-degree cell and day", () => {
  const rows = [HEAD, row(-31, -64.9, "2020-10-02", "1735"), row(-33.01, -64.93, "2020-10-05", "504"), row(-33.02, -64.92, "2020-10-05", "504"), row(-33.03, -64.94, "2020-10-05", "1800")];
  const p = peakOfMonth(parseDetections(rows.join("\n")))!;
  assert.equal(p.day, "2020-10-05"); assert.equal(p.count, 3); assert.ok(Math.abs(p.lat - -33.02) < 0.01);
  assert.equal(peakOfMonth([]), null);
});

test("layoutFire puts the strongest flames on the downwind edge and is repeatable", () => {
  // A block of detections 5 wide (across the wind) by 3 deep; the wind blows toward +x.
  const dets: Det[] = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 5; j++) dets.push({ x: i * 400, z: j * 400, frp: 30, age: 0 });
  dets.push({ x: -2000, z: 800, frp: 5, age: 20 }, { x: 9000, z: 9000, frp: 8, age: 0 });
  const a = layoutFire(dets, [1, 0], 20000), b = layoutFire(dets, [1, 0], 20000);
  assert.deepEqual(a.emitters.slice(0, 50), b.emitters.slice(0, 50));
  assert.equal(a.active.length, 16); assert.equal(a.earlier.length, 1);
  const head = a.emitters.filter(e => e.kind === 3), back = a.emitters.filter(e => e.kind === 1);
  assert.ok(head.length > 50, "a head front is drawn"); assert.ok(head.every(e => e.x > 450 && e.x < 1000), "the head front runs along the downwind edge (corners are rounded off)");
  assert.ok(back.length > 0 && back.every(e => e.x < 200), "the backing fire is on the upwind edge");
  const mean = (l: { h: number }[]) => l.reduce((s, e) => s + e.h, 0) / l.length; assert.ok(mean(head) > 2 * mean(back), "head flames are much taller than backing flames");
  assert.ok(Math.abs(a.focus[0] - 800) < 1 && a.focus[1] >= 0 && a.focus[1] <= 1600, "the view focuses on the head of the main fire");
  assert.ok(a.emitters.some(e => Math.hypot(e.x - 9000, e.z - 9000) < 200), "a lone detection still gets flames");
  assert.ok(a.emitters.every(e => Number.isFinite(e.x + e.z + e.h + e.wd + e.w) && e.h > 0));
  assert.ok(layoutFire(dets, [1, 0], 300).emitters.length <= 2200, "the emitter budget limits far flames");
  assert.equal(layoutFire([], [1, 0], 100).emitters.length, 0);
});

test("sun, moon, wind and local frame geometry", () => {
  const noon = sunMoon(new Date("2000-01-01T12:00:00Z"), 51.48, 0);                       // Greenwich, midwinter noon: low in the south
  assert.ok(Math.abs(noon.sun.elevation - 15.5) < 0.6, `elevation ${noon.sun.elevation}`); assert.ok(Math.abs(noon.sun.azimuth - 180) < 2, `azimuth ${noon.sun.azimuth}`);
  const cba = sunMoon(new Date("2020-10-02T17:35:00Z"), -31, -64.9);                       // Córdoba, early afternoon: high in the north-west; full moon the night before
  assert.ok(cba.sun.elevation > 52 && cba.sun.elevation < 60); assert.ok(cba.sun.azimuth > 300 && cba.sun.azimuth < 345, `azimuth ${cba.sun.azimuth}`); assert.ok(cba.moonLit > 0.97);
  assert.ok(sunMoon(new Date("2020-10-05T05:04:00Z"), -33, -64.9).sun.elevation < -40);    // a night pass
  const newMoon = sunMoon(new Date("2020-10-16T19:31:00Z"), 0, 0); assert.ok(newMoon.moonLit < 0.03, `lit ${newMoon.moonLit}`);
  const w = windVector(90); assert.ok(Math.abs(w[0] + 1) < 1e-9 && Math.abs(w[1]) < 1e-9, "wind from the east blows toward the west");
  const d = direction(0, 0); assert.ok(Math.abs(d[2] + 1) < 1e-9, "north is -z");
  const f = new LocalFrame(-31, -64.9); assert.ok(Math.abs(f.z(-32) - 111195) < 60); assert.ok(Math.abs(f.lon(f.x(-64.5)) - -64.5) < 1e-9); assert.ok(Math.abs(f.x(-63.9) - 95300) < 400);
});

test("every uniform a 3D-view shader declares is supplied by the engine (a missing one would silently read as zero)", async () => {
  // @ts-expect-error Node executes this TypeScript file directly; the app uses bundler resolution.
  const shaders = await import("../lib/scene3d/shaders.ts") as Record<string, string>;
  const engine = readFileSync(new URL("../lib/scene3d/engine.ts", import.meta.url), "utf8");
  const names = new Set<string>();
  for (const src of Object.values(shaders)) for (const m of src.matchAll(/uniform\s+\w+\s+([^;]+);/g)) for (const n of m[1].split(",")) names.add(n.trim().replace(/\[.*\]$/, ""));
  assert.ok(names.size > 60 && names.has("uHaze") && names.has("uDay"));
  assert.deepEqual([...names].filter(n => !new RegExp(`\\b${n}\\b`).test(engine)), []);
});
