export type InputStatus = "available" | "stale" | "unsupported" | "unavailable";
export type InputSourceStatus = { id: string; status: InputStatus; url: string; fetchedAt: string; sourceDate: string | null; error?: string; warnings: string[] };
export type InputBounds = { west: number; south: number; east: number; north: number };
export type InputOptions = { fetcher?: typeof fetch; now?: () => number };
export const GRIDMET_CODES = ["erc", "pdsi", "vs", "th", "tmmn", "tmmx", "sph", "pr", "fm100", "fm1000", "rmin", "rmax"] as const;
export type GridmetCode = typeof GRIDMET_CODES[number];
const DEFAULT_GRIDMET: GridmetCode[] = ["erc", "pdsi", "vs", "th", "tmmn", "tmmx", "sph", "pr", "fm100", "fm1000"];
export type GridmetGrid = { code: GridmetCode; date: string; requestedDate: string; latitudes: number[]; longitudes: number[]; values: (number | null)[][]; units: string; sourceUrl: string; nominalWindowStart: string; nominalWindowEnd: string; preliminary: boolean; resolutionDegrees: number; warnings: string[] };
export type GridmetArea = { requestedDate: string; grids: Partial<Record<GridmetCode, GridmetGrid>>; sources: InputSourceStatus[] };
export type GridmetMetadata = { code: GridmetCode; variable: string; units: string; scale: number; offset: number; fill: number; days: number[]; latitudes: number[]; longitudes: number[] };
export type GfsHour = { validAt: string; temperatureK: number | null; dewpointC: number | null; surfacePressurePa: number | null; relativeHumidityPct: number | null; specificHumidityKgKg: number | null; windSpeedMs: number | null; windDirectionDeg: number | null; uMs: number | null; vMs: number | null; windGustMs: number | null; precipMm: number | null };
export type GfsDaily = { date: string; windowStart: string; windowEnd: string; temperatureK: number | null; specificHumidityKgKg: number | null; meanWindSpeedMs: number | null; vectorMeanWindSpeedMs: number | null; meanUMs: number | null; meanVMs: number | null; windDirectionDeg: number | null; precipMm: number | null; coverageHours: Record<string, number>; requiredHours: 24 };
export type GfsAntecedent = GfsDaily & { forecastHourStart: number; forecastHourEnd: number; endInclusive: true };
export type GfsForecast = { model: "gfs_global"; provider: "Open-Meteo / NOAA GFS"; runInitializedAt: string; sourcePublishedAt: null; fetchedAt: string; validDate: string; status: InputStatus; sourceUrl: string; gridPoint: { lat: number; lon: number; elevationM: number | null }; hourly: GfsHour[]; daily: GfsDaily[]; antecedent: GfsAntecedent; availabilityRule: string; modelCompatibility: "experimental-transfer"; warnings: string[] };
export type OfficialFireAlert = { id: string; event: string; sent: string; effective: string | null; expires: string | null; headline: string; description: string; instruction: string | null; url: string };
export type PredictionInputs = { schemaVersion: 1; point: { lat: number; lon: number }; fetchedAt: string; issueDate: string; overallStatus: "available" | "partial" | "unavailable"; sources: InputSourceStatus[]; officialAlerts: OfficialFireAlert[] | null; gfs: GfsForecast | null; gridmet: GridmetArea; elevation: { meters: number; provider: string; resolutionM: 90; sourceUrl: string } | null; modelCompatibility: "experimental-transfer"; warnings: string[] };

const DAY = 86400000;
const GRIDMET_EPOCH = Date.UTC(1900, 0, 1);
const GRIDMET_ROOT = "https://thredds.northwestknowledge.net/thredds/";
const NWS_URL = "https://api.weather.gov/alerts/active";
const ELEVATION_URL = "https://api.open-meteo.com/v1/elevation";
const metadataCache = new Map<GridmetCode, { at: number; value: GridmetMetadata }>();
const gridCache = new Map<string, { at: number; value: GridmetGrid }>();
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const dayIso = (n: number) => new Date(n).toISOString().slice(0, 10);
const errorText = (error: unknown) => error instanceof Error ? error.message : "Source unavailable";
export function validInputDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && dayIso(Date.parse(value)) === value; }
export function parsePredictionLocation(params: URLSearchParams): { lat: number; lon: number } | null {
  const a = params.get("lat"), b = params.get("lon");
  if (!a?.trim() || !b?.trim()) return null;
  const lat = Number(a), lon = Number(b);
  return finite(lat) && finite(lon) && lat >= 18 && lat <= 72 && lon >= -180 && lon <= -60 ? { lat, lon } : null;
}
function validPoint(lat: number, lon: number) { return finite(lat) && finite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180; }
function conus(lat: number, lon: number) { return lat >= 25.0666 && lat <= 49.4 && lon >= -124.7666 && lon <= -67.0583; }
function validateBounds(b: InputBounds) {
  if (![b.west, b.south, b.east, b.north].every(finite) || b.west > b.east || b.south > b.north || b.west < -180 || b.east > 180 || b.south < -90 || b.north > 90 || b.east - b.west > 1.5 || b.north - b.south > 1) throw new RangeError("Provide a bounded area no larger than 1.5° longitude by 1° latitude.");
}
async function sourceText(url: string, options: InputOptions, maxBytes = 1_000_000): Promise<string> {
  const response = await (options.fetcher ?? fetch)(url, { headers: { "User-Agent": "EmberAtlas-Research/1.0", Accept: "application/json,text/plain,application/xml" }, cache: "no-store", signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}.`);
  const declaredSize = Number(response.headers.get("content-length"));
  if (declaredSize > maxBytes) throw new Error("Source response exceeded the size limit.");
  if (!response.body) return "";
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) throw new Error("Source response exceeded the size limit."); chunks.push(value); } }
  catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
function xmlAttributes(text: string): Record<string, string> { return Object.fromEntries([...text.matchAll(/([\w:-]+)="([^"]*)"/g)].map(m => [m[1], m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"')])); }
function axisValues(xml: string, name: string): number[] {
  const axis = [...xml.matchAll(/<axis\b([^>]*)>([\s\S]*?)<\/axis>/g)].find(m => xmlAttributes(m[1]).name === name);
  const values = axis?.[2].match(/<values\b([^>]*)(?:\/>|>([\s\S]*?)<\/values>)/);
  if (!values) throw new Error(`Missing gridMET ${name} axis.`);
  const attrs = xmlAttributes(values[1]); let result: number[];
  if (attrs.npts) { const n = Number(attrs.npts), start = Number(attrs.start), increment = Number(attrs.increment); if (!Number.isInteger(n) || n < 1 || n > 50_000 || !finite(start) || !finite(increment)) throw new Error("Invalid gridMET axis."); result = Array.from({ length: n }, (_, i) => start + i * increment); }
  else result = (values[2] ?? "").trim().split(/\s+/).map(Number);
  if (!result.length || result.length > 50_000 || !result.every(finite)) throw new Error("Invalid gridMET axis values.");
  return result;
}
export function parseGridmetMetadata(xml: string, code: GridmetCode): GridmetMetadata {
  const grid = [...xml.matchAll(/<grid\b([^>]*)>([\s\S]*?)<\/grid>/g)].find(m => xmlAttributes(m[1]).desc === code);
  if (!grid) throw new Error(`Missing gridMET ${code} variable.`);
  const a = Object.fromEntries([...grid[2].matchAll(/<attribute\b([^>]*)\/>/g)].map(m => { const attr = xmlAttributes(m[1]); return [attr.name, attr.value]; }));
  const scale = Number(a.scale_factor ?? 1), offset = Number(a.add_offset ?? 0), fill = Number(a._FillValue ?? a.missing_value);
  if (![scale, offset, fill].every(finite)) throw new Error("Invalid gridMET scaling metadata.");
  // The PDSI metadata leaves its dimensionless unit empty.
  return { code, variable: xmlAttributes(grid[1]).name, units: a.units?.trim() || (code === "pdsi" ? "1" : ""), scale, offset, fill, days: axisValues(xml, "day"), latitudes: axisValues(xml, "lat"), longitudes: axisValues(xml, "lon") };
}
function nearestIndex(values: number[], value: number): number { return values.reduce((best, n, i) => Math.abs(n - value) < Math.abs(values[best] - value) ? i : best, 0); }
function priorDayIndex(days: number[], requestedDate: string): number { const requested = (Date.parse(`${requestedDate}T00:00:00Z`) - GRIDMET_EPOCH) / DAY; let best = -1; for (let i = 0; i < days.length; i++) if (days[i] <= requested + 1e-7 && (best < 0 || days[i] > days[best])) best = i; return best; }
export function parseGridmetAscii(text: string, metadata: GridmetMetadata, expectedRows: number, expectedColumns: number): (number | null)[][] {
  if (!Number.isInteger(expectedRows) || !Number.isInteger(expectedColumns) || expectedRows < 1 || expectedColumns < 1 || expectedRows > 32 || expectedColumns > 40) throw new Error("Invalid grid dimensions.");
  const body = text.split(/-{10,}/)[1];
  if (!body || !body.includes(metadata.variable)) throw new Error("Unexpected gridMET response.");
  const rows = [...body.matchAll(/^\[0\]\[(\d+)\],\s*([^\r\n]+)/gm)];
  if (rows.length !== expectedRows) throw new Error("Incomplete gridMET rows.");
  return rows.map((row, index) => {
    if (Number(row[1]) !== index) throw new Error("Unexpected gridMET row order.");
    const raw = row[2].split(",").map(v => Number(v.trim()));
    if (raw.length !== expectedColumns) throw new Error("Incomplete gridMET columns.");
    return raw.map(value => !finite(value) || value === metadata.fill ? null : value * metadata.scale + metadata.offset);
  });
}
function gridStem(code: GridmetCode) { return `agg_met_${code}_1979_CurrentYear_CONUS.nc`; }
async function gridMetadata(code: GridmetCode, options: InputOptions): Promise<GridmetMetadata> {
  const now = (options.now ?? Date.now)(), cached = metadataCache.get(code);
  if (!options.fetcher && cached && now >= cached.at && now - cached.at < 6 * 3600_000) return cached.value;
  const value = parseGridmetMetadata(await sourceText(`${GRIDMET_ROOT}ncss/grid/${gridStem(code)}/dataset.xml`, options, 150_000), code);
  if (!options.fetcher) metadataCache.set(code, { at: now, value }); return value;
}
async function oneGrid(code: GridmetCode, bounds: InputBounds, date: string, options: InputOptions): Promise<GridmetGrid> {
  const metadata = await gridMetadata(code, options);
  // WSTS midnight selection uses the prior pentad on a label boundary;
  // three sampled events match native labels strictly before the weather day.
  const selectionDate = code === "pdsi" ? dayIso(Date.parse(date) - DAY) : date;
  const day = priorDayIndex(metadata.days, selectionDate);
  if (day < 0) throw new Error("Requested date precedes the source record.");
  const actualDate = dayIso(GRIDMET_EPOCH + metadata.days[day] * DAY);
  const a = nearestIndex(metadata.latitudes, bounds.north), b = nearestIndex(metadata.latitudes, bounds.south);
  const c = nearestIndex(metadata.longitudes, bounds.west), d = nearestIndex(metadata.longitudes, bounds.east);
  const firstRow = Math.min(a, b), lastRow = Math.max(a, b), firstCol = Math.min(c, d), lastCol = Math.max(c, d);
  const rows = lastRow - firstRow + 1, columns = lastCol - firstCol + 1;
  if (rows > 32 || columns > 40) throw new Error("Requested area exceeds the grid cell limit.");
  const url = new URL(`${GRIDMET_ROOT}dodsC/${gridStem(code)}.ascii`);
  url.search = `${metadata.variable}[${day}:1:${day}][${firstRow}:1:${lastRow}][${firstCol}:1:${lastCol}]`;
  const key = url.toString(), now = (options.now ?? Date.now)(), cached = gridCache.get(key);
  if (!options.fetcher && cached && now >= cached.at && now - cached.at < 3600_000) return { ...cached.value, requestedDate: date };
  const values = parseGridmetAscii(await sourceText(key, options, 150_000), metadata, rows, columns);
  const start = Date.parse(`${actualDate}T07:00:00Z`);
  const value: GridmetGrid = { code, date: actualDate, requestedDate: date, latitudes: metadata.latitudes.slice(firstRow, lastRow + 1), longitudes: metadata.longitudes.slice(firstCol, lastCol + 1), values, units: metadata.units, sourceUrl: key, nominalWindowStart: new Date(start).toISOString(), nominalWindowEnd: new Date(start + DAY).toISOString(), preliminary: now - Date.parse(actualDate) < 60 * DAY, resolutionDegrees: 1 / 24, warnings: ["Daily analyses use a nominal 07:00–07:00 UTC day; the date label is not a publication timestamp.", ...(code === "erc" ? ["ERC is modeled for fuel model G, not every vegetation type."] : []), ...(code === "pdsi" ? ["PDSI uses the latest native label strictly before the weather day, matching three sampled WSTS events. Full interval parity is unverified; the source does not expose the Earth Engine validity interval. Its nominal daily window is not its accumulation period."] : [])] };
  if (!options.fetcher) { if (gridCache.size >= 120) gridCache.delete(gridCache.keys().next().value!); gridCache.set(key, { at: now, value }); }
  return value;
}
export async function fetchGridmetArea(bounds: InputBounds, requestedDate: string, options: InputOptions & { codes?: GridmetCode[] } = {}): Promise<GridmetArea> {
  validateBounds(bounds); if (!validInputDate(requestedDate)) throw new RangeError("Use a valid YYYY-MM-DD date.");
  const codes = [...new Set(options.codes ?? DEFAULT_GRIDMET)];
  if (codes.length > 12 || codes.some(code => !GRIDMET_CODES.includes(code))) throw new RangeError("Unsupported gridMET variable.");
  const now = (options.now ?? Date.now)(); const fetchedAt = new Date(now).toISOString();
  if (Date.parse(requestedDate) > now) throw new RangeError("Future gridMET analyses are unavailable.");
  const result: GridmetArea = { requestedDate, grids: {}, sources: [] };
  if (!conus(bounds.south, bounds.west) || !conus(bounds.north, bounds.east)) { result.sources = codes.map(code => ({ id: `gridmet:${code}`, status: "unsupported", url: `${GRIDMET_ROOT}ncss/grid/${gridStem(code)}`, fetchedAt, sourceDate: null, warnings: ["This gridMET product covers the contiguous United States."] })); return result; }
  // At most four concurrent requests to the public university service.
  for (let start = 0; start < codes.length; start += 4) await Promise.all(codes.slice(start, start + 4).map(async code => {
    try { const grid = await oneGrid(code, bounds, requestedDate, options); result.grids[code] = grid; const age = Date.parse(requestedDate) - Date.parse(grid.date); result.sources.push({ id: `gridmet:${code}`, status: age > (code === "pdsi" ? 5 : 0) * DAY ? "stale" : "available", url: grid.sourceUrl, fetchedAt, sourceDate: grid.date, warnings: grid.warnings }); }
    catch (error) { result.sources.push({ id: `gridmet:${code}`, status: "unavailable", url: `${GRIDMET_ROOT}ncss/grid/${gridStem(code)}`, fetchedAt, sourceDate: null, error: errorText(error), warnings: [] }); }
  }));
  result.sources.sort((a, b) => a.id.localeCompare(b.id)); return result;
}

/** Conservative eligibility rule; initialization is not actual publication time. */
export function selectGfsCycle(now: number): string { if (!finite(now)) throw new RangeError("A valid reference time is required."); const date = new Date(now); const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()); return new Date(now - midnight >= 6 * 3600_000 ? midnight : midnight - DAY).toISOString(); }
export function specificHumidityFromDewpoint(dewpointC: number | null, surfacePressurePa: number | null): number | null {
  if (!finite(dewpointC) || !finite(surfacePressurePa) || dewpointC < -100 || dewpointC > 70 || surfacePressurePa < 30_000 || surfacePressurePa > 115_000) return null;
  const vaporPressure = 611.2 * Math.exp(17.67 * dewpointC / (dewpointC + 243.5));
  if (vaporPressure >= surfacePressurePa) return null;
  return .622 * vaporPressure / (surfacePressurePa - .378 * vaporPressure);
}
export function deriveGfsDaily(hours: GfsHour[], date: string): GfsDaily {
  if (!validInputDate(date)) throw new RangeError("A valid UTC date is required.");
  const start = Date.parse(`${date}T00:00:00Z`); const samples = new Map<number, GfsHour>();
  for (const hour of hours) { const at = Date.parse(hour.validAt); if (finite(at) && at >= start && at < start + DAY && (at - start) % 3600_000 === 0) samples.set(at, hour); }
  const rows = [...samples.values()]; const fields = ["temperatureK", "specificHumidityKgKg", "windSpeedMs", "uMs", "vMs", "precipMm"] as const;
  const coverageHours = Object.fromEntries(fields.map(key => [key, rows.filter(row => finite(row[key])).length]));
  const mean = (key: typeof fields[number]) => coverageHours[key] === 24 ? rows.reduce((n, row) => n + row[key]!, 0) / 24 : null;
  const u = mean("uMs"), v = mean("vMs"), speed = u === null || v === null ? null : Math.hypot(u, v);
  return { date, windowStart: new Date(start).toISOString(), windowEnd: new Date(start + DAY).toISOString(), temperatureK: mean("temperatureK"), specificHumidityKgKg: mean("specificHumidityKgKg"), meanWindSpeedMs: mean("windSpeedMs"), vectorMeanWindSpeedMs: speed, meanUMs: u, meanVMs: v, windDirectionDeg: speed === null || speed < 1e-8 ? null : (Math.atan2(-u!, -v!) * 180 / Math.PI + 360) % 360, precipMm: coverageHours.precipMm === 24 ? rows.reduce((n, row) => n + row.precipMm!, 0) : null, coverageHours, requiredHours: 24 };
}
/** WSTS-compatible hour window: I01 UTC through I+1 00 UTC, inclusive. */
export function deriveGfsAntecedent(hours: GfsHour[], validDate: string): GfsAntecedent {
  const shifted = hours.filter(hour => finite(Date.parse(hour.validAt))).map(hour => ({ ...hour, validAt: new Date(Date.parse(hour.validAt) - 3600_000).toISOString() }));
  const summary = deriveGfsDaily(shifted, validDate);
  return { ...summary, windowStart: new Date(Date.parse(summary.windowStart) + 3600_000).toISOString(), forecastHourStart: 1, forecastHourEnd: 24, endInclusive: true };
}
export function normalizeGfsResponse(value: unknown, runInitializedAt: string, validDate: string, sourceUrl: string, fetchedAt: string): GfsForecast {
  const data = value as { latitude?: unknown; longitude?: unknown; elevation?: unknown; utc_offset_seconds?: unknown; hourly?: Record<string, unknown[]>; hourly_units?: Record<string, string> };
  if (!data || !Array.isArray(data.hourly?.time) || data.hourly.time.length > 96 || data.utc_offset_seconds !== 0 || !finite(data.latitude) || !finite(data.longitude)) throw new Error("Invalid GFS response.");
  const units = data.hourly_units ?? {};
  if (units.temperature_2m !== "°C" || units.dew_point_2m !== "°C" || units.surface_pressure !== "hPa" || units.wind_speed_10m !== "m/s" || units.precipitation !== "mm") throw new Error("Unexpected GFS units.");
  const hourly = data.hourly, seen = new Set<string>();
  const num = (key: string, i: number, min: number, max: number) => { const n = hourly[key]?.[i]; return finite(n) && n >= min && n <= max ? n : null; };
  const hours: GfsHour[] = [];
  for (let i = 0; i < hourly.time.length; i++) {
    const time = hourly.time[i]; if (typeof time !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(time)) continue;
    const at = Date.parse(`${time}Z`), run = Date.parse(runInitializedAt); if (!finite(at) || new Date(at).toISOString().slice(0, 16) !== time || !finite(run) || at < run || at >= run + 4 * DAY) continue;
    const validAt = new Date(at).toISOString(); if (seen.has(validAt)) continue; seen.add(validAt);
    const temp = num("temperature_2m", i, -100, 70), dewpointC = num("dew_point_2m", i, -100, 70), pressure = num("surface_pressure", i, 300, 1150);
    const surfacePressurePa = pressure === null ? null : pressure * 100;
    const windSpeedMs = num("wind_speed_10m", i, 0, 150), windDirectionDeg = num("wind_direction_10m", i, 0, 360);
    const validWind = windSpeedMs !== null && windDirectionDeg !== null;
    hours.push({ validAt, temperatureK: temp === null ? null : temp + 273.15, dewpointC, surfacePressurePa, relativeHumidityPct: num("relative_humidity_2m", i, 0, 100), specificHumidityKgKg: specificHumidityFromDewpoint(dewpointC, surfacePressurePa), windSpeedMs, windDirectionDeg, uMs: validWind ? -windSpeedMs * Math.sin(windDirectionDeg * Math.PI / 180) : null, vMs: validWind ? -windSpeedMs * Math.cos(windDirectionDeg * Math.PI / 180) : null, windGustMs: num("wind_gusts_10m", i, 0, 200), precipMm: num("precipitation", i, 0, 1000) });
  }
  if (!hours.length) throw new Error("No usable GFS hours returned.");
  const daily = [...new Set(hours.map(hour => hour.validAt.slice(0, 10)))].map(date => deriveGfsDaily(hours, date));
  const antecedent = deriveGfsAntecedent(hours, validDate);
  antecedent.forecastHourStart = (Date.parse(antecedent.windowStart) - Date.parse(runInitializedAt)) / 3600_000;
  antecedent.forecastHourEnd = (Date.parse(antecedent.windowEnd) - Date.parse(runInitializedAt)) / 3600_000;
  return { model: "gfs_global", provider: "Open-Meteo / NOAA GFS", runInitializedAt, sourcePublishedAt: null, fetchedAt, validDate, status: runInitializedAt.slice(0, 10) === validDate ? "available" : "stale", sourceUrl, gridPoint: { lat: data.latitude, lon: data.longitude, elevationM: finite(data.elevation) ? data.elevation : null }, hourly: hours, daily, antecedent, availabilityRule: "Only 00 UTC runs at least six hours old are attempted. A successful request verifies availability now; initialization does not establish historical publication time.", modelCompatibility: "experimental-transfer", warnings: ["Weather is an exact archived GFS initialization accessed through Open-Meteo; interpolation/processing differ from original WSTS ingestion.", "Specific humidity is derived from forecast dewpoint and surface pressure, not a directly retrieved specific-humidity field.", "The valid UTC calendar day includes hours before this request. For the pilot, F01–F24 are antecedent forecast features for the following-day target; an older fallback run is context only.", "Precipitation is context only; it is excluded from model features because historical WSTS precipitation aggregation is not comparable."] };
}
export async function fetchGfsPoint(lat: number, lon: number, options: InputOptions = {}): Promise<GfsForecast> {
  if (!validPoint(lat, lon)) throw new RangeError("Valid coordinates are required.");
  const now = (options.now ?? Date.now)(), cycle = selectGfsCycle(now), validDate = cycle.slice(0, 10); let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const run = new Date(Date.parse(cycle) - attempt * DAY).toISOString();
    const url = new URL("https://single-runs-api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({ latitude: String(lat), longitude: String(lon), run: run.slice(0, 16), hourly: "temperature_2m,dew_point_2m,surface_pressure,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation", models: "gfs_global", timezone: "UTC", wind_speed_unit: "ms", forecast_days: "3" }).toString();
    try { const data = normalizeGfsResponse(JSON.parse(await sourceText(url.toString(), options, 100_000)), run, validDate, url.toString(), new Date((options.now ?? Date.now)()).toISOString()); if (attempt) data.warnings.push("The intended 00 UTC run was unavailable; this is the preceding day's run and is not an exact feature match."); return data; } catch (error) { lastError = error; }
  }
  throw new Error(`GFS forecast unavailable: ${errorText(lastError)}`);
}
export function normalizeFireAlerts(value: unknown, now: number): OfficialFireAlert[] {
  const data = value as { features?: Array<{ id?: unknown; properties?: Record<string, unknown> }> };
  if (!Array.isArray(data?.features) || data.features.length > 500) throw new Error("Invalid NWS alert response.");
  const alerts: OfficialFireAlert[] = [];
  for (const feature of data.features) { const p = feature.properties ?? {}; if (!["Red Flag Warning", "Fire Weather Watch", "Extreme Fire Danger", "Fire Warning"].includes(String(p.event)) || p.status !== "Actual") continue;
    const sent = typeof p.sent === "string" && finite(Date.parse(p.sent)) ? new Date(p.sent).toISOString() : null;
    const expires = typeof p.expires === "string" && finite(Date.parse(p.expires)) ? new Date(p.expires).toISOString() : null;
    if (!sent || Date.parse(sent) > now || (expires && Date.parse(expires) <= now)) continue;
    const id = typeof feature.id === "string" ? feature.id : typeof p.id === "string" ? p.id : null; if (!id) continue;
    const url = id.startsWith("https://api.weather.gov/alerts/") ? id : "https://www.weather.gov/";
    alerts.push({ id, event: String(p.event), sent, effective: typeof p.effective === "string" && finite(Date.parse(p.effective)) ? new Date(p.effective).toISOString() : null, expires, headline: typeof p.headline === "string" ? p.headline.slice(0, 1000) : String(p.event), description: typeof p.description === "string" ? p.description.slice(0, 12000) : "", instruction: typeof p.instruction === "string" ? p.instruction.slice(0, 12000) : null, url });
  } return alerts;
}
export async function fetchPredictionInputs(lat: number, lon: number, options: InputOptions & { bounds?: InputBounds } = {}): Promise<PredictionInputs> {
  if (!validPoint(lat, lon)) throw new RangeError("Valid coordinates are required.");
  if (options.bounds) validateBounds(options.bounds);
  const now = (options.now ?? Date.now)(), fetchedAt = new Date(now).toISOString(), issueDate = selectGfsCycle(now).slice(0, 10), lagDate = dayIso(Date.parse(issueDate) - 2 * DAY);
  const nwsUrl = `${NWS_URL}?${new URLSearchParams({ point: `${lat},${lon}` })}`, elevationUrl = `${ELEVATION_URL}?${new URLSearchParams({ latitude: String(lat), longitude: String(lon) })}`;
  const [gfs, alerts, terrain, gridmet] = await Promise.allSettled([
    fetchGfsPoint(lat, lon, options),
    sourceText(nwsUrl, options).then(text => normalizeFireAlerts(JSON.parse(text), now)),
    sourceText(elevationUrl, options, 10_000).then(text => { const n = (JSON.parse(text) as { elevation?: unknown[] }).elevation?.[0]; if (!finite(n) || n < -500 || n > 9000) throw new Error("Invalid elevation response."); return { meters: n, provider: "Open-Meteo / Copernicus GLO-90", resolutionM: 90 as const, sourceUrl: elevationUrl }; }),
    fetchGridmetArea(options.bounds ?? { west: lon, east: lon, south: lat, north: lat }, lagDate, options),
  ]);
  const sources: InputSourceStatus[] = [
    { id: "gfs", status: gfs.status === "fulfilled" ? gfs.value.status : "unavailable", url: gfs.status === "fulfilled" ? gfs.value.sourceUrl : "https://open-meteo.com/en/docs/single-runs-api", fetchedAt, sourceDate: gfs.status === "fulfilled" ? gfs.value.runInitializedAt : null, ...(gfs.status === "rejected" ? { error: errorText(gfs.reason) } : {}), warnings: gfs.status === "fulfilled" ? gfs.value.warnings : [] },
    { id: "nws", status: alerts.status === "fulfilled" ? "available" : "unavailable", url: nwsUrl, fetchedAt, sourceDate: null, ...(alerts.status === "rejected" ? { error: errorText(alerts.reason) } : {}), warnings: ["Official watches and warnings are separate from any experimental model output."] },
    { id: "elevation", status: terrain.status === "fulfilled" ? "available" : "unavailable", url: elevationUrl, fetchedAt, sourceDate: "2021", ...(terrain.status === "rejected" ? { error: errorText(terrain.reason) } : {}), warnings: ["Copernicus GLO-90 is a 90 m elevation product; it is not identical to the SRTM terrain used by WSTS."] },
  ];
  const area: GridmetArea = gridmet.status === "fulfilled" ? gridmet.value : { requestedDate: lagDate, grids: {}, sources: [{ id: "gridmet", status: "unavailable", url: GRIDMET_ROOT, fetchedAt, sourceDate: null, error: errorText(gridmet.reason), warnings: [] }] };
  sources.push(...area.sources); const available = sources.filter(source => source.status === "available").length;
  return { schemaVersion: 1, point: { lat, lon }, fetchedAt, issueDate, overallStatus: available === sources.length ? "available" : available ? "partial" : "unavailable", sources, officialAlerts: alerts.status === "fulfilled" ? alerts.value : null, gfs: gfs.status === "fulfilled" ? gfs.value : null, gridmet: area, elevation: terrain.status === "fulfilled" ? terrain.value : null, modelCompatibility: "experimental-transfer", warnings: ["This endpoint supplies measured or modeled inputs and official alerts. It does not calculate a wildfire probability.", "GridMET fields are lagged analyses for issue date minus two days and can be revised. Publication time is unknown unless captured prospectively.", "Live-provider processing and observation-mask differences require separate validation; historical model calibration does not establish live calibration.", "Weather and elevation data by Open-Meteo; Copernicus terrain attribution applies."] };
}
