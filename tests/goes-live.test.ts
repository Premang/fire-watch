import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Native Node TypeScript execution uses explicit file extensions.
import { getGoesFrame } from "../lib/goes-frame.ts";
// @ts-expect-error Native Node TypeScript execution uses explicit file extensions.
import { getGoesTimeline } from "../lib/goes-source.ts";

test("actual archived NOAA NetCDF decodes dense metadata, quality mask and navigated pixels", { skip: process.env.GOES_LIVE_TEST !== "1" }, async () => {
  const key = "ABI-L2-FDCC/2026/296/05/OR_ABI-L2-FDCC-M6_G19_s20262960501180_e20262960503553_c20262960504055.nc";
  const frame = await getGoesFrame("19", key);
  assert.equal(frame.sourcePixelCount, 3_750_000);
  assert.equal(frame.highConfidencePixelCount, 5);
  assert.equal(frame.detectionCount, 5);
  assert.equal(frame.features.features.filter((feature) => feature.properties.mask === 30).length, 4);
  assert.ok(frame.frame.publishedAt);
  const us = await getGoesFrame("19", key, { west: -125, south: 24, east: -66, north: 50 });
  assert.equal(us.detectionCount, 1);
  assert.equal(us.features.features[0].properties.id.split(":").slice(-2).join(":"), "728:1445");
  const unfiltered = await getGoesFrame("19", key);
  assert.equal(unfiltered.detectionCount, 5, "AOI filtering does not mutate the cached whole-frame data");
  for (const feature of frame.features.features) {
    assert.equal(feature.geometry.coordinates[0].length, 5);
    assert.equal(feature.properties.frp, null);
    assert.ok(feature.properties.lon >= -180 && feature.properties.lon <= 180);
    assert.ok(feature.properties.lat >= -90 && feature.properties.lat <= 90);
  }
});

test("latest GOES-18 and GOES-19 CONUS timelines and frames are available from NOAA", { skip: process.env.GOES_LIVE_TEST !== "1" }, async () => {
  for (const platform of ["18", "19"] as const) {
    const timeline = await getGoesTimeline(platform, 3);
    assert.ok(timeline.frames.length > 0);
    assert.ok(timeline.frames.length <= 40);
    assert.ok(timeline.latestKey);
    const frame = await getGoesFrame(platform, timeline.latestKey);
    assert.equal(frame.frame.platform, platform);
    assert.equal(frame.sourcePixelCount, 3_750_000);
    assert.equal(frame.detectionCount, frame.features.features.length);
  }
});
