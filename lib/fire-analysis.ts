/**
 * Exploratory FIRMS analysis. Counts describe detections, never incidents or
 * burned area. CSV point records do not contain clear-sky observation coverage.
 */
export type Sensor = "MODIS" | "VIIRS";

export interface FirePoint {
  id: string;
  lat: number;
  lon: number;
  acquiredAt: string;
  sensor: Sensor;
  platform: string;
  frp: number | null;
  confidence: string;
  daynight: string;
  scan?: number;
  track?: number;
}

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface PointFilters {
  sensor?: Sensor | "ALL";
  start?: string;
  end?: string;
}

export interface CalendarBin {
  /** UTC YYYY-MM-DD for daily bins; YYYY-MM for monthly bins. */
  date: string;
  MODIS: number;
  VIIRS: number;
  /** Sum of sensor-cell-days, not a count of distinct fires. */
  total: number;
  rawDetections: number;
  platforms: string[];
  coverage: "unknown";
}

export interface SensorComparison {
  status: "provisional" | "insufficient";
  label: "Provisional comparison index";
  /** Median VIIRS / MODIS daily count ratio, fitted on training dates only. */
  ratio: number | null;
  pairedDays: number;
  /** Paired, nonzero days actually used for fitting / evaluation. */
  trainingDays: number;
  evaluationDays: number;
  /** All held-out dates, including dates with only one sensor's detections. */
  holdoutDays: number;
  evaluationStartsAt: string | null;
  /** Mean absolute difference in sensor-cell-days on paired held-out dates. */
  evaluationMae: number | null;
  baselineEvaluationMae: number | null;
  daily: Array<CalendarBin & {
    adjustedVIIRS: number | null;
    split: "training" | "evaluation" | "unpaired";
  }>;
  flags: string[];
}

/** Minimal RFC 4180 reader, including escaped quotes, BOM, and quoted newlines. */
function readCsv(text: string): string[][] {
  const input = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') {
        value += '"';
        i += 1;
      } else if (quoted || value.length === 0) {
        quoted = !quoted;
      } else {
        value += char;
      }
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      row.push(value);
      if (row.some((field) => field.trim() !== "")) rows.push(row);
      row = [];
      value = "";
      if (char === "\r" && input[i + 1] === "\n") i += 1;
    } else {
      value += char;
    }
  }
  if (quoted) throw new Error("The CSV has an unclosed quoted field.");
  row.push(value);
  if (row.some((field) => field.trim() !== "")) rows.push(row);
  return rows;
}

const normalizedHeader = (value: string) => value.trim().toLowerCase().replace(/[\s_-]/g, "");

function finiteNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonnegativeNumber(value: string): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function platformName(value: string): string {
  const key = value.trim().toUpperCase().replace(/[\s_-]/g, "");
  const known: Record<string, string> = {
    T: "Terra", TERRA: "Terra", A: "Aqua", AQUA: "Aqua",
    N: "Suomi NPP", SNPP: "Suomi NPP", SUOMINPP: "Suomi NPP", NPP: "Suomi NPP",
    N20: "NOAA-20", NOAA20: "NOAA-20", JPSS1: "NOAA-20",
    N21: "NOAA-21", NOAA21: "NOAA-21", JPSS2: "NOAA-21",
  };
  return known[key] ?? (value.trim() || "Unspecified");
}

function sensorName(value: string, platform: string, fallback?: Sensor): Sensor | null {
  const name = value.trim().toUpperCase();
  if (name.includes("VIIRS")) return "VIIRS";
  if (name.includes("MODIS")) return "MODIS";
  // Do not reinterpret explicitly unsupported instruments using a fallback.
  if (name) return null;
  if (["Terra", "Aqua"].includes(platform)) return "MODIS";
  if (["Suomi NPP", "NOAA-20", "NOAA-21"].includes(platform)) return "VIIRS";
  return fallback ?? null;
}

function isoDate(date: string, time: string, timestamp: string): string | null {
  if (timestamp) {
    // Require a timezone; local-machine timezone must never shift a calendar.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp)) return null;
    const calendarDate = timestamp.slice(0, 10);
    const calendarCheck = new Date(`${calendarDate}T00:00:00Z`);
    if (!Number.isFinite(calendarCheck.getTime()) || calendarCheck.toISOString().slice(0, 10) !== calendarDate) return null;
    const parsed = new Date(timestamp);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  let clock = time;
  if (/^\d{1,4}$/.test(clock)) clock = clock.padStart(4, "0");
  else if (/^\d{2}:\d{2}$/.test(clock)) clock = clock.replace(":", "");
  else return null;
  const hours = Number(clock.slice(0, 2));
  const minutes = Number(clock.slice(2, 4));
  if (hours > 23 || minutes > 59) return null;
  const result = new Date(`${date}T${clock.slice(0, 2)}:${clock.slice(2, 4)}:00.000Z`);
  if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== date) return null;
  return result.toISOString();
}

/**
 * Parse FIRMS CSV exports. Invalid rows are skipped; malformed/missing headers
 * throw a readable error. Geographic validation is global, with no US clipping.
 * confidence remains the provider's label, never a probability.
 */
export function parseFirmsCsv(text: string, defaultSensor?: Sensor): FirePoint[] {
  const rows = readCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map(normalizedHeader);
  const column = (...names: string[]) => names.map(normalizedHeader).map((name) => header.indexOf(name)).find((index) => index >= 0) ?? -1;
  const indices = {
    lat: column("latitude", "lat"), lon: column("longitude", "lon", "lng"),
    date: column("acq_date", "acquisition_date"), time: column("acq_time", "acquisition_time"),
    timestamp: column("acquired_at", "datetime", "timestamp"),
    sensor: column("instrument", "sensor"), platform: column("satellite", "platform"),
    frp: column("frp"), confidence: column("confidence"), daynight: column("daynight", "day_night"),
    scan: column("scan"), track: column("track"),
  };
  if (indices.lat < 0 || indices.lon < 0) throw new Error("CSV must include latitude and longitude columns.");
  if (indices.timestamp < 0 && (indices.date < 0 || indices.time < 0)) {
    throw new Error("CSV must include acq_date and acq_time, or a timezone-qualified acquired_at timestamp.");
  }
  if (indices.sensor < 0 && indices.platform < 0 && !defaultSensor) {
    throw new Error("CSV must identify an instrument or satellite, or be imported with a default sensor.");
  }
  const points: FirePoint[] = [];
  for (const row of rows.slice(1)) {
    const get = (key: keyof typeof indices) => (row[indices[key]] ?? "").trim();
    const lat = finiteNumber(get("lat"));
    const lon = finiteNumber(get("lon"));
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const platform = platformName(get("platform"));
    const sensor = sensorName(get("sensor"), platform, defaultSensor);
    const acquiredAt = isoDate(get("date"), get("time"), get("timestamp"));
    if (!sensor || !acquiredAt) continue;
    const scan = nonnegativeNumber(get("scan"));
    const track = nonnegativeNumber(get("track"));
    points.push({
      id: `${sensor}:${platform}:${acquiredAt}:${lat}:${lon}`,
      lat, lon, acquiredAt, sensor, platform,
      frp: nonnegativeNumber(get("frp")), confidence: get("confidence"), daynight: get("daynight").toUpperCase(),
      ...(scan !== null ? { scan } : {}), ...(track !== null ? { track } : {}),
    });
  }
  return points;
}

function filterBoundary(value: string | undefined, end: boolean): number | null {
  if (!value) return null;
  const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? isoDate(value, end ? "2359" : "0000", "")
    : isoDate("", "", value);
  if (!timestamp) throw new RangeError("Filter dates must be valid YYYY-MM-DD dates or timezone-qualified timestamps.");
  return Date.parse(timestamp) + (end && /^\d{4}-\d{2}-\d{2}$/.test(value) ? 59_999 : 0);
}

/** Bounds are inclusive; west > east intentionally supports antimeridian boxes. */
export function filterPoints(points: readonly FirePoint[], bounds?: Bounds, options: PointFilters = {}): FirePoint[] {
  if (bounds && (!Object.values(bounds).every(Number.isFinite) || Math.abs(bounds.west) > 180 || Math.abs(bounds.east) > 180 || bounds.south < -90 || bounds.north > 90 || bounds.south > bounds.north)) {
    throw new RangeError("Invalid geographic bounds.");
  }
  const start = filterBoundary(options.start, false);
  const end = filterBoundary(options.end, true);
  if (start !== null && end !== null && start > end) throw new RangeError("Start date must not be after end date.");
  return points.filter((point) => {
    if (options.sensor && options.sensor !== "ALL" && point.sensor !== options.sensor) return false;
    const time = Date.parse(point.acquiredAt);
    if (start !== null && time < start) return false;
    if (end !== null && time > end) return false;
    if (!bounds) return true;
    const longitudeInside = bounds.west <= bounds.east
      ? point.lon >= bounds.west && point.lon <= bounds.east
      : point.lon >= bounds.west || point.lon <= bounds.east;
    return longitudeInside && point.lat >= bounds.south && point.lat <= bounds.north;
  });
}

/**
 * Cylindrical equal-area grid, standard parallel 30 degrees and spherical
 * Earth radius 6371 km. Matches the historical archive pipeline. Cells have
 * 25 km² area at the default size; local cell shapes vary by latitude.
 */
function cellKey(point: FirePoint, cellSizeKm: number): string {
  const cos30 = Math.cos(Math.PI / 6);
  const x = 6371 * (point.lon * Math.PI / 180) * cos30;
  const y = 6371 * Math.sin(point.lat * Math.PI / 180) / cos30;
  return `${Math.floor(x / cellSizeKm)}:${Math.floor(y / cellSizeKm)}`;
}

/** Keep the earliest record in each sensor/cell/UTC-day, merging platforms. */
export function deduplicateCellDays(points: readonly FirePoint[], cellSizeKm = 5): FirePoint[] {
  if (!Number.isFinite(cellSizeKm) || cellSizeKm <= 0) throw new RangeError("Cell size must be positive.");
  const unique = new Map<string, FirePoint>();
  for (const point of points) {
    const key = `${point.sensor}:${cellKey(point, cellSizeKm)}:${point.acquiredAt.slice(0, 10)}`;
    const existing = unique.get(key);
    if (!existing || point.acquiredAt < existing.acquiredAt || (point.acquiredAt === existing.acquiredAt && point.id < existing.id)) unique.set(key, point);
  }
  return [...unique.values()].sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt) || a.id.localeCompare(b.id));
}

function calendar(points: readonly FirePoint[], monthly: boolean, cellSizeKm: number): CalendarBin[] {
  const bins = new Map<string, CalendarBin>();
  const dateKey = (point: FirePoint) => point.acquiredAt.slice(0, monthly ? 7 : 10);
  for (const point of points) {
    const date = dateKey(point);
    let bin = bins.get(date);
    if (!bin) {
      bin = { date, MODIS: 0, VIIRS: 0, total: 0, rawDetections: 0, platforms: [], coverage: "unknown" };
      bins.set(date, bin);
    }
    bin.rawDetections += 1;
    if (!bin.platforms.includes(point.platform)) bin.platforms.push(point.platform);
  }
  for (const point of deduplicateCellDays(points, cellSizeKm)) {
    const bin = bins.get(dateKey(point))!;
    bin[point.sensor] += 1;
    bin.total += 1;
  }
  return [...bins.values()].sort((a, b) => a.date.localeCompare(b.date)).map((bin) => ({ ...bin, platforms: bin.platforms.sort() }));
}

/** Only dates represented in the input are returned. Missing dates are not zeros. */
export function dailyCalendar(points: readonly FirePoint[], cellSizeKm = 5): CalendarBin[] {
  return calendar(points, false, cellSizeKm);
}

/** Monthly counts sum daily sensor-cell-presence, not unique monthly fires. */
export function monthlyCalendar(points: readonly FirePoint[], cellSizeKm = 5): CalendarBin[] {
  return calendar(points, true, cellSizeKm);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * An exploratory overlap comparison, NOT full sensor harmonization. The final
 * 20% of all represented dates are held out before selecting paired days.
 * At least six paired, nonzero training dates are needed for a scale estimate.
 */
export function compareSensors(points: readonly FirePoint[], cellSizeKm = 5): SensorComparison {
  const daily = dailyCalendar(points, cellSizeKm);
  const holdoutDays = Math.ceil(daily.length * 0.2);
  const cutoff = daily.length - holdoutDays;
  const paired = (bin: CalendarBin) => bin.MODIS > 0 && bin.VIIRS > 0;
  const training = daily.slice(0, cutoff).filter(paired);
  const evaluation = daily.slice(cutoff).filter(paired);
  const ratio = training.length >= 6 ? median(training.map((bin) => bin.VIIRS / bin.MODIS)) : null;
  const meanError = (scale: number) => evaluation.length
    ? evaluation.reduce((sum, bin) => sum + Math.abs(bin.VIIRS / scale - bin.MODIS), 0) / evaluation.length
    : null;
  const flags = [
    "Provisional comparison index; not a fully harmonized fire record.",
    "Observation coverage is unknown. Missing detections do not establish an observed zero.",
    "Counts are detected sensor-cell-days, not fire incidents, burned area, or ignition risk.",
    "The scale does not correct clouds, viewing angle, day/night sensitivity, or changing satellite coverage.",
  ];
  if (ratio === null) flags.push("Insufficient overlap: at least 6 paired nonzero training days are required after holding out the final 20% of dates.");
  if (evaluation.length === 0) flags.push("No paired nonzero held-out dates are available for evaluation.");
  else if (evaluation.length < 3) flags.push("Fewer than 3 paired held-out dates; evaluation is descriptive and too small to establish generalization.");
  if (points.some((point) => point.platform === "Unspecified")) flags.push("Some satellite platforms are unspecified; platform coverage cannot be inspected.");
  for (const sensor of ["MODIS", "VIIRS"] as const) {
    const platforms = new Set(points.filter((point) => point.sensor === sensor).map((point) => point.platform));
    if (platforms.size > 1) flags.push(`${sensor} includes multiple platforms. Shared cell-days are merged, but additional observation opportunities are not normalized.`);
  }
  return {
    status: ratio === null ? "insufficient" : "provisional",
    label: "Provisional comparison index", ratio,
    pairedDays: training.length + evaluation.length,
    trainingDays: training.length, evaluationDays: evaluation.length,
    holdoutDays, evaluationStartsAt: daily[cutoff]?.date ?? null,
    evaluationMae: ratio === null ? null : meanError(ratio),
    baselineEvaluationMae: meanError(1), flags,
    daily: daily.map((bin, index) => ({
      ...bin,
      adjustedVIIRS: ratio !== null && bin.VIIRS > 0 ? bin.VIIRS / ratio : null,
      split: !paired(bin) ? "unpaired" : index < cutoff ? "training" : "evaluation",
    })),
  };
}
