import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
// @ts-expect-error Explicit source extension supports the direct Node test runner.
import { checkSatelliteSourceHealth, checkSnppSourceHealth, NOAA20_OUTAGE_URL, outageIntersections, parseOutageCatalog, parseSnppOutageCatalog, SNPP_OUTAGE_URL } from '../lib/satellite-source-health.ts';

const now = Date.parse('2026-10-25T07:00:00Z');
function row(yearDay: string, start: string, end: string, description = 'Missing granules &amp; no science data') {
  return `<tr><td>${yearDay}</td><td>Human-readable date</td><td>${start}</td><td>${end}</td><td>${description}</td></tr>`;
}
function catalogue(rows = row('2026-295', '00:12:00', '02:06:00'), updated = 'October 24, 2026') {
  return `<html><p>Last Update: ${updated}</p><table border="1" summary="VIIRS/Suomi-NPP Data Outages Since Start of Suomi-NPP Mission"><tr><th>Year-Day</th><th>Date</th><th>Start Time (UTC)</th><th>End Time (UTC)</th><th>Comments</th></tr>${rows}</table></html>`;
}
function source(body = catalogue(), status = 200): typeof fetch {
  return async (url, options) => {
    assert.equal(String(url), SNPP_OUTAGE_URL);
    assert.equal(options?.redirect, 'manual');
    assert.equal(options?.cache, 'no-store');
    return new Response(body, { status });
  };
}

test('NASA structured UTC intervals preserve a partial day and cross-midnight or cross-year gaps', () => {
  const parsed = parseSnppOutageCatalog(catalogue([
    row('2026-295', '00:12:00', '02:06:00'),
    row('2026-285 - 2026-286', '22:00:00', '11:48:00'),
    row('2025-365 - 2026-001', '23:50:00', '00:06:00'),
    row('2025-186', '08:00:00', '00:00:00'),
  ].join('')));
  assert.equal(parsed.sourceUpdatedDate, '2026-10-24');
  assert.deepEqual(parsed.outages[0], { start: '2026-10-22T00:12:00.000Z', end: '2026-10-22T02:06:00.000Z', description: 'Missing granules & no science data' });
  assert.equal(parsed.outages[1].start, '2026-10-12T22:00:00.000Z');
  assert.equal(parsed.outages[1].end, '2026-10-13T11:48:00.000Z');
  assert.equal(parsed.outages[2].end, '2026-01-01T00:06:00.000Z');
  assert.equal(parsed.outages[3].end, '2025-07-06T00:00:00.000Z');
});

test('outage intersections use half-open UTC days and do not extend an ended gap forever', () => {
  const catalog = parseSnppOutageCatalog(catalogue(row('2026-285 - 2026-286', '22:00:00', '00:00:00')));
  assert.equal(outageIntersections(catalog.outages, ['2026-10-12']).length, 1);
  assert.equal(outageIntersections(catalog.outages, ['2026-10-13']).length, 0);
  assert.equal(outageIntersections(catalog.outages, ['2026-10-24', '2026-10-23']).length, 0);
  assert.throws(() => outageIntersections([], ['2026-02-30']), /valid UTC/);
  assert.throws(() => outageIntersections([], []), /valid UTC/);
});

test('parser rejects malformed or incomplete reports instead of silently deleting an outage', () => {
  for (const html of [
    '<html>Maintenance</html>', catalogue(''), catalogue(row('2025-366', '00:00:00', '02:00:00')),
    catalogue(row('2026-295', '25:00:00', '02:00:00')),
    catalogue(row('2026-295', '08:00:00', '07:00:00')),
    catalogue(row('2026-295', '00:00:00', '02:00:00'), 'February 30, 2026'),
    catalogue('<tr><td>2026-295</td><td>Incomplete</td></tr>'),
    catalogue(row('2026-295', '00:00:00', '02:00:00')).replace('Start Time (UTC)', 'Local time'),
  ]) assert.throws(() => parseSnppOutageCatalog(html), /NASA/);
});

test('duplicate rows do not duplicate a gap; comment markup is retained only as plain text', () => {
  const item = row('2026-295', '00:12:00', '02:06:00', '<b>Missing</b> &amp; unavailable');
  const parsed = parseSnppOutageCatalog(catalogue(item + item));
  assert.equal(parsed.outages.length, 1);
  assert.equal(parsed.outages[0].description, 'Missing & unavailable');
});

test('known gaps produce explicit unknown-AOI health rather than a clean observation claim', async () => {
  const result = await checkSnppSourceHealth(['2026-10-22', '2026-10-23'], { fetcher: source(), now: () => now });
  assert.equal(result.status, 'reported-gap');
  assert.equal(result.sourceUpdatedDate, '2026-10-24');
  assert.equal(result.overlappingOutages.length, 1);
  assert.equal(result.observationalCoverage, 'unknown');
  assert.ok(result.warnings.some(warning => warning.includes('geographic impact')));
});

test('no reported gap retains unknown coverage and an old editorial date does not invent a continuing outage', async () => {
  const result = await checkSnppSourceHealth(['2026-10-23', '2026-10-24'], { fetcher: source(catalogue(undefined, 'October 22, 2026')), now: () => now });
  assert.equal(result.status, 'no-reported-gap');
  assert.equal(result.observationalCoverage, 'unknown');
  assert.deepEqual(result.overlappingOutages, []);
  assert.ok(result.warnings.some(warning => warning.includes('does not establish complete')));
});

test('HTTP failure, oversized content and changed schema are unavailable health checks', async () => {
  const scenarios = [source('Unavailable', 503), source('<html>Maintenance</html>'), source('x'.repeat(256001)), source(catalogue(undefined, 'October 26, 2026')), source(catalogue(undefined, 'November 2, 2026'))];
  for (const fetcher of scenarios) {
    const result = await checkSnppSourceHealth(['2026-10-23', '2026-10-24'], { fetcher, now: () => now });
    assert.equal(result.status, 'unavailable');
    assert.ok(result.error);
    assert.equal(result.sourceUpdatedDate, null);
    assert.equal(result.observationalCoverage, 'unknown');
  }
});

test('edge-compatible manual redirects fail closed without following the destination', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), SNPP_OUTAGE_URL);
    assert.equal(options?.redirect, 'manual');
    return new Response(catalogue(), { status: 302, headers: { Location: 'https://example.com/not-nasa' } });
  };
  const result = await checkSnppSourceHealth(['2026-10-23', '2026-10-24'], { fetcher, now: () => now });
  assert.equal(calls, 1);
  assert.equal(result.status, 'unavailable');
  assert.match(result.error ?? '', /HTTP 302/);
  assert.equal(result.sourceUpdatedDate, null);
  assert.deepEqual(result.overlappingOutages, []);
});

test('successful fetches are coalesced/cached; a failed refresh cannot reuse a stale healthy result', async t => {
  let calls = 0, fail = false, clock = now;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(fail ? 'Unavailable' : catalogue(), { status: fail ? 503 : 200 }); });
  const options = { now: () => clock };
  const required = ['2026-10-23', '2026-10-24'];
  const initial = await Promise.all([checkSnppSourceHealth(required, options), checkSnppSourceHealth(required, options)]);
  assert.equal(calls, 1); assert.ok(initial.every(result => result.status === 'no-reported-gap'));
  clock += 29 * 60_000;
  const cached = await checkSnppSourceHealth(required, options);
  assert.equal(calls, 1); assert.equal(cached.fetchedAt, new Date(now).toISOString());
  assert.equal(cached.checkedAt, new Date(clock).toISOString());
  clock += 2 * 60_000; fail = true;
  assert.equal((await checkSnppSourceHealth(required, options)).status, 'unavailable');
  assert.equal(calls, 2);
  clock += 30_000;
  assert.equal((await checkSnppSourceHealth(required, options)).status, 'unavailable');
  assert.equal(calls, 2);
  clock += 31_000; fail = false;
  assert.equal((await checkSnppSourceHealth(required, options)).status, 'no-reported-gap');
  assert.equal(calls, 3);
});

test('the real NOAA-20 outage page parses with the shared five-column schema', () => {
  const html = readFileSync(new URL('./fixtures/noaa20-outages.html', import.meta.url), 'utf8');
  const parsed = parseOutageCatalog(html, 'noaa20');
  assert.equal(parsed.sourceUpdatedDate, '2026-11-03');
  assert.ok(parsed.outages.length > 5);
  assert.ok(parsed.outages.every(o => Date.parse(o.end) > Date.parse(o.start)));
  assert.equal(parsed.outages[0].start, '2026-05-13T17:06:00.000Z');
  // Platform tables are not interchangeable: the S-NPP parser must not accept the NOAA-20 page.
  assert.throws(() => parseSnppOutageCatalog(html), /schema is unavailable/);
  assert.throws(() => parseOutageCatalog(catalogue(), 'noaa20'), /schema is unavailable/);
});
test('NOAA-20 health reads only the NOAA-20 catalogue and labels its warnings', async () => {
  const html = readFileSync(new URL('./fixtures/noaa20-outages.html', import.meta.url), 'utf8');
  const health = await checkSatelliteSourceHealth('noaa20', ['2026-05-13'], { now: () => Date.parse('2026-11-04T07:00:00Z'), fetcher: async url => {
    assert.equal(String(url), NOAA20_OUTAGE_URL); return new Response(html);
  } });
  assert.equal(health.sourceUrl, NOAA20_OUTAGE_URL); assert.equal(health.status, 'reported-gap');
  assert.ok(health.warnings[0].includes('NOAA-20 outages'));
});
