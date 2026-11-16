#!/usr/bin/env python3
"""Synthetic axis-rotation stress test (development events, offset 0,0, frozen v2).
Measures how the frozen model degrades when direction features are rotated away from
the training frame, up to +/-45 deg (the zone-10 vs true-north gap in New England, i.e.
what a zone-10 axis convention would impose there). Flat cells keep the placeholder
aspect. Holdout unused.
Usage: python geometry_rotation_stress.py --n20 ../../../ml-n20 --v2 ../../../ml-v2 --out DIR"""
import argparse, json
from pathlib import Path
import numpy as np
from sklearn.metrics import average_precision_score, brier_score_loss
import train_n20 as t20
from train_v2 import export_predict
from geometry_sensitivity import prepare, rotate, NB

ap = argparse.ArgumentParser()
for k in ('n20', 'v2', 'out'): ap.add_argument('--' + k, type=Path, required=True)
a = ap.parse_args(); n20, v2, out = a.n20.resolve(), a.v2.resolve(), a.out.resolve()
protocol = json.loads((n20 / 'protocol.json').read_text()); amendment = json.loads((n20 / 'amendment-1.json').read_text())
ready = {e['event']: e for e in json.loads((v2 / 'data/ready-events.json').read_text())['events']}
events = [ready[ev] for evs in amendment['developmentSplits'].values() for ev in evs]
app = Path(t20.__file__).resolve().parents[2]; boundaries = json.loads((app / 'public/data/us-states.json').read_text())
points = t20.load_firms(n20 / 'firms', protocol, {Path(f['name']).stem for e in events for f in e['files']})
model = json.loads((v2 / 'artifacts/model.json').read_text())
rows = [p for e in events if (p := prepare(e, boundaries, points, 0, 0)) is not None]
y = np.concatenate([r['y'] for r in rows]); w = np.concatenate([np.full(len(r['y']), 1 / len(r['y'])) for r in rows]); w *= len(w) / w.sum()
res = {}
for deg in (0, 5, 15, 25, 35, 45, -15, -25, -45):
    ps = []
    for r in rows:
        x = r['x'][:, :NB].copy(); th = np.radians(deg); sloped = x[:, 9] != 0
        x[:, 6], x[:, 7] = rotate(x[:, 6], x[:, 7], th); x[sloped, 10], x[sloped, 11] = rotate(x[sloped, 10], x[sloped, 11], th)
        ps.append(export_predict(model, x))
    p = np.concatenate(ps)
    res[deg] = {'brier': float(brier_score_loss(y, p, sample_weight=w)), 'prAuc': float(average_precision_score(y, p, sample_weight=w))}
    print(deg, json.dumps(res[deg]), flush=True)
(out / 'rotation-stress.json').write_text(json.dumps({'events': len(rows), 'cells': int(len(y)), 'results': res}, indent=2))
