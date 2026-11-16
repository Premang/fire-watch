#!/usr/bin/env python3
"""Does five days of fire history beat two? (WSTS+ reported a gain from longer history.)

Adds inputs built from three more earlier days (ml-v2/data-history) to the 25 v2 inputs:
where the fire was on each earlier day, how long each square has burned, distance to old burned
ground and to the newest edge, how fast the fire has grown, and whether a square lies in the
direction the fire has been moving.

Step 1 (default): repeated grouped 5x5 cross-validation over the 2018-2020 fires. Never opens 2021.
Step 2 (--test): fit both versions on all 2018-2020 fires, score once on 2021.
"""
import sys, json, argparse
from pathlib import Path
from datetime import date, timedelta
import numpy as np, tifffile
from scipy.ndimage import distance_transform_edt
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fireline_effect import eligible  # noqa: E402  (also installs the pyproj stub)
from train import block  # noqa: E402

NAMES = ['fire_d3', 'fire_d4', 'fire_d5', 'days_burned', 'distance_old_burn_km', 'distance_new_edge_km', 'growth_recent', 'growth_5day', 'active_days', 'along_spread_km', 'spread_speed_km']

def mask(path):
    a = tifffile.imread(path); a = a if a.shape[-1] == 23 else np.moveaxis(a, 0, -1)
    return block(np.isfinite(a[..., 22]).astype(float), 'max').astype(bool)

def history(ev, e, hist):
    first = date.fromisoformat(ev['dates'][0]); h, w = ev['shape']
    paths = [hist / f"{e['event']}/{first - timedelta(days=k)}.tif" for k in (1, 2, 3)]
    if not all(p.exists() for p in paths): return None
    older = [mask(p) for p in paths]  # day-3, day-4, day-5 relative to the newest fire day (day-1)
    if any(m.shape != (h, w) for m in older): return None
    recent = mask(next(Path(f['path']) for f in e['files'] if f['name'].endswith(ev['dates'][1] + '.tif')))
    prior = mask(next(Path(f['path']) for f in e['files'] if f['name'].endswith(ev['dates'][0] + '.tif')))
    days = [recent, prior, *older]; before = prior | older[0] | older[1] | older[2]
    dist = lambda m: np.minimum(distance_transform_edt(~m) * 1.5, 150) if m.any() else np.full((h, w), 150.)
    edge = recent & ~before; counts = np.array([m.sum() for m in days], float)
    rows, cols = np.indices((h, w)); cen = lambda m: np.array([cols[m].mean(), rows[m].mean()]) if m.any() else None
    c1, c0 = cen(recent), cen(before); move = (c1 - c0) * 1.5 if c0 is not None else np.zeros(2); speed = float(np.hypot(*move))
    unit = move / speed if speed > 0 else np.zeros(2)
    # ev['x'][:,6] = km east of nearest recent fire, [:,7] = km north (rows increase southward).
    r, c = ev['row'], ev['col']
    out = np.stack([older[0][r, c], older[1][r, c], older[2][r, c], sum(m.astype(int) for m in days)[r, c], dist(before)[r, c], dist(edge)[r, c],
        np.full(len(r), np.log1p(counts[0]) - np.log1p(counts[1])), np.full(len(r), np.log1p(counts[0]) - np.log1p(counts[2:].mean())), np.full(len(r), float((counts > 0).sum())),
        ev['x'][:, 6] * unit[0] - ev['x'][:, 7] * unit[1], np.full(len(r), speed)], 1).astype(float)
    return out

def fit(x, y, w, P, leaves):
    return HistGradientBoostingClassifier(max_iter=P['maxIter'], max_leaf_nodes=leaves, learning_rate=P['learningRate'], min_samples_leaf=P['minSamplesLeaf'], l2_regularization=P['l2Regularization'], early_stopping=False, random_state=P['randomState']).fit(x, y, sample_weight=w)

def score(y, p, w, m=slice(None)):
    y, p, w = y[m], p[m], w[m]
    return {'prAuc': float(average_precision_score(y, p, sample_weight=w)), 'brier': float(brier_score_loss(y, p, sample_weight=w)), 'logLoss': float(log_loss(y, np.clip(p, 1e-6, 1 - 1e-6), sample_weight=w, labels=[0, 1]))}

def stack(events):
    x = np.concatenate([e['x'] for e in events]); H = np.concatenate([e['hist'] for e in events]); y = np.concatenate([e['y'] for e in events])
    g = np.concatenate([np.full(len(e['y']), i) for i, e in enumerate(events)]); w = np.concatenate([np.full(len(e['y']), 1 / len(e['y'])) for e in events]); w *= len(w) / w.sum()
    return x, np.hstack([x, H]), y, g, w

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--run', type=Path, required=True); ap.add_argument('--out', type=Path, required=True); ap.add_argument('--test', action='store_true'); a = ap.parse_args()
    app = Path(__file__).resolve().parents[2]; boundaries = json.loads((app / 'public/data/us-states.json').read_text())
    P = json.loads((a.run / 'protocol.json').read_text())['candidates']; leaves = json.loads((a.run / 'artifacts/evaluation.json').read_text())['selectedLeaves']
    ready = json.loads((a.run / 'data/ready-events.json').read_text()); dev, test = [], []
    for e in ready['events']:
        if e['split'] == 'test' and not a.test: continue
        ev = eligible(e, boundaries)
        if 'skipped' in ev: continue
        ev['hist'] = history(ev, e, a.run / 'data-history')
        if ev['hist'] is None: continue
        (test if e['split'] == 'test' else dev).append(ev)
    print('fires with five days of history:', len(dev), 'development,', len(test), 'test', flush=True)
    x, xh, y, g, w = stack(dev); new = x[:, 0] == 0; rng = np.random.default_rng(20261114); rows = []; wins = np.zeros(len(dev))
    for rep in range(5):
        order = rng.permutation(len(dev)); fold = np.empty(len(dev), int); fold[order] = np.arange(len(dev)) % 5; p0 = np.zeros(len(y)); p1 = np.zeros(len(y))
        for k in range(5):
            te = fold[g] == k; tr = ~te
            p0[te] = fit(x[tr], y[tr], w[tr], P, leaves).predict_proba(x[te])[:, 1]; p1[te] = fit(xh[tr], y[tr], w[tr], P, leaves).predict_proba(xh[te])[:, 1]
        rows.append({'twoDays': score(y, p0, w), 'fiveDays': score(y, p1, w), 'newGroundOnly': {'twoDays': score(y, p0, w, new), 'fiveDays': score(y, p1, w, new)}}); print(rep, json.dumps(rows[-1]), flush=True)
        for i in range(len(dev)):
            m = g == i; wins[i] += np.mean((y[m] - p1[m]) ** 2) < np.mean((y[m] - p0[m]) ** 2)
    avg = lambda f: round(float(np.mean([f(r) for r in rows])), 5)
    report = {'developmentFires': len(dev), 'squares': int(len(y)), 'burned': int(y.sum()), 'newGroundSquares': int(new.sum()), 'newGroundBurned': int(y[new].sum()), 'addedInputs': NAMES,
        'crossValidation': {'allSquares': {m: {k: avg(lambda r: r[m][k]) for k in ('prAuc', 'brier', 'logLoss')} for m in ('twoDays', 'fiveDays')},
            'newGroundOnly': {m: {k: avg(lambda r: r['newGroundOnly'][m][k]) for k in ('prAuc', 'brier', 'logLoss')} for m in ('twoDays', 'fiveDays')},
            'firesBetterWithFiveDaysInMostRepeats': int((wins >= 3).sum()), 'perRepeat': rows}}
    if a.test:
        tx, txh, ty, tg, tw = stack(test); tn = tx[:, 0] == 0; p0 = fit(x, y, w, P, leaves).predict_proba(tx)[:, 1]; p1 = fit(xh, y, w, P, leaves).predict_proba(txh)[:, 1]
        rb = np.random.default_rng(7); d = {k: [] for k in ('prAuc', 'brier')}
        for _ in range(2000):
            ix = np.concatenate([np.flatnonzero(tg == i) for i in rb.integers(0, len(test), len(test))])
            if not ty[ix].sum(): continue
            a0, a1 = score(ty[ix], p0[ix], tw[ix]), score(ty[ix], p1[ix], tw[ix]); [d[k].append(a1[k] - a0[k]) for k in d]
        report['test2021'] = {'fires': len(test), 'squares': int(len(ty)), 'burned': int(ty.sum()), 'twoDays': score(ty, p0, tw), 'fiveDays': score(ty, p1, tw),
            'newGroundOnly': {'squares': int(tn.sum()), 'burned': int(ty[tn].sum()), 'twoDays': score(ty, p0, tw, tn), 'fiveDays': score(ty, p1, tw, tn)},
            'difference95': {k: np.quantile(v, [.025, .975]).tolist() for k, v in d.items()}}
    a.out.write_text(json.dumps(report, indent=2)); report['crossValidation'].pop('perRepeat'); print(json.dumps(report, indent=2))
if __name__ == '__main__': main()
