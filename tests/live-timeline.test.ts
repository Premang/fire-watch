import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node executes TypeScript directly; app imports use bundler resolution.
import { deriveTimeline, filterAtTime, formatAge, groupHotspots } from "../lib/live-timeline.ts";
import type { TimelinePoint } from "../lib/live-timeline";

const reference = "2026-10-22T14:35:20.000Z";
const start = "2026-10-21T14:35:20.000Z";
function point(id: string, acquiredAt: string, extra: Partial<TimelinePoint> = {}): TimelinePoint {
  return { id, acquiredAt, lat: 40, lon: -120, sensor: "VIIRS", frp: 15, ...extra };
}

test("24-hour replay keeps exactly 25 hourly endpoints independent of sparse or empty observations", () => {
  const empty = deriveTimeline([], reference);
  const sparse = deriveTimeline([point("one", "2026-10-22T13:45:00Z")], reference);
  assert.equal(empty.length, 25);
  assert.equal(empty[0].at, start);
  assert.equal(empty[24].at, reference);
  assert.equal(empty[0].label, "14:35 UTC");
  assert.deepEqual(empty.map((frame: { at: string }) => frame.at), sparse.map((frame: { at: string }) => frame.at));
  assert.ok(empty.every((frame: { count: number; newCount: number }) => frame.count === 0 && frame.newCount === 0));
  for (let index = 1; index < empty.length; index += 1) assert.equal(Date.parse(empty[index].at) - Date.parse(empty[index - 1].at), 3_600_000);
});

test("counts respect acquisition boundaries, reject future leakage, and deduplicate IDs", () => {
  const points = [
    point("old", "2026-10-21T14:35:19.999Z"),
    point("start", start), point("start", start),
    point("first-hour", "2026-10-21T15:35:20Z"),
    point("after-first", "2026-10-21T15:35:20.001Z"),
    point("end", reference), point("future", "2026-10-22T14:35:20.001Z"),
  ];
  const frames = deriveTimeline(points, reference);
  assert.equal(frames[0].count, 1);
  assert.equal(frames[0].newCount, 1);
  assert.equal(frames[1].count, 2);
  assert.equal(frames[1].newCount, 1);
  assert.equal(frames[2].count, 3);
  assert.equal(frames[24].count, 4);
  assert.equal(frames[24].newCount, 1);
  assert.equal(frames.reduce((sum: number, frame: { newCount: number }) => sum + frame.newCount, 0), 4);
  assert.deepEqual(filterAtTime(points, reference).map((entry: TimelinePoint) => entry.id), ["start", "first-hour", "after-first", "end"]);
});

test("explicit timezone offsets are normalized and ambiguous or invalid clocks are omitted", () => {
  const points = [
    point("offset", "2026-10-22T07:35:20-07:00"),
    point("no-zone", "2026-10-22T14:00:00"),
    point("rollover", "2026-02-30T10:00:00Z"),
    point("invalid-hour", "2026-10-21T24:00:00Z"),
    point("invalid-geo", reference, { lat: 100 }),
  ];
  const frames = deriveTimeline(points, "2026-10-22T07:35:20-07:00");
  assert.equal(frames[24].at, reference);
  assert.equal(frames[24].count, 1);
  assert.equal(filterAtTime(points, reference)[0].id, "offset");
  assert.deepEqual(deriveTimeline(points, "bad"), []);
  assert.deepEqual(filterAtTime(points, "2026-10-22T14:00:00"), []);
});

test("custom and zero windows never expand to fit the data", () => {
  const points = [point("before", "2026-10-22T13:00:00Z"), point("within", "2026-10-22T14:10:00Z"), point("exact", reference)];
  assert.deepEqual(filterAtTime(points, reference, { historyHours: 0.5 }).map((entry: TimelinePoint) => entry.id), ["within", "exact"]);
  const one = deriveTimeline(points, reference, 0);
  assert.equal(one.length, 1);
  assert.equal(one[0].count, 1);
  assert.throws(() => deriveTimeline(points, reference, 1.5), /integer/);
  assert.throws(() => filterAtTime(points, reference, { historyHours: -1 }), /nonnegative/);
});

test("a duplicate outside the valid window cannot hide its valid in-window record", () => {
  const points = [point("same", "2026-10-25T00:00:00Z"), point("same", reference)];
  assert.equal(filterAtTime(points, reference).length, 1);
  assert.equal(deriveTimeline(points, reference)[24].count, 1);
});

test("hotspot groups are stable grid summaries with actual latest time and FRP", () => {
  const points = [
    point("one", "2026-10-22T13:00:00Z", { frp: 4 }),
    point("two", reference, { frp: 30, sensor: "MODIS" }),
    point("two", reference, { frp: 30, sensor: "MODIS" }),
    point("distant", "2026-10-22T12:00:00Z", { lon: -115, frp: null }),
    point("invalid", "not-a-date"),
  ];
  const groups = groupHotspots(points);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].pointCount, 2);
  assert.equal(groups[0].latestAt, reference);
  assert.equal(groups[0].peakFrp, 30);
  assert.equal(groups[0].lat, 40);
  assert.equal(groups[0].lon, -120);
  assert.equal(groups[0].sensor, undefined);
  assert.ok(groups[0].id.startsWith("hotspot-cell:15:"));
  assert.equal(groups[1].sensor, "VIIRS");
  assert.equal(groups[1].peakFrp, null);
  assert.deepEqual(groupHotspots([]), []);
  assert.throws(() => groupHotspots(points, 0), /positive/);
});

test("grouping does not invent FRP from missing, negative, or nonfinite values", () => {
  const groups = groupHotspots([point("one", reference, { frp: Number.NaN }), point("two", reference, { frp: -5 })]);
  assert.equal(groups[0].peakFrp, null);
});

test("age labels use the injected clock and explicitly identify future or missing timestamps", () => {
  assert.equal(formatAge(reference, reference), "Just now");
  assert.equal(formatAge("2026-10-22T14:30:20Z", reference), "5 min ago");
  assert.equal(formatAge("2026-10-22T12:35:20Z", reference), "2 hr ago");
  assert.equal(formatAge(start, reference), "1 day ago");
  assert.equal(formatAge("2026-10-20T14:35:20Z", reference), "2 days ago");
  assert.equal(formatAge("2026-10-22T07:35:20-07:00", reference), "Just now");
  assert.equal(formatAge("2026-10-22T14:35:20.001Z", reference), "In the future");
  assert.equal(formatAge("", reference), "Time unavailable");
  assert.equal(formatAge(reference, "bad"), "Time unavailable");
});
