import type { GoesFrameMetadata, GoesPlatform, GoesTimeline } from "./goes-types";

const HOUR = 3_600_000;
const timelines = new Map<GoesPlatform, { fetched: number; frames: GoesFrameMetadata[]; warnings: string[] }>();
const pending = new Map<GoesPlatform, Promise<{ fetched: number; frames: GoesFrameMetadata[]; warnings: string[] }>>();

export function parseGoesPlatform(value: string | null): GoesPlatform {
  if (value === null || value === "19") return "19";
  if (value === "18") return "18";
  throw new Error("platform must be 18 or 19.");
}

export function parseGoesHours(value: string | null): number {
  if (value === null) return 3;
  if (/^[123]$/.test(value)) return Number(value);
  throw new Error("hours must be 1, 2, or 3.");
}

/** NOAA timestamps are YYYY + day of year + HHMMSS + tenths, in UTC. */
export function goesTimestamp(value: string): string {
  if (!/^\d{14}$/.test(value)) throw new Error("Invalid GOES timestamp.");
  const year = Number(value.slice(0, 4));
  const day = Number(value.slice(4, 7));
  const hour = Number(value.slice(7, 9));
  const minute = Number(value.slice(9, 11));
  const second = Number(value.slice(11, 13));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (year < 2017 || year > 2100 || day < 1 || day > (leap ? 366 : 365) || hour > 23 || minute > 59 || second > 59) {
    throw new Error("Invalid GOES timestamp components.");
  }
  return new Date(Date.UTC(year, 0, day, hour, minute, second, Number(value[13]) * 100)).toISOString();
}

export function parseGoesKey(key: string, platform: GoesPlatform): GoesFrameMetadata {
  const match = /^ABI-L2-FDCC\/(\d{4})\/(\d{3})\/(\d{2})\/OR_ABI-L2-FDCC-M[36]_G(18|19)_s(\d{14})_e(\d{14})_c(\d{14})\.nc$/.exec(key);
  if (!match || match[4] !== platform || `${match[1]}${match[2]}${match[3]}` !== match[5].slice(0, 9)) {
    throw new Error("key must be an ABI-L2-FDCC object for the selected satellite.");
  }
  const scanStart = goesTimestamp(match[5]);
  const scanEnd = goesTimestamp(match[6]);
  const productCreatedAt = goesTimestamp(match[7]);
  if (scanEnd < scanStart || productCreatedAt < scanEnd || Date.parse(scanEnd) - Date.parse(scanStart) > 15 * 60_000) {
    throw new Error("Invalid GOES scan chronology.");
  }
  return {
    key, url: `https://noaa-goes${platform}.s3.amazonaws.com/${key}`, platform,
    scanStart, scanEnd, productCreatedAt, publishedAt: null, sizeBytes: null,
  };
}

export function goesHourPrefix(time: number): string {
  const date = new Date(time);
  const year = date.getUTCFullYear();
  const day = Math.floor((Date.UTC(year, date.getUTCMonth(), date.getUTCDate()) - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
  return `ABI-L2-FDCC/${year}/${String(day).padStart(3, "0")}/${String(date.getUTCHours()).padStart(2, "0")}/`;
}

export function parseGoesListing(xml: string, platform: GoesPlatform): GoesFrameMetadata[] {
  if (!xml.includes("<ListBucketResult") || /<IsTruncated>true<\/IsTruncated>/.test(xml)) {
    throw new Error("Unexpected or truncated NOAA object listing.");
  }
  const frames: GoesFrameMetadata[] = [];
  for (const item of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([^<]+)<\/Key>/.exec(item[1])?.[1];
    if (!key) continue;
    const metadata = parseGoesKey(key, platform);
    const modified = /<LastModified>([^<]+)<\/LastModified>/.exec(item[1])?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(item[1])?.[1];
    metadata.publishedAt = modified && Number.isFinite(Date.parse(modified)) ? new Date(modified).toISOString() : null;
    metadata.sizeBytes = size ? Number(size) : null;
    frames.push(metadata);
  }
  return frames;
}

async function fetchTimeline(platform: GoesPlatform, now: number) {
  const prefixes = Array.from({ length: 4 }, (_, i) => goesHourPrefix(now - i * HOUR));
  const results = await Promise.allSettled(prefixes.map(async (prefix) => {
    const url = `https://noaa-goes${platform}.s3.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
    if (!response.ok) throw new Error(`NOAA listing returned ${response.status}.`);
    return parseGoesListing(await response.text(), platform);
  }));
  const scans = new Map<string, GoesFrameMetadata>();
  const warnings: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "rejected") {
      warnings.push(`NOAA listing unavailable for ${prefixes[i]}; the timeline may have gaps.`);
      continue;
    }
    for (const frame of result.value) {
      const timestamp = Date.parse(frame.scanStart);
      if (timestamp < now - 3 * HOUR || timestamp > now) continue;
      const previous = scans.get(frame.scanStart);
      if (!previous || previous.productCreatedAt < frame.productCreatedAt) scans.set(frame.scanStart, frame);
    }
  }
  const frames = [...scans.values()].sort((a, b) => a.scanStart.localeCompare(b.scanStart));
  if (!frames.length) throw new Error("NOAA has no available CONUS scans in the past three hours. Try the other satellite.");
  return { fetched: now, frames, warnings };
}

export async function getGoesTimeline(platform: GoesPlatform, hours = 3): Promise<GoesTimeline> {
  const now = Date.now();
  let cached = timelines.get(platform);
  if (!cached || now - cached.fetched > 30_000) {
    let request = pending.get(platform);
    if (!request) {
      request = fetchTimeline(platform, now);
      pending.set(platform, request);
    }
    try { cached = await request; timelines.set(platform, cached); }
    finally { if (pending.get(platform) === request) pending.delete(platform); }
  }
  const frames = cached.frames.filter((frame) => Date.parse(frame.scanStart) >= now - hours * HOUR);
  return {
    platform, satellite: `GOES-${platform}`, product: "ABI-L2-FDCC", coverage: "CONUS",
    nominalCadenceMinutes: 5, fetchedAt: new Date(cached.fetched).toISOString(), hours,
    frames, latestKey: frames.at(-1)?.key ?? null, warnings: cached.warnings,
  };
}

export function knownGoesFrame(platform: GoesPlatform, key: string): GoesFrameMetadata | undefined {
  return timelines.get(platform)?.frames.find((frame) => frame.key === key);
}
