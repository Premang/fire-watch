// Non-public NOAA-20 trial ("shadow") run, frozen by ml-n20/shadow/protocol.json. Never deploys or serves users.
//   node --experimental-strip-types scripts/shadow/run-daily.mts            (scheduled attempt)
//   node --experimental-strip-types scripts/shadow/run-daily.mts --dry-run  (any time; not counted; changes no trial state)
// Every invocation: lock -> integrity -> archived feed snapshot -> label matured runs -> (maybe) one counted run -> status.
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import type {FireOutlook} from '../../lib/fire-outlook-types';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const trial = resolve(app, '../ml-n20/shadow');
const hooks = registerHooks({
  resolve(specifier, context, next) {
    let path: string | undefined;
    if (specifier.startsWith('@/')) path = join(app, specifier.slice(2));
    else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) path = fileURLToPath(new URL(specifier, context.parentURL));
    if (path && !existsSync(path) && existsSync(`${path}.ts`)) path += '.ts';
    return next(path ? pathToFileURL(path).href : specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.json')) return {format: 'module', source: `export default ${readFileSync(fileURLToPath(url), 'utf8')}`, shortCircuit: true};
    return next(url, context);
  },
});
const {createFireOutlook} = await import(join(app, 'lib/fire-outlook.ts'));
const {stateForPoint} = await import(join(app, 'lib/geography.ts'));
const {checkSatelliteSourceHealth} = await import(join(app, 'lib/satellite-source-health.ts'));
const lib = await import(join(app, 'scripts/shadow/shadow-lib.ts'));
hooks.deregister();

const dry = process.argv.includes('--dry-run');
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
function writeJson(p: string, v: unknown) { mkdirSync(dirname(p), {recursive: true}); const tmp = `${p}.tmp-${process.pid}`; writeFileSync(tmp, JSON.stringify(v, null, 1)); renameSync(tmp, p); }
const now = new Date(), stamp = now.toISOString().replace(/[:.]/g, '-'), today = now.toISOString().slice(0, 10), hour = now.getUTCHours();
const day = (d: string, k: number) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// --- protocol, runtime pin, lock --------------------------------------------------------------
const protocolPath = existsSync(join(trial, 'protocol.json')) ? join(trial, 'protocol.json') : dry ? join(trial, 'protocol.draft.json') : null;
if (!protocolPath) { console.error('No frozen trial protocol (run freeze_shadow.py first)'); process.exit(5); }
const protocol = readJson(protocolPath), protocolSha = sha(readFileSync(protocolPath));
if (protocol.draft && !dry) { console.error('A draft protocol cannot drive counted runs'); process.exit(5); }
if (!dry && process.version !== protocol.runtime.nodeVersion) { console.error(`Node ${process.version} differs from frozen ${protocol.runtime.nodeVersion}`); process.exit(7); }
const lock = join(trial, dry ? '.lock-dry' : '.lock');
mkdirSync(trial, {recursive: true});
try { mkdirSync(lock); } catch {
  if (Date.now() - statSync(lock).mtimeMs < 2 * 3600000) { console.error('Another trial invocation holds the lock'); process.exit(6); }
  rmSync(lock, {recursive: true, force: true}); mkdirSync(lock);
}
process.on('exit', () => rmSync(lock, {recursive: true, force: true}));

const statusPath = join(trial, 'STATUS.json');
type Status = {state: 'running' | 'halted'; pauses: {at: string; kind: 'halt' | 'review'; reason: string}[]; reviews: {at: string; resolves: string; by: string; note: string}[]};
const status: Status = existsSync(statusPath) ? readJson(statusPath) : {state: 'running', pauses: [], reviews: []};
function halt(reason: string) { if (dry) return; status.state = 'halted'; if (status.pauses.some(p => p.kind === 'halt' && p.reason === reason)) { writeJson(statusPath, status); return; } status.pauses.push({at: now.toISOString(), kind: 'halt', reason}); writeJson(statusPath, status); }
function review(reason: string) { if (dry || status.pauses.some(p => p.kind === 'review' && p.reason === reason)) return; status.pauses.push({at: now.toISOString(), kind: 'review', reason}); writeJson(statusPath, status); }

// --- integrity -------------------------------------------------------------------------------
const changed = Object.entries(protocol.frozenFiles as Record<string, string>).filter(([rel, h]) => !existsSync(resolve(trial, rel)) || sha(readFileSync(resolve(trial, rel))) !== h).map(([rel]) => rel);
// A changed file halts counted runs. Labeling of existing runs continues only if every file on the
// frozen label path is intact (protocol.labelPathFiles); otherwise nothing runs until restored.
const labelPathBroken = changed.filter(rel => (protocol.labelPathFiles as string[]).includes(rel));
if (changed.length && !dry) { halt(`frozen files changed: ${changed.join(', ')}`); console.error('HALTED: frozen files changed', changed); if (labelPathBroken.length) process.exit(2); }

// --- tee: archive FIRMS/outage bodies, log every request including failures ------------------
const snapshot = join(trial, dry ? 'dry-runs' : 'snapshots', stamp);
const original = globalThis.fetch;
type Req = {url: string; at: string; status?: number; sha256?: string; error?: string};
let requests: Req[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input), entry: Req = {url, at: new Date().toISOString()};
  requests.push(entry);
  try {
    const res = await original(input, init); entry.status = res.status;
    if (/firms\.modaps|modaps\.modaps/.test(url)) { const body = await res.clone().text(), h = sha(body); entry.sha256 = h; const p = join(snapshot, 'inputs', `${h}.txt`); if (!existsSync(p)) { mkdirSync(dirname(p), {recursive: true}); writeFileSync(p, body); } }
    return res;
  } catch (e) { entry.error = e instanceof Error ? e.message : String(e); throw e; }
}) as typeof fetch;

// --- feed snapshot (retried) -----------------------------------------------------------------
let feedText = '', feedError = '';
for (let i = 0; i < 3 && !feedText; i++) {
  try { const r = await fetch(lib.NOAA20_FEED, {signal: AbortSignal.timeout(30000)}); if (!r.ok) throw new Error(`HTTP ${r.status}`); feedText = await r.text(); }
  catch (e) { feedError = e instanceof Error ? e.message : String(e); if (i < 2) await sleep(20000); }
}
let feed: ReturnType<typeof lib.parseNoaa20> | null = null;
if (feedText) { try { feed = lib.parseNoaa20(feedText); } catch (e) { halt(`NOAA-20 feed contract failure: ${e instanceof Error ? e.message : e}`); } }
const feedSha = feedText ? sha(feedText) : null;
writeJson(join(snapshot, 'snapshot.json'), {at: now.toISOString(), protocolSha256: protocolSha, feedSha256: feedSha, feedError: feedText ? null : feedError, requests});

// --- label matured runs (every invocation, independent of the counted run) --------------------
const labeled: string[] = [], labelNotes: string[] = [];
const archive = join(trial, 'archive');
if (!dry && feed && existsSync(archive)) for (const d of readdirSync(archive).sort()) {
  const runPath = join(archive, d, 'run.json'), labelPath = join(archive, d, 'labels.json');
  if (!existsSync(runPath) || existsSync(labelPath)) continue;
  const run = readJson(runPath), target = day(run.issueDate, 1);
  const state = lib.labelState(target, today, !!feed.days[target]);
  if (state === 'pending') continue;
  if (state === 'retry') { labelNotes.push(`${d}: target ${target} absent from feed; retry`); continue; }
  if (state === 'expired') { writeJson(labelPath, {labeledAt: now.toISOString(), targetDate: target, status: 'expired', feedSha256: feedSha, windows: []}); labeled.push(`${d}:expired`); continue; }
  const health = await checkSatelliteSourceHealth('noaa20', [target]).catch(() => null);
  if (!health || health.status === 'unavailable') { labelNotes.push(`${d}: outage catalogue unavailable; retry`); continue; }
  if (health.status === 'reported-gap') { writeJson(labelPath, {labeledAt: now.toISOString(), targetDate: target, status: 'outage', overlappingOutages: health.overlappingOutages, feedSha256: feedSha, windows: []}); labeled.push(`${d}:outage`); continue; }
  const windows = run.windows.filter((w: {outlook?: FireOutlook}) => w.outlook?.status === 'experimental')
    .map((w: {centre: unknown; outlook: FireOutlook}) => ({centre: w.centre, ...lib.labelWindow(feed!, w.outlook)}));
  writeJson(labelPath, {labeledAt: now.toISOString(), targetDate: target, status: 'labeled', feedSha256: feedSha, outageCheck: health.status, windows}); labeled.push(d);
}

// --- reconstruct halts from archived records (crash-safe) -------------------------------------
if (!dry) {
  const recs: {name: string; violations?: unknown}[] = [];
  if (existsSync(archive)) for (const d of readdirSync(archive)) { const p = join(archive, d, 'run.json'); if (existsSync(p)) recs.push({name: `archive/${d}/run.json`, violations: readJson(p).violations}); }
  const att = join(trial, 'attempts');
  if (existsSync(att)) for (const d of readdirSync(att)) for (const f of readdirSync(join(att, d)).filter(x => x.endsWith('.json'))) recs.push({name: `attempts/${d}/${f}`, violations: readJson(join(att, d, f)).violations});
  for (const reason of lib.haltsFromRecords(recs)) halt(reason);
}

// --- one counted run per issue day -----------------------------------------------------------
const issueDate = today, dayDir = join(archive, issueDate), attemptsDir = join(trial, 'attempts', issueDate);
const attempts = existsSync(attemptsDir) ? readdirSync(attemptsDir).filter(f => f.endsWith('.json')).length : 0;
let summary: Record<string, unknown> = {};
const skip = (why: string) => { summary = {counted: false, skipped: why}; };
if (!dry && status.state === 'halted') skip('trial halted');
else if (!dry && (hour < protocol.schedule.windowStartUtcHour || hour >= protocol.schedule.windowEndUtcHour)) skip('outside the issue window');
else if (!dry && existsSync(join(dayDir, 'run.json'))) skip('already counted for this issue day');
else if (!dry && attempts >= protocol.schedule.maxAttempts) skip('attempt limit reached');
else if (!feed) { skip('NOAA-20 feed unavailable or invalid'); if (!dry && hour >= protocol.schedule.finalAttemptUtcHour) writeJson(join(dayDir, 'run.json'), {protocolSha256: protocolSha, ranAt: now.toISOString(), issueDate, fatal: `feed: ${feedError || 'contract failure'}`, windows: [], cohort: []}); }
else {
  requests = [];
  const inConus = (lon: number, lat: number) => { const s = stateForPoint(lon, lat); return !!s && s !== 'AK' && s !== 'HI'; };
  const cohort = lib.selectCohort(feed.kept, day(issueDate, -1), inConus);
  type Win = {centre: {lat: number; lon: number; detections: number}; outlook?: FireOutlook; violations?: string[]; error?: string};
  const windows: Win[] = [];
  const GRIDMET_DAILY = ['pr', 'tmmn', 'tmmx', 'sph', 'vs', 'th', 'erc'] as const; // same list as lib.GRIDMET_DAILY
  let probe: FireOutlook | null = null, deferred = false;
  for (const c of cohort) {
    const start = requests.length; let out: FireOutlook | null = null, error = '';
    for (let i = 0; i < 2 && !out; i++) { try { out = await createFireOutlook(c.lat, c.lon, {includeFeatures: true}); } catch (e) { error = e instanceof Error ? e.message : String(e); if (i === 0) await sleep(15000); } }
    if (!out) { windows.push({centre: c, error}); continue; }
    windows.push({centre: c, outlook: out, violations: lib.invariants(out, issueDate, protocol.model.id, requests.slice(start).map(r => r.url))});
    // Readiness is judged on the first window that actually retrieved every daily gridMET grid; a failed
    // retrieval is not evidence of publication lag and never defers.
    const readiness = lib.gridmetReadiness(out);
    if (!probe && readiness !== 'unretrieved') {
      probe = out;
      if (!dry && readiness === 'stale' && hour < protocol.schedule.finalAttemptUtcHour && attempts + 1 < protocol.schedule.maxAttempts) { deferred = true; break; }
    }
  }
  const violations = windows.flatMap(w => (w.violations ?? []).map(v => `${w.centre.lat},${w.centre.lon}: ${v}`));
  if (deferred) {
    const attemptName = `attempts/${issueDate}/${stamp}.json`;
    if (violations.length) for (const reason of lib.haltsFromRecords([{name: attemptName, violations}])) halt(reason);
    writeJson(join(attemptsDir, `${stamp}.json`), {ranAt: now.toISOString(), counted: false, attempt: attempts + 1, reason: 'gridMET does not yet cover the required lagged day',
      weatherDate: probe!.weatherDate, gridmetDates: Object.fromEntries(GRIDMET_DAILY.map(code => [code, probe!.inputs?.gridmet.grids[code]?.date ?? null])), windows, violations, requests});
    summary = {counted: false, deferred: true, attempt: attempts + 1, violations};
  } else {
    const eligible = windows.flatMap(w => w.outlook?.status === 'experimental' ? [w.outlook] : []);
    const record = {protocolSha256: protocolSha, protocolDraft: !!protocol.draft, dryRun: dry, ranAt: now.toISOString(), nodeVersion: process.version, attempt: attempts + 1,
      issueDate, recentDate: day(issueDate, -1), feedSha256: feedSha, snapshot: snapshot.slice(trial.length + 1), cohort, windows, violations,
      fatal: cohort.length && windows.every(w => w.error) ? 'every window failed' : null, newCellAlertFraction: lib.newCellAlertFraction(eligible), requests};
    if (violations.length) for (const reason of lib.haltsFromRecords([{name: `archive/${issueDate}/run.json`, violations}])) halt(reason);
    writeJson(dry ? join(snapshot, 'run.json') : join(dayDir, 'run.json'), record);
    summary = {counted: !dry, cohort: cohort.length, eligible: eligible.length, abstained: windows.length - eligible.length,
      reasons: [...new Set(windows.flatMap(w => w.outlook?.reasons ?? (w.error ? [w.error] : [])))].slice(0, 8), newCellAlertFraction: record.newCellAlertFraction, violations};
  }
}

// --- review trigger, derived from the archive (crash-safe) ------------------------------------
if (!dry && existsSync(archive)) {
  const fr = readdirSync(archive).sort().flatMap(d => { const p = join(archive, d, 'run.json'); if (!existsSync(p)) return []; const r = readJson(p); return r.newCellAlertFraction === null || r.newCellAlertFraction === undefined ? [] : [{d, f: r.newCellAlertFraction as number}]; });
  for (const dates of lib.reviewTriggers(fr.map(x => ({date: x.d, fraction: x.f})))) review(`new-cell alert fraction above ${lib.NEW_CELL_ALERT.maxFraction} on ${dates.join(', ')}`);
  writeJson(statusPath, status);
}
globalThis.fetch = original;
console.log(JSON.stringify({at: now.toISOString(), dryRun: dry, issueDate, ...summary, labeled, labelNotes, state: dry ? 'dry-run (no trial state changed)' : status.state}, null, 1));
