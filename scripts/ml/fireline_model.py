#!/usr/bin/env python3
"""Fit the line-aware step: a small model that takes the frozen model's score for a square plus where
the square sits relative to completed fire lines, and returns a new score.

    logit(new score) = logit(model score) + w[position]

position is one of: behind a line and 1-2 squares from the fire ("near"), 3-5 squares ("mid"),
6+ squares ("far"), plus an extra term when the square is fully cut off. Squares in the clear get no
term, so with no lines the frozen model's scores are returned unchanged.

Trained on the 2018-2019 training fires with real completed lines (NIFC Operational Data Archive),
with a ridge penalty because the sample is small. Checked by leaving each fire out in turn.
Writes lib/fireline-model.ts for the website. Does not touch the frozen model.
"""
import sys, json, argparse
from pathlib import Path
from datetime import datetime, timezone
import numpy as np
from scipy.optimize import minimize
from scipy.special import expit, logit
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fireline_effect import eligible, export_predict, fetch_lines, distances  # noqa: E402

NAMES = ['near', 'mid', 'far', 'cutOff']; RIDGE = 1.0

def design(d0, held):
    behind = (held > d0 + 1e-9); cut = ~np.isfinite(held)
    return np.stack([behind & (d0 <= 2.5), behind & (d0 > 2.5) & (d0 <= 5.5), behind & (d0 > 5.5), cut], 1).astype(float)

def fit(X, y, off):
    # Intercept is a nuisance term for these fires only (scores are in-sample); it is not exported.
    def loss(t):
        z = off + t[0] + X @ t[1:]; return float(np.sum(np.logaddexp(0, z) - y * z) + RIDGE * np.sum(t[1:] ** 2) / 2)
    return minimize(loss, np.zeros(1 + X.shape[1]), method='L-BFGS-B').x

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--run', type=Path, required=True); ap.add_argument('--cache', type=Path, required=True); ap.add_argument('--out', type=Path, required=True); a = ap.parse_args()
    app = Path(__file__).resolve().parents[2]
    boundaries = json.loads((app / 'public/data/us-states.json').read_text()); model = json.loads((app / 'public/data/ml/model.json').read_text())
    ready = json.loads((a.run / 'data/ready-events.json').read_text())
    Xs, ys, offs, groups = [], [], [], []
    for e in ready['events']:
        if e['split'] != 'train': continue
        ev = eligible(e, boundaries)
        if 'skipped' in ev: continue
        feats = fetch_lines(ev, a.cache)
        cutoff = datetime.fromisoformat(ev['dates'][3]).replace(tzinfo=timezone.utc).timestamp() * 1000
        used = [f for f in feats if (f['line'] or f['created']) is not None and (f['line'] or f['created']) < cutoff]
        segs = [np.stack([np.asarray(p[:-1], float), np.asarray(p[1:], float)], 1) for f in used for p in f['paths'] if len(p) > 1]
        d0, held, _ = distances(ev, np.concatenate(segs) if segs else np.zeros((0, 2, 2)))
        keep = (ev['recent'] == 0) & np.isfinite(d0); X = design(d0[keep], held[keep])
        if not X.any(): continue  # only fires where a line actually stands between fire and squares
        p = np.clip(export_predict(model, ev['x'])[keep], 1e-6, 1 - 1e-6)
        Xs.append(X); ys.append(ev['y'][keep].astype(float)); offs.append(logit(p)); groups.append(np.full(keep.sum(), len(Xs) - 1))
        print(ev['event'], int(keep.sum()), X.sum(0).astype(int).tolist(), flush=True)
    X, y, off, g = np.concatenate(Xs), np.concatenate(ys), np.concatenate(offs), np.concatenate(groups)
    theta = fit(X, y, off)
    # Leave one fire out: does the step predict a held-out fire better than the unadjusted scores?
    base_ll = adj_ll = base_br = adj_br = 0.0; wins = 0
    for k in np.unique(g):
        tr, te = g != k, g == k; t = fit(X[tr], y[tr], off[tr])
        zb = off[te] + t[0]; za = zb + X[te] @ t[1:]
        lb = np.sum(np.logaddexp(0, zb) - y[te] * zb); la = np.sum(np.logaddexp(0, za) - y[te] * za)
        base_ll += lb; adj_ll += la; base_br += np.sum((expit(zb) - y[te]) ** 2); adj_br += np.sum((expit(za) - y[te]) ** 2); wins += la < lb
    n = len(y); behind = X[:, :3].any(1)
    report = {'weights': {k: round(float(v), 3) for k, v in zip(NAMES, theta[1:])}, 'multiplierOnOdds': {k: round(float(np.exp(v)), 2) for k, v in zip(NAMES, theta[1:])},
              'fires': int(len(np.unique(g))), 'squares': n, 'squaresBehindLine': int(behind.sum()), 'burnedBehindLine': int(y[behind].sum()), 'ridge': RIDGE,
              'leaveOneFireOut': {'logLossPerSquare': {'withoutStep': round(base_ll / n, 5), 'withStep': round(adj_ll / n, 5)}, 'brier': {'withoutStep': round(base_br / n, 5), 'withStep': round(adj_br / n, 5)}, 'firesWhereStepHelped': int(wins)},
              'caveats': ['Frozen-model scores are in-sample for these fires.', 'Association, not a controlled experiment.', 'Small sample; ridge-shrunk.']}
    a.out.write_text(json.dumps(report, indent=2)); print(json.dumps(report, indent=2))
    w = report['weights']; loo = report['leaveOneFireOut']
    (app / 'lib/fireline-model.ts').write_text(f"""// GENERATED by scripts/ml/fireline_model.py. Do not edit by hand.
// Line-aware step fitted on {report['fires']} fires (2018-2019) with real completed fire lines.
// new score = sigmoid(logit(model score) + weight for the square's position behind a line).
export const FIRELINE_MODEL = {{
  weights: {{ near: {w['near']}, mid: {w['mid']}, far: {w['far']}, cutOff: {w['cutOff']} }},
  fires: {report['fires']}, squaresBehindLine: {report['squaresBehindLine']}, burnedBehindLine: {report['burnedBehindLine']},
  leaveOneFireOut: {{ logLossWithout: {loo['logLossPerSquare']['withoutStep']}, logLossWith: {loo['logLossPerSquare']['withStep']}, firesHelped: {loo['firesWhereStepHelped']} }},
}} as const;
""")
if __name__ == '__main__': main()
