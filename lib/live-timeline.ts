/**
 * Acquisition-time replay of the supplied FIRMS observations. Current source
 * revisions may differ from data available at the original time; this is not
 * an operational forecast backtest. Every clock is supplied by the caller.
 */
export interface TimelinePoint {
  id: string;
  lat: number;
  lon: number;
  acquiredAt: string;
  sensor: string;
  frp: number | null;
}

export interface TimelineFrame {
  at: string;
  /** Explicit UTC label, independent of the browser's timezone. */
  label: string;
  /** Unique detection IDs acquired from the fixed window start through at. */
  count: number;
  /** Detections since the preceding frame, including at but excluding its time. */
  newCount: number;
}

export interface HotspotGroup {
  /** Equal-area grid-cell identifier, not a fire/incident identifier. */
  id: string;
  lat: number;
  lon: number;
  pointCount: number;
  latestAt: string;
  peakFrp: number | null;
  /** Present only when every detection in the group uses the same sensor. */
  sensor?: string;
}

const HOUR_MS = 3_600_000;

/** Require an explicit timezone and reject Date's silent calendar rollovers. */
function parseInstant(value: string): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|([+-])(\d{2}):(\d{2}))$/i.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59 || Number(match[6] ?? 0) > 23 || Number(match[7] ?? 0) > 59) return null;
  const date = new Date(`${match[1]}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

function hoursToMs(hours: number, integer: boolean): number {
  if (!Number.isFinite(hours) || hours < 0 || (integer && !Number.isInteger(hours))) {
    throw new RangeError(integer ? "Timeline hours must be a nonnegative integer." : "History hours must be a nonnegative number.");
  }
  return hours * HOUR_MS;
}

interface TimedPoint<T extends TimelinePoint> {
  point: T;
  time: number;
}

/** Deduplicate after filtering; retain the earliest valid acquisition per ID. */
function observations<T extends TimelinePoint>(points: readonly T[], start = -Infinity, end = Infinity): TimedPoint<T>[] {
  const unique = new Map<string, TimedPoint<T>>();
  for (const point of points) {
    if (!point || typeof point.id !== "string" || !point.id.trim() || !Number.isFinite(point.lat) || !Number.isFinite(point.lon) || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) continue;
    const time = parseInstant(point.acquiredAt);
    if (time === null || time < start || time > end) continue;
    const previous = unique.get(point.id);
    if (!previous || time < previous.time) unique.set(point.id, { point, time });
  }
  return [...unique.values()].sort((a, b) => a.time - b.time || a.point.id.localeCompare(b.point.id));
}

/**
 * The frame range depends only on referenceTime and floorHours, never on the
 * observations or their filters. A 24-hour range has 25 hourly frames, including
 * both endpoints; the reference's minutes and seconds are preserved.
 */
export function deriveTimeline(points: readonly TimelinePoint[], referenceTime: string, floorHours = 24): TimelineFrame[] {
  const windowMs = hoursToMs(floorHours, true);
  const end = parseInstant(referenceTime);
  if (end === null) return [];
  const start = end - windowMs;
  const ordered = observations(points, start, end);
  const frames: TimelineFrame[] = [];
  let cursor = 0;
  let previousCount = 0;
  for (let hour = 0; hour <= floorHours; hour += 1) {
    const time = start + hour * HOUR_MS;
    while (cursor < ordered.length && ordered[cursor].time <= time) cursor += 1;
    const at = new Date(time).toISOString();
    frames.push({ at, label: `${at.slice(11, 16)} UTC`, count: cursor, newCount: cursor - previousCount });
    previousCount = cursor;
  }
  return frames;
}

/**
 * Inclusive rolling acquisition window, default 24 hours. Invalid end times
 * return no points. For a fixed replay start, first restrict the source points
 * to the reference window; then apply this filter for each frame.
 */
export function filterAtTime<T extends TimelinePoint>(points: readonly T[], endISO: string, options: { historyHours?: number } = {}): T[] {
  const windowMs = hoursToMs(options.historyHours ?? 24, false);
  const end = parseInstant(endISO);
  if (end === null) return [];
  return observations(points, end - windowMs, end).map(({ point }) => point);
}

/**
 * Group supplied detections into equal-area cells (225 km² at the default
 * 15 km cell size). These are not incident boundaries or separate fires.
 * Call filterAtTime first when groups must respect a replay clock.
 */
export function groupHotspots(points: readonly TimelinePoint[], cellKm = 15): HotspotGroup[] {
  if (!Number.isFinite(cellKm) || cellKm <= 0) throw new RangeError("Hotspot cell size must be positive.");
  const cos30 = Math.cos(Math.PI / 6);
  const cells = new Map<string, { points: TimedPoint<TimelinePoint>[]; sensors: Set<string> }>();
  for (const item of observations(points)) {
    const { point } = item;
    const x = 6371 * point.lon * Math.PI / 180 * cos30;
    const y = 6371 * Math.sin(point.lat * Math.PI / 180) / cos30;
    const id = `hotspot-cell:${cellKm}:${Math.floor(x / cellKm)}:${Math.floor(y / cellKm)}`;
    let cell = cells.get(id);
    if (!cell) {
      cell = { points: [], sensors: new Set<string>() };
      cells.set(id, cell);
    }
    cell.points.push(item);
    cell.sensors.add(point.sensor);
  }
  return [...cells.entries()].map(([id, cell]) => {
    const count = cell.points.length;
    const validFrp = cell.points.map(({ point }) => point.frp).filter((frp): frp is number => typeof frp === "number" && Number.isFinite(frp) && frp >= 0);
    return {
      id,
      lat: cell.points.reduce((sum, { point }) => sum + point.lat, 0) / count,
      lon: cell.points.reduce((sum, { point }) => sum + point.lon, 0) / count,
      pointCount: count,
      latestAt: new Date(cell.points[cell.points.length - 1].time).toISOString(),
      peakFrp: validFrp.length ? Math.max(...validFrp) : null,
      ...(cell.sensors.size === 1 ? { sensor: [...cell.sensors][0] } : {}),
    };
  }).sort((a, b) => b.latestAt.localeCompare(a.latestAt) || b.pointCount - a.pointCount || a.id.localeCompare(b.id));
}

/** Format age against an injected clock; future timestamps are never clamped. */
export function formatAge(timestamp: string, nowISO: string): string {
  const then = parseInstant(timestamp);
  const now = parseInstant(nowISO);
  if (then === null || now === null) return "Time unavailable";
  const elapsed = now - then;
  if (elapsed < 0) return "In the future";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes === 0) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
