#!/usr/bin/env python3
"""Development sensitivity of the frozen NOAA-20 logistic baseline to the trial's axis convention.
The logistic was fit on zone-10-axis features; the trial scores true-north-aligned live features.
Development events only (offset 0,0); holdout unused; no fitting.
Usage: python logistic_axes_sensitivity.py --n20 ../../../ml-n20 --v2 ../../../ml-v2 --out ../../../ml-n20/geometry"""
import argparse, json, pickle
from pathlib import Path
import numpy as np
from sklearn.metrics import average_precision_score, brier_score_loss
import train_n20 as t20
from geometry_sensitivity import prepare, to_geographic, NB

ap = argparse.ArgumentParser()
for k in ('n20', 'v2', 'out'): ap.add_argument('--' + k, type=Path, required=True)
a = ap.parse_args(); n20, v2, out = a.n20.resolve(), a.v2.resolve(), a.out.resolve()
protocol = json.loads((n20 / 'protocol.json').read_text()); amendment = json.loads((n20 / 'amendment-1.json').read_text())
ready = {e['event']: e for e in json.loads((v2 / 'data/ready-events.json').read_text())['events']}
events = [ready[ev] for evs in amendment['developmentSplits'].values() for ev in evs]
boundaries = json.loads((Path(t20.__file__).resolve().parents[2] / 'public/data/us-states.json').read_text())
points = t20.load_firms(n20 / 'firms', protocol, {Path(f['name']).stem for e in events for f in e['files']})
with open(n20 / 'artifacts/logistic.pkl', 'rb') as f: logistic = pickle.load(f)
rows = [p for e in events if (p := prepare(e, boundaries, points, 0, 0)) is not None]
y = np.concatenate([r['y'] for r in rows]); w = np.concatenate([np.full(len(r['y']), 1 / len(r['y'])) for r in rows]); w *= len(w) / w.sum()
res = {}
for name, fx in (('zone10Axes', lambda r: r['x'][:, :NB]), ('trueNorthAxes', lambda r: to_geographic(r['x'][:, :NB], r['theta']))):
    p = np.concatenate([logistic.predict_proba(fx(r))[:, 1] for r in rows])
    res[name] = {'brier': float(brier_score_loss(y, p, sample_weight=w)), 'prAuc': float(average_precision_score(y, p, sample_weight=w))}
res['delta'] = {k: res['trueNorthAxes'][k] - res['zone10Axes'][k] for k in ('brier', 'prAuc')}
(out / 'logistic-axes-sensitivity.json').write_text(json.dumps({'events': len(rows), 'cells': int(len(y)), 'note': 'Development only; frozen NOAA-20 logistic; no fitting.', **res}, indent=2))
print(json.dumps(res, indent=2))
