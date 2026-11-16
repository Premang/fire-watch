#!/usr/bin/env python3
"""Does building fire lines into the main model help on fires it has not seen?

Step 1 (this script, needs only 2018-2019 line records): repeated grouped cross-validation over the
43 training fires. Each fold trains the v2 recipe twice on the other fires, once with the 25 original
inputs and once with 4 added line inputs, and scores both on the left-out fires.

Line inputs for a square (all 0 for squares in the clear or with no recorded lines):
  behind a completed line and 1-2 / 3-5 / 6+ squares from the fire, and fully cut off.
They are constrained so a line can only lower a score, never raise it.
"""
import sys, json, argparse
from pathlib import Path
from datetime import datetime, timezone
import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fireline_effect import eligible, fetch_lines, distances  # noqa: E402
from fireline_model import design  # noqa: E402

def line_inputs(ev, cache):
    feats = fetch_lines(ev, cache)
    cutoff = datetime.fromisoformat(ev['dates'][3]).replace(tzinfo=timezone.utc).timestamp() * 1000
    used = [f for f in feats if (f['line'] or f['created']) is not None and (f['line'] or f['created']) < cutoff]
    segs = [np.stack([np.asarray(p[:-1], float), np.asarray(p[1:], float)], 1) for f in used for p in f['paths'] if len(p) > 1]
    d0, held, _ = distances(ev, np.concatenate(segs) if segs else np.zeros((0, 2, 2)))
    X = design(np.where(np.isfinite(d0), d0, 1e9), held); X[(ev['recent'] == 1) | ~np.isfinite(d0)] = 0
    return X

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--run', type=Path, required=True); ap.add_argument('--cache', type=Path, required=True); ap.add_argument('--out', type=Path, required=True); a = ap.parse_args()
    app = Path(__file__).resolve().parents[2]; boundaries = json.loads((app / 'public/data/us-states.json').read_text())
    protocol = json.loads((a.run / 'protocol.json').read_text())['candidates']; leaves = json.loads((a.run / 'artifacts/evaluation.json').read_text())['selectedLeaves']
    ready = json.loads((a.run / 'data/ready-events.json').read_text()); events = []
    for e in ready['events']:
        if e['split'] != 'train': continue
        ev = eligible(e, boundaries)
        if 'skipped' in ev: continue
        ev['lines'] = line_inputs(ev, a.cache); events.append(ev); print(ev['event'], len(ev['y']), int(ev['y'].sum()), ev['lines'].sum(0).astype(int).tolist(), flush=True)
    x = np.concatenate([e['x'] for e in events]); L = np.concatenate([e['lines'] for e in events]); y = np.concatenate([e['y'] for e in events])
    g = np.concatenate([np.full(len(e['y']), i) for i, e in enumerate(events)]); w = np.concatenate([np.full(len(e['y']), 1 / len(e['y'])) for e in events]); w *= len(w) / w.sum()
    def model(extra):
        kw = dict(max_iter=protocol['maxIter'], max_leaf_nodes=leaves, learning_rate=protocol['learningRate'], min_samples_leaf=protocol['minSamplesLeaf'], l2_regularization=protocol['l2Regularization'], early_stopping=False, random_state=protocol['randomState'])
        if extra: kw['monotonic_cst'] = [0] * x.shape[1] + [-1] * L.shape[1]
        return HistGradientBoostingClassifier(**kw)
    xl = np.hstack([x, L]); rng = np.random.default_rng(20261114); rows = []; behind = L.any(1)
    for rep in range(5):
        order = rng.permutation(len(events)); fold = np.empty(len(events), int); fold[order] = np.arange(len(events)) % 5
        p0 = np.zeros(len(y)); p1 = np.zeros(len(y))
        for k in range(5):
            te = fold[g] == k; tr = ~te
            p0[te] = model(False).fit(x[tr], y[tr], sample_weight=w[tr]).predict_proba(x[te])[:, 1]
            p1[te] = model(True).fit(xl[tr], y[tr], sample_weight=w[tr]).predict_proba(xl[te])[:, 1]
        def score(p, m=slice(None)):
            return {'prAuc': float(average_precision_score(y[m], p[m], sample_weight=w[m])), 'brier': float(brier_score_loss(y[m], p[m], sample_weight=w[m])), 'logLoss': float(log_loss(y[m], np.clip(p[m], 1e-6, 1 - 1e-6), sample_weight=w[m], labels=[0, 1]))}
        rows.append({'without': score(p0), 'withLines': score(p1), 'behindOnly': {'without': score(p0, behind), 'withLines': score(p1, behind)}}); print(rep, json.dumps(rows[-1]), flush=True)
    mean = lambda path: float(np.mean([r[path[0]][path[1]] if len(path) == 2 else r[path[0]][path[1]][path[2]] for r in rows]))
    report = {'fires': len(events), 'squares': int(len(y)), 'burned': int(y.sum()), 'squaresBehindLine': int(behind.sum()), 'burnedBehindLine': int(y[behind].sum()), 'repeats': 5, 'folds': 5,
              'allSquares': {m: {k: round(mean((m, k)), 5) for k in ('prAuc', 'brier', 'logLoss')} for m in ('without', 'withLines')},
              'squaresBehindALine': {m: {k: round(mean(('behindOnly', m, k)), 5) for k in ('prAuc', 'brier', 'logLoss')} for m in ('without', 'withLines')},
              'withLinesBetterInRepeats': {k: int(sum((r['withLines'][k] > r['without'][k]) if k == 'prAuc' else (r['withLines'][k] < r['without'][k]) for r in rows)) for k in ('prAuc', 'brier', 'logLoss')}, 'perRepeat': rows}
    a.out.write_text(json.dumps(report, indent=2)); print(json.dumps({k: v for k, v in report.items() if k != 'perRepeat'}, indent=2))
if __name__ == '__main__': main()
