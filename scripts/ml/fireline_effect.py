#!/usr/bin/env python3
"""Measure, on the 2018-2019 training fires, how often squares behind a recorded, completed fire
line burned the next day, compared with what the model expected.

Fire lines: NIFC "Operational Data Archive" 2018 and 2019 (public feature services, Event Line layer).
Only lines marked completed and dated before the end of the issue day are used.
The "behind a line" rule is the same one the website uses (lib/fireline-whatif.ts).

Caveats, also written to the output: the model's scores are in-sample for these fires; crews build
lines where fire is expected, so this is an observed association, not a controlled experiment.
Nothing here changes the frozen model.
"""
import sys, types, json, math, heapq, urllib.request, urllib.parse, argparse
from pathlib import Path
from datetime import datetime, timezone, timedelta
import numpy as np

# Minimal stand-in for pyproj (not installed here): inverse UTM on WGS84, northern hemisphere only.
class _T:
    def __init__(self, epsg):
        assert 32601 <= int(epsg) <= 32660, f'Only northern UTM zones are supported, got {epsg}'
        self.lon0 = math.radians((int(epsg) - 32600) * 6 - 183)
    def transform(self, x, y):
        a, f, k0 = 6378137.0, 1 / 298.257223563, 0.9996
        e2 = f * (2 - f); ep2 = e2 / (1 - e2); e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
        x = np.asarray(x, float) - 500000.0; y = np.asarray(y, float)
        mu = (y / k0) / (a * (1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256))
        p1 = mu + (3 * e1 / 2 - 27 * e1**3 / 32) * np.sin(2 * mu) + (21 * e1**2 / 16 - 55 * e1**4 / 32) * np.sin(4 * mu) + (151 * e1**3 / 96) * np.sin(6 * mu) + (1097 * e1**4 / 512) * np.sin(8 * mu)
        s, c, t = np.sin(p1), np.cos(p1), np.tan(p1)
        C1 = ep2 * c**2; T1 = t**2; N1 = a / np.sqrt(1 - e2 * s**2); R1 = a * (1 - e2) / (1 - e2 * s**2)**1.5; D = x / (N1 * k0)
        lat = p1 - (N1 * t / R1) * (D**2 / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1**2 - 9 * ep2) * D**4 / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1**2 - 252 * ep2 - 3 * C1**2) * D**6 / 720)
        lon = self.lon0 + (D - (1 + 2 * T1 + C1) * D**3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1**2 + 8 * ep2 + 24 * T1**2) * D**5 / 120) / c
        return np.degrees(lon), np.degrees(lat)
class _Transformer:
    @staticmethod
    def from_crs(src, dst, always_xy=True):
        assert int(dst) == 4326 and always_xy
        return _T(src)
try:
    import pyproj  # noqa: F401
except ModuleNotFoundError:
    stub = types.ModuleType('pyproj'); stub.Transformer = _Transformer; sys.modules['pyproj'] = stub

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_v2 import eligible, export_predict  # noqa: E402

BASE = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/'
LAYER = {'2018': 'National_Incident_Feature_Service_2018/FeatureServer/1', '2019': '2019_NIFS_OpenData/FeatureServer/0'}
WHERE = "FeatureCategory LIKE 'Completed%' OR FeatureCategory='Road as Completed Line' OR FeatureCategory='Line Break Completed'"
CELL = 1500.0

def fetch_lines(event, cache, where=WHERE):
    f = cache / (event['event'].replace('/', '_') + '.json')
    if f.exists(): return json.loads(f.read_text())
    cx = event['origin'][0] + (event['col'] + .5) * CELL; cy = event['origin'][1] - (event['row'] + .5) * CELL
    env = f"{cx.min() - 3000},{cy.min() - 3000},{cx.max() + 3000},{cy.max() + 3000}"
    feats, offset = [], 0
    while True:
        q = {'where': where, 'geometry': env, 'geometryType': 'esriGeometryEnvelope', 'inSR': event['epsg'], 'outSR': event['epsg'], 'spatialRel': 'esriSpatialRelIntersects',
             'outFields': 'FeatureCategory,LineDateTime,CreateDate', 'resultOffset': offset, 'resultRecordCount': 2000, 'orderByFields': 'OBJECTID', 'f': 'json'}
        d = json.load(urllib.request.urlopen(BASE + LAYER[event['event'][:4]] + '/query?' + urllib.parse.urlencode(q), timeout=90))
        if 'error' in d: raise RuntimeError(d['error'])
        for ft in d.get('features', []):
            a = ft['attributes']; feats.append({'category': a.get('FeatureCategory'), 'line': a.get('LineDateTime'), 'created': a.get('CreateDate'), 'paths': (ft.get('geometry') or {}).get('paths', [])})
        if not d.get('exceededTransferLimit'): break
        offset += len(d['features'])
    f.write_text(json.dumps(feats, separators=(',', ':')))
    return feats

def crosses(A, B, S):
    """A,B: (n,2) step ends. S: (m,2,2) line pieces. Returns (n,) True where the step crosses any piece."""
    out = np.zeros(len(A), bool)
    if not len(S): return out
    C, D = S[:, 0], S[:, 1]
    def cr(p, q, r): return (q[..., 0] - p[..., 0]) * (r[..., 1] - p[..., 1]) - (q[..., 1] - p[..., 1]) * (r[..., 0] - p[..., 0])
    for s in range(0, len(A), 256):
        a = A[s:s + 256, None, :]; b = B[s:s + 256, None, :]
        d1, d2, d3, d4 = cr(C[None], D[None], a), cr(C[None], D[None], b), cr(a, b, C[None]), cr(a, b, D[None])
        out[s:s + 256] = ((d1 * d2 < 0) & (d3 * d4 < 0)).any(axis=1)
    return out

def distances(event, segments):
    n = len(event['y']); idx = {(int(r), int(c)): i for i, (r, c) in enumerate(zip(event['row'], event['col']))}
    cen = np.stack([event['origin'][0] + (event['col'] + .5) * CELL, event['origin'][1] - (event['row'] + .5) * CELL], 1)
    pairs = [(i, idx[(r + dr, c + dc)], math.hypot(dr, dc)) for (r, c), i in idx.items() for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)) if (r + dr, c + dc) in idx]
    I = np.array([p[0] for p in pairs], int); J = np.array([p[1] for p in pairs], int)
    blocked = crosses(cen[I], cen[J], segments) if len(pairs) else np.zeros(0, bool)
    def run(use):
        adj = [[] for _ in range(n)]
        for k, (i, j, w) in enumerate(pairs):
            if use and blocked[k]: continue
            adj[i].append((j, w)); adj[j].append((i, w))
        dist = np.full(n, np.inf); heap = []
        for s in np.flatnonzero(event['recent']): dist[s] = 0; heap.append((0.0, int(s)))
        heapq.heapify(heap)
        while heap:
            d, u = heapq.heappop(heap)
            if d > dist[u]: continue
            for v, w in adj[u]:
                if d + w < dist[v]: dist[v] = d + w; heapq.heappush(heap, (d + w, v))
        return dist
    return run(False), run(True), int(blocked.sum())

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--run', type=Path, required=True); ap.add_argument('--cache', type=Path, required=True); ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--where', default=WHERE, help='Archive filter; use a separate --cache for a different filter')
    ap.add_argument('--only', default='', help='Comma-separated words; keep only line categories containing one of them')
    a = ap.parse_args(); only = [w for w in a.only.split(',') if w]
    app = Path(__file__).resolve().parents[2]
    boundaries = json.loads((app / 'public/data/us-states.json').read_text()); model = json.loads((app / 'public/data/ml/model.json').read_text())
    ready = json.loads((a.run / 'data/ready-events.json').read_text()); a.cache.mkdir(parents=True, exist_ok=True)
    rows, per_event = [], []
    for e in ready['events']:
        if e['split'] != 'train': continue
        ev = eligible(e, boundaries)
        if 'skipped' in ev: continue
        p = export_predict(model, ev['x'])
        feats = fetch_lines(ev, a.cache, a.where)
        if only: feats = [f for f in feats if any(w in (f['category'] or '') for w in only)]
        cutoff = (datetime.fromisoformat(ev['dates'][3]).replace(tzinfo=timezone.utc)).timestamp() * 1000  # start of the target day
        used = [f for f in feats if (f['line'] or f['created']) is not None and (f['line'] or f['created']) < cutoff]
        segs = [np.stack([np.asarray(path[:-1], float), np.asarray(path[1:], float)], 1) for f in used for path in f['paths'] if len(path) > 1]
        S = np.concatenate(segs) if segs else np.zeros((0, 2, 2))
        open_d, held_d, nblocked = distances(ev, S)
        keep = (ev['recent'] == 0) & np.isfinite(open_d)
        group = np.where(~np.isfinite(held_d), 2, np.where(held_d > open_d + 1e-9, 1, 0))  # 0 clear, 1 detour, 2 cut off
        for i in np.flatnonzero(keep): rows.append((len(per_event), int(group[i]), int(ev['y'][i]), float(p[i]), float(open_d[i])))
        per_event.append({'event': ev['event'], 'linesNearby': len(feats), 'linesDatedInTime': len(used), 'blockedSteps': nblocked, 'cells': int(keep.sum()), 'behindLine': int((keep & (group > 0)).sum()), 'burned': int(ev['y'][keep].sum())})
        print(per_event[-1], flush=True)
    R = np.array(rows); ev_i, g, y, p, d0 = R[:, 0].astype(int), R[:, 1].astype(int), R[:, 2], R[:, 3], R[:, 4]
    def summary(mask):
        n = int(mask.sum()); return {'squares': n, 'burned': int(y[mask].sum()), 'expectedByModel': round(float(p[mask].sum()), 2), 'burnedPerExpected': round(float(y[mask].sum() / p[mask].sum()), 3) if n and p[mask].sum() > 0 else None}
    def factor(mask_shield, mask_clear):
        if not mask_shield.sum() or not p[mask_shield].sum() or not y[mask_clear].sum(): return None
        return float((y[mask_shield].sum() / p[mask_shield].sum()) / (y[mask_clear].sum() / p[mask_clear].sum()))
    with_lines = np.isin(ev_i, [k for k, e in enumerate(per_event) if e['behindLine'] > 0])  # compare within fires that have usable lines
    clear, shield, cut = with_lines & (g == 0), with_lines & (g > 0), with_lines & (g == 2)
    rng = np.random.default_rng(20261114); events = np.unique(ev_i[with_lines]); boot = []
    for _ in range(2000):
        pick = rng.choice(events, len(events)); w = np.zeros(len(per_event)); np.add.at(w, pick, 1); ww = w[ev_i]
        num = (y * ww)[shield].sum() / max(1e-12, (p * ww)[shield].sum()); den = (y * ww)[clear].sum() / max(1e-12, (p * ww)[clear].sum())
        if den > 0: boot.append(num / den)
    bands = {name: {'clear': summary(clear & m), 'behindLine': summary(shield & m), 'factor': factor(shield & m, clear & m)} for name, m in (('1-2 squares from fire', d0 <= 2.5), ('3-5 squares', (d0 > 2.5) & (d0 <= 5.5)), ('6+ squares', d0 > 5.5))}
    report = {'categoryFilter': only or 'all completed lines', 'source': 'NIFC Operational Data Archive 2018 and 2019, Event Line layer, completed line categories dated before the target day', 'firesAnalysed': len(per_event), 'firesWithSquaresBehindALine': int(len(events)),
              'clear': summary(clear), 'behindLine': summary(shield), 'fullyCutOff': summary(cut), 'factor': factor(shield, clear), 'factor95': [float(np.percentile(boot, 2.5)), float(np.percentile(boot, 97.5))] if boot else None,
              'byDistanceFromFire': bands, 'caveats': ['Model scores are in-sample for these fires.', 'Observed association, not a controlled experiment: crews build lines where fire is expected to go.', 'Line dates are when a line was mapped, which can be after it was built.', 'Does not change the frozen model.'], 'events': per_event}
    a.out.write_text(json.dumps(report, indent=2)); print(json.dumps({k: v for k, v in report.items() if k != 'events'}, indent=2))
if __name__ == '__main__': main()
