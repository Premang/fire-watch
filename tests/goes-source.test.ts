import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Native Node TypeScript execution uses explicit file extensions.
import { goesHourPrefix, goesTimestamp, parseGoesHours, parseGoesKey, parseGoesListing, parseGoesPlatform } from "../lib/goes-source.ts";

const key = "ABI-L2-FDCC/2026/296/05/OR_ABI-L2-FDCC-M6_G19_s20262960501180_e20262960503553_c20262960504055.nc";

test("NOAA scan, end and product timestamps preserve UTC tenths and bucket provenance", () => {
  const frame = parseGoesKey(key, "19");
  assert.equal(frame.scanStart, "2026-10-23T05:01:18.000Z");
  assert.equal(frame.scanEnd, "2026-10-23T05:03:55.300Z");
  assert.equal(frame.productCreatedAt, "2026-10-23T05:04:05.500Z");
  assert.equal(frame.url, `https://noaa-goes19.s3.amazonaws.com/${key}`);
  assert.equal(goesTimestamp("20243662359599"), "2024-12-31T23:59:59.900Z");
  for (const timestamp of ["20263660100000", "20260000100000", "20262962400000", "20262960160000", "20262960100600"]) assert.throws(() => goesTimestamp(timestamp));
});

test("allowlisted keys reject URL injection, traversal, other products and satellite/path mismatch", () => {
  for (const bad of [
    `https://evil.test/${key}`, `../${key}`, `${key}?url=https://evil.test`, `${key}%00`,
    key.replace("FDCC", "FDCF"), key.replace("/296/", "/295/"), key.replace("/05/", "/06/"),
    key.replace("G19_", "G18_"), key.replace("e20262960503553", "e20262960403553"),
  ]) assert.throws(() => parseGoesKey(bad, "19"));
  assert.throws(() => parseGoesPlatform("20"));
  assert.throws(() => parseGoesHours("4"));
});

test("hour prefixes cross UTC year boundaries and leap days correctly", () => {
  assert.equal(goesHourPrefix(Date.parse("2024-12-31T23:59:59Z")), "ABI-L2-FDCC/2024/366/23/");
  assert.equal(goesHourPrefix(Date.parse("2025-01-01T00:00:00Z")), "ABI-L2-FDCC/2025/001/00/");
  assert.equal(goesHourPrefix(Date.parse("2024-03-01T02:00:00Z")), "ABI-L2-FDCC/2024/061/02/");
});

test("publication time is sourced from S3 metadata, not conflated with observation", () => {
  const xml = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${key}</Key><LastModified>2026-10-23T05:04:11.000Z</LastModified><Size>470640</Size></Contents></ListBucketResult>`;
  const [frame] = parseGoesListing(xml, "19");
  assert.equal(frame.publishedAt, "2026-10-23T05:04:11.000Z");
  assert.notEqual(frame.publishedAt, frame.scanStart);
  assert.equal(frame.sizeBytes, 470640);
  assert.throws(() => parseGoesListing(xml.replace("false", "true"), "19"), /truncated/);
  assert.throws(() => parseGoesListing("<html>Gateway error</html>", "19"));
});
