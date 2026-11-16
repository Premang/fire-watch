#!/usr/bin/env python3
"""Line-aware model, trained and tested properly.

  score = v2 trees (unchanged)  ->  line step:  logit(new) = logit(v2 score) + w[position behind a line]

The line step is fitted on 2020 fires (where v2's scores are out-of-sample) using crew-recorded completed
lines, then tested ONCE on the 27 fires of 2021 that neither v2 nor the line step has seen, using the lines
crews recorded on those fires. Weights above zero are set to zero (a line never raises a score).
Fires are weighted equally, as in the v2 protocol.
"""
import sys, json, argparse
from pathlib import Path
from datetime import datetime, timezone
import numpy as np
from scipy.optimize import minimize
from scipy.special import expit, logit
from sklearn.metrics import average_precision_score
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fireline_effect import eligible, export_predict, fetch_lines, distances  # noqa: E402
from fireline_model import design, NAMES  # noqa: E402
from fireline_gdb import fetch_lines_gdb  # noqa: E402
RIDGE = 1.0

def fit(X, y, off, w):
    def loss(t):
        z = off + t[0] + X @ t[1:]; return float(np.sum(w * (np.logaddexp(0, z) - y * z)) + RIDGE * np.sum(t[1:] ** 2) / 2)
    return minimize(loss, np.zeros(1 + X.shape[1]), method='L-BFGS-B').x

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--run', type=Path, required=True); ap.add_argument('--data', type=Path, required=True); ap.add_argument('--out', type=Path, required=True); a = ap.parse_args()
    app = Path(__file__).resolve().parents[2]
    boundaries = json.loads((app / 'public/data/us-states.json').read_text()); model = json.loads((app / 'public/data/ml/model.json').read_text())
    ready = json.loads((a.run / 'data/ready-events.json').read_text())
    gdb = {y: next((a.data / f'nifs-{y}/gdb').glob('*.gdb')) for y in ('2020', '2021')}
    rows = {s: [] for s in ('train', 'selection', 'calibration', 'test')}; info = []
    for e in ready['events']:
        ev = eligible(e, boundaries)
        if 'skipped' in ev: continue
        year = ev['event'][:4]
        feats = fetch_lines(ev, a.data / 'firelines') if year in ('2018', '2019') else fetch_lines_gdb(ev, a.data / f'firelines-{year}', gdb[year])
        cutoff = datetime.fromisoformat(ev['dates'][3]).replace(tzinfo=timezone.utc).timestamp() * 1000
        used = [f for f in feats if (f['line'] or f['created']) is not None and (f['line'] or f['created']) < cutoff]
        segs = [np.stack([np.asarray(p[:-1], float), np.asarray(p[1:], float)], 1) for f in used for p in f['paths'] if len(p) > 1]
        d0, held, _ = distances(ev, np.concatenate(segs) if segs else np.zeros((0, 2, 2)))
        X = design(np.where(np.isfinite(d0), d0, 1e9), held); X[(ev['recent'] == 1) | ~np.isfinite(d0)] = 0
        p = np.clip(export_predict(model, ev['x']), 1e-6, 1 - 1e-6); n = len(p)
        rows[ev['split']].append({'X': X, 'y': ev['y'].astype(float), 'off': logit(p), 'w': np.full(n, 1 / n), 'n': n})
        info.append({'event': ev['event'], 'split': ev['split'], 'linesNearby': len(feats), 'linesInTime': len(used), 'squares': n, 'behindLine': int(X[:, :3].any(1).sum()), 'burned': int(ev['y'].sum()), 'burnedBehindLine': int(ev['y'][X[:, :3].any(1)].sum())})
        print(info[-1], flush=True)
    def stack(groups):
        ev = [r for g in groups for r in rows[g]]; cat = lambda k: np.concatenate([r[k] for r in ev])
        return cat('X'), cat('y'), cat('off'), cat('w'), np.concatenate([np.full(r['n'], i) for i, r in enumerate(ev)]), len(ev)
    def weights(groups):
        X, y, off, w, g, n = stack(groups); keep = np.isin(g, np.unique(g[X.any(1)]))  # fires where a line stands between fire and squares
        t = fit(X[keep], y[keep], off[keep], w[keep] * keep.sum() / w[keep].sum())
        return np.minimum(0, t[1:]), t[1:], int(len(np.unique(g[keep]))), int(X[keep][:, :3].any(1).sum()), int(y[keep][X[keep][:, :3].any(1)].sum())
    primary, raw, fires, behind, burned = weights(['selection', 'calibration'])
    alt, alt_raw, alt_fires, _, _ = weights(['train', 'selection', 'calibration'])
    X, y, off, w, g, n_events = stack(['test']); w = w * len(w) / w.sum()
    def metrics(z, m=None, ww=None):
        ww = w if ww is None else ww; m = np.ones(len(y), bool) if m is None else m; p = expit(z[m]); yy = y[m]; wm = ww[m]
        return {'brier': float(np.sum(wm * (p - yy) ** 2) / wm.sum()), 'logLoss': float(np.sum(wm * (np.logaddexp(0, z[m]) - yy * z[m])) / wm.sum()), 'prAuc': float(average_precision_score(yy, p, sample_weight=wm)) if yy.sum() else None}
    z0 = off; z1 = off + X @ primary; z2 = off + X @ alt; behind_mask = X[:, :3].any(1)
    rng = np.random.default_rng(20261114); deltas = []
    for _ in range(2000):
        pick = rng.choice(n_events, n_events); c = np.bincount(pick, minlength=n_events)[g].astype(float); ww = w * c
        if not (y * c).sum(): continue
        m0, m1 = metrics(z0, ww=ww), metrics(z1, ww=ww); deltas.append((m1['brier'] - m0['brier'], m1['logLoss'] - m0['logLoss'], m1['prAuc'] - m0['prAuc']))
    D = np.array(deltas); ci = lambda k: [float(np.percentile(D[:, k], 2.5)), float(np.percentile(D[:, k], 97.5))]
    test_fires_with = int(len(np.unique(g[behind_mask])))
    report = {'lineStep': {'fittedOn': '2020 fires (selection + calibration splits)', 'fires': fires, 'squaresBehindLine': behind, 'burnedBehindLine': burned, 'rawWeights': dict(zip(NAMES, map(float, raw))), 'weightsUsed': dict(zip(NAMES, map(float, primary)))},
              'alternative': {'fittedOn': '2018-2020 fires', 'fires': alt_fires, 'rawWeights': dict(zip(NAMES, map(float, alt_raw))), 'weightsUsed': dict(zip(NAMES, map(float, alt))), 'test': metrics(z2)},
              'test2021': {'fires': n_events, 'firesWithSquaresBehindALine': test_fires_with, 'squares': int(len(y)), 'squaresBehindLine': int(behind_mask.sum()), 'burnedBehindLine': int(y[behind_mask].sum()),
                           'v2': metrics(z0), 'v2PlusLineStep': metrics(z1), 'difference95': {'brier': ci(0), 'logLoss': ci(1), 'prAuc': ci(2)},
                           'behindLineOnly': {'v2': metrics(z0, behind_mask), 'v2PlusLineStep': metrics(z1, behind_mask), 'observedRate': float(np.sum(w[behind_mask] * y[behind_mask]) / w[behind_mask].sum()) if behind_mask.any() else None}},
              'events': info}
    a.out.write_text(json.dumps(report, indent=2)); print(json.dumps({k: v for k, v in report.items() if k != 'events'}, indent=2))
if __name__ == '__main__': main()
