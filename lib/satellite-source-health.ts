export const SNPP_OUTAGE_URL = 'https://modaps.modaps.eosdis.nasa.gov/services/production/outages_suomi_npp.html';
export const NOAA20_OUTAGE_URL = 'https://modaps.modaps.eosdis.nasa.gov/services/production/outages_noaa_20.html';
export type OutageSensor = 'snpp' | 'noaa20';
/** NASA publishes one table per platform with the same five-column schema; only the table summary differs. */
const SOURCES: Record<OutageSensor, { url: string; label: string; summary: RegExp }> = {
  snpp: { url: SNPP_OUTAGE_URL, label: 'S-NPP', summary: /<table\b[^>]*summary=["'][^"']*VIIRS\/Suomi-NPP Data Outages[^"']*["'][^>]*>([\s\S]*?)<\/table>/i },
  noaa20: { url: NOAA20_OUTAGE_URL, label: 'NOAA-20', summary: /<table\b[^>]*summary=["'][^"']*VIIRS\/NOAA-20\(NOAA20\) Data Outages[^"']*["'][^>]*>([\s\S]*?)<\/table>/i },
};
export type SatelliteOutage = { start: string; end: string; description: string };
export type SatelliteOutageCatalog = { sourceUpdatedDate: string; outages: SatelliteOutage[] };
export type SatelliteSourceHealth = {
  status: 'no-reported-gap' | 'reported-gap' | 'unavailable';
  sourceUrl: string;
  fetchedAt: string;
  checkedAt: string;
  sourceUpdatedDate: string | null;
  requiredDates: string[];
  overlappingOutages: SatelliteOutage[];
  observationalCoverage: 'unknown';
  warnings: string[];
  error?: string;
};
type HealthOptions = { fetcher?: typeof fetch; now?: () => number };
type FetchedCatalog = { fetchedAt: string; catalog: SatelliteOutageCatalog | null; error?: string };
const DAY = 86400000, SUCCESS_CACHE_MS = 30 * 60_000, FAILURE_CACHE_MS = 60_000, MAX_BYTES = 256_000;
const cached: Partial<Record<OutageSensor, { at: number; value: FetchedCatalog }>> = {};
const pending: Partial<Record<OutageSensor, { at: number; value: Promise<FetchedCatalog> }>> = {};
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function text(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&ndash;|&mdash;/gi, '-').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim();
}
function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function dayOfYear(yearText: string, dayText: string): number {
  const year = Number(yearText), day = Number(dayText), at = Date.UTC(year, 0, day);
  if (year < 2011 || year > 2100 || day < 1 || day > 366 || new Date(at).getUTCFullYear() !== year) throw new Error('Invalid NASA outage year/day.');
  return at;
}
function timeOfDay(value: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)) throw new Error('Invalid NASA outage UTC time.');
  const [hours, minutes, seconds] = value.split(':').map(Number);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

/** NASA's explicit table boundaries are UTC; end is the first following boundary.
 * A single-date row ending at midnight rolls into the following UTC day.
 * Dates in prose comments never override the structured interval columns.
 */
export function parseSnppOutageCatalog(html: string): SatelliteOutageCatalog { return parseOutageCatalog(html, 'snpp'); }
export function parseOutageCatalog(html: string, sensor: OutageSensor): SatelliteOutageCatalog {
  if (typeof html !== 'string' || html.length > MAX_BYTES) throw new Error('NASA outage catalogue exceeds the size limit.');
  const updated = text(html).match(/Last Update:\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
  const month = months.findIndex(value => value.toLowerCase() === updated?.[1].toLowerCase());
  if (!updated || month < 0) throw new Error('NASA outage catalogue has no recognized update date.');
  const updatedAt = Date.UTC(Number(updated[3]), month, Number(updated[2]));
  if (new Date(updatedAt).getUTCMonth() !== month || new Date(updatedAt).getUTCDate() !== Number(updated[2])) throw new Error('Invalid NASA catalogue update date.');
  const sourceUpdatedDate = new Date(updatedAt).toISOString().slice(0, 10);
  const table = html.match(SOURCES[sensor].summary)?.[1];
  if (!table || !/Start Time\s*\(UTC\)/i.test(text(table)) || !/End Time\s*\(UTC\)/i.test(text(table))) throw new Error('NASA outage table schema is unavailable.');
  const outages: SatelliteOutage[] = [], seen = new Set<string>();
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const columns = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(value => text(value[1]));
    if (!columns.length) continue;
    if (columns.length !== 5) throw new Error('Incomplete NASA outage row.');
    const range = columns[0].replace(/[–—]/g, '-').match(/^(\d{4})-(\d{3})(?:\s*-\s*(\d{4})-(\d{3}))?$/);
    if (!range) throw new Error('Invalid NASA outage date range.');
    const start = dayOfYear(range[1], range[2]) + timeOfDay(columns[2]);
    let end = dayOfYear(range[3] ?? range[1], range[4] ?? range[2]) + timeOfDay(columns[3]);
    if (!range[3] && end <= start && columns[3] === '00:00:00') end += DAY;
    if (end <= start || end - start > 366 * DAY) throw new Error('NASA outage interval is reversed or unbounded.');
    const id = `${start}/${end}`;
    if (!seen.has(id)) { outages.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), description: columns[4].slice(0, 1200) }); seen.add(id); }
    if (outages.length > 2000) throw new Error('NASA outage catalogue has too many intervals.');
  }
  if (!outages.length) throw new Error('NASA outage catalogue contains no recognizable history.');
  outages.sort((a, b) => b.start.localeCompare(a.start));
  return { sourceUpdatedDate, outages };
}

export function outageIntersections(outages: SatelliteOutage[], requiredDates: string[]): SatelliteOutage[] {
  if (requiredDates.length < 1 || requiredDates.length > 7 || requiredDates.some(date => !validDay(date))) throw new RangeError('Use one to seven valid UTC mask dates.');
  return outages.filter(outage => requiredDates.some(date => {
    const start = Date.parse(`${date}T00:00:00Z`);
    return Date.parse(outage.start) < start + DAY && Date.parse(outage.end) > start;
  }));
}

async function retrieveCatalog(sensor: OutageSensor, fetcher: typeof fetch, now: number): Promise<FetchedCatalog> {
  const fetchedAt = new Date(now).toISOString();
  try {
    const response = await fetcher(SOURCES[sensor].url, { cache: 'no-store', redirect: 'manual', headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok || !response.body) throw new Error(`NASA outage catalogue returned HTTP ${response.status}.`);
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('NASA outage catalogue exceeds the size limit.');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > MAX_BYTES) throw new Error('NASA outage catalogue exceeds the size limit.'); chunks.push(value); } }
    catch (error) { await reader.cancel().catch(() => {}); throw error; }
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const catalog = parseOutageCatalog(new TextDecoder().decode(bytes), sensor);
    if (Date.parse(catalog.sourceUpdatedDate) > Math.floor(now / DAY) * DAY) throw new Error('NASA outage catalogue update date is in the future.');
    return { fetchedAt, catalog };
  } catch (error) { return { fetchedAt, catalog: null, error: error instanceof Error ? error.message : 'NASA outage catalogue unavailable.' }; }
}

/** No listed gap is not evidence of complete local overpass or cloud coverage.
 * Re-read the live catalogue after30min; never substitute a stale success after
 * a failed refresh. The catalogue's editorial date is metadata, not a promise
 * that all later acquisitions were complete, and does not create an endless
 * outage when no new incidents have been added.
 */
export async function checkSnppSourceHealth(requiredDates: string[], options: HealthOptions = {}): Promise<SatelliteSourceHealth> {
  return checkSatelliteSourceHealth('snpp', requiredDates, options);
}
export async function checkSatelliteSourceHealth(sensor: OutageSensor, requiredDates: string[], options: HealthOptions = {}): Promise<SatelliteSourceHealth> {
  outageIntersections([], requiredDates);
  const now = (options.now ?? Date.now)();
  if (!Number.isFinite(now)) throw new RangeError('A valid source-health check time is required.');
  let fetched: FetchedCatalog;
  const hit = cached[sensor], inflight = pending[sensor];
  if (options.fetcher) fetched = await retrieveCatalog(sensor, options.fetcher, now);
  else if (hit && now >= hit.at && now - hit.at < (hit.value.catalog ? SUCCESS_CACHE_MS : FAILURE_CACHE_MS)) fetched = hit.value;
  else if (inflight && now >= inflight.at && now - inflight.at < 15_000) fetched = await inflight.value;
  else {
    const task = retrieveCatalog(sensor, fetch, now); pending[sensor] = { at: now, value: task };
    try { fetched = await task; cached[sensor] = { at: now, value: fetched }; }
    finally { if (pending[sensor]?.value === task) delete pending[sensor]; }
  }
  const overlappingOutages = fetched.catalog ? outageIntersections(fetched.catalog.outages, requiredDates) : [];
  return {
    status: !fetched.catalog ? 'unavailable' : overlappingOutages.length ? 'reported-gap' : 'no-reported-gap',
    sourceUrl: SOURCES[sensor].url, fetchedAt: fetched.fetchedAt, checkedAt: new Date(now).toISOString(),
    sourceUpdatedDate: fetched.catalog?.sourceUpdatedDate ?? null, requiredDates: [...new Set(requiredDates)].sort(), overlappingOutages,
    observationalCoverage: 'unknown', warnings: [
      `NASA lists major known ${SOURCES[sensor].label} outages. Absence of a listed outage does not establish complete local observations, clear skies, or absence of fire.`,
      'The catalogue may be updated after data loss occurs. Its update date is an editorial date, not an acquisition-coverage guarantee.',
      ...(overlappingOutages.length ? ['A required UTC mask day overlaps a reported satellite outage. Its geographic impact is not identified by this catalogue; the outlook abstains rather than treating missing observations as zero.'] : []),
    ], ...(fetched.error ? { error: fetched.error } : {}),
  };
}
