#!/usr/bin/env python3
"""Geometry sensitivity of the frozen v2 model on NOAA-20 inputs (DEVELOPMENT events only).

Live grids differ from the evaluated grids in two ways (Astra review 5):
  1. Origin: live snaps origins to 1,500 m multiples in its own zone; evaluation used
     WSTS TIFF origins. Simulated exactly with the 16 possible 375 m pixel offsets of
     the 4x4 blocking (fire masks re-rasterized from NOAA-20 points with the shifted
     origin; weather/terrain re-blocked from the same 375 m rasters).
  2. Axes: the live contract expresses displacement and downslope aspect in TRUE-NORTH
     axes (CONTRACT.md); training features are in UTM 10N grid axes. Simulated by rotating
     those vectors from zone-10 grid axes to true north per cell (exactly flat cells keep
     the training aspect placeholder).
The cell lattice is not rotated or rescaled (feature-axis effect only). Holdout unused.
No fitting: the frozen released v2 model scores every variant.
Usage: python geometry_sensitivity.py --n20 ../../../ml-n20 --v2 ../../../ml-v2 --out DIR
"""
import argparse, json, warnings
from pathlib import Path
import numpy as np
import tifffile
from pyproj import Transformer
from sklearn.metrics import average_precision_score, brier_score_loss

import train
from train import block, us_mask
from train_v2 import export_predict
import train_n20 as t20
import experiment_v3_dev as dirfeat

NB = len(train.FEATURES)


def shifted(a, oy, ox):
    return a[oy:, ox:]


def north_offset(epsg, lon, lat):
    """Grid bearing (radians) of true north at lon/lat in a projected CRS."""
    to = Transformer.from_crs(4326, epsg, always_xy=True)
    x, y = to.transform(lon, lat); x2, y2 = to.transform(lon, lat + 0.01)
    return np.arctan2(np.asarray(x2) - np.asarray(x), np.asarray(y2) - np.asarray(y))


def rotate(e, n, theta):
    """Re-express grid-axis (east, north) components in axes rotated so bearings gain theta."""
    c, s = np.cos(theta), np.sin(theta)
    return e * c + n * s, n * c - e * s


def prepare(event, boundaries, points, oy, ox):
    paths = [Path(f['path']) for f in event['files']]; dates = [p.stem for p in paths]
    with tifffile.TiffFile(paths[0]) as f: raw0 = f.asarray(); geo = dict(f.geotiff_metadata)
    raw0 = raw0 if raw0.shape[-1] == 23 else np.moveaxis(raw0, 0, -1)
    fut = tifffile.imread(paths[2]); fut = fut if fut.shape[-1] == 23 else np.moveaxis(fut, 0, -1)
    raw, future = shifted(raw0, oy, ox), shifted(fut, oy, ox)
    tp = list(geo['ModelTiepoint']); tp[3] += ox * 375; tp[4] -= oy * 375; geo['ModelTiepoint'] = tp
    weather = block(raw); elev = weather[..., 14]
    weather[..., 7] = np.degrees(np.arctan2(block(np.sin(np.radians(raw[..., 7]))), block(np.cos(np.radians(raw[..., 7]))))) % 360
    forecast = block(future)
    old = t20.n20_mask(points, dates[0], geo, raw.shape); recent = t20.n20_mask(points, dates[1], geo, raw.shape)
    labels = t20.n20_mask(points, dates[3], geo, raw.shape)
    if not recent.any(): return None
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)
        x = train.features(recent, old, elev, weather, forecast)
    h, w = recent.shape; rows, cols = np.indices((h, w)); origin = tp[3:5]
    lon, lat = Transformer.from_crs(32610, 4326, always_xy=True).transform(origin[0] + (cols + .5) * 1500, origin[1] - (rows + .5) * 1500)
    valid = us_mask(lon, lat, boundaries) & np.isfinite(elev) & (x[..., 2] <= 12)
    valid[:3] = False; valid[-3:] = False; valid[:, :3] = False; valid[:, -3:] = False
    valid &= np.isfinite(x).all(axis=-1)
    if not valid.any(): return None
    lo, la = lon[valid], lat[valid]
    theta = -north_offset(32610, lo, la)  # zone-10 grid bearing -> true bearing
    return {'x': x[valid], 'y': labels[valid].astype(int), 'theta': theta}


def to_geographic(x, theta):
    x = x.copy(); x[:, 6], x[:, 7] = rotate(x[:, 6], x[:, 7], theta)
    sloped = x[:, 9] != 0  # exactly flat: training placeholder aspect has no direction
    x[sloped, 10], x[sloped, 11] = rotate(x[sloped, 10], x[sloped, 11], theta[sloped])
    return x


def main():
    ap = argparse.ArgumentParser()
    for k in ('n20', 'v2', 'out'): ap.add_argument('--' + k, type=Path, required=True)
    a = ap.parse_args(); n20, v2, out = a.n20.resolve(), a.v2.resolve(), a.out.resolve(); out.mkdir(parents=True, exist_ok=True)
    protocol = json.loads((n20 / 'protocol.json').read_text()); amendment = json.loads((n20 / 'amendment-1.json').read_text())
    ready = {e['event']: e for e in json.loads((v2 / 'data/ready-events.json').read_text())['events']}
    events = [ready[ev] for evs in amendment['developmentSplits'].values() for ev in evs]
    app = Path(__file__).resolve().parents[2]; boundaries = json.loads((app / 'public/data/us-states.json').read_text())
    points = t20.load_firms(n20 / 'firms', protocol, {Path(f['name']).stem for e in events for f in e['files']})
    model = json.loads((v2 / 'artifacts/model.json').read_text())
    offsets = [(oy, ox) for oy in range(4) for ox in range(4)]
    per = {}  # (variant) -> list of per-event dicts
    for i, e in enumerate(events):
        got = {}
        for oy, ox in offsets:
            p = prepare(e, boundaries, points, oy, ox)
            if p is None: got = None; break
            got[oy, ox] = p
        if got is None: continue  # comparable events only: eligible under every offset
        for (oy, ox), p in got.items():
            for axes in ('zone10', 'geographic'):
                x = p['x'][:, :NB].copy()
                if axes == 'geographic': x = to_geographic(x, p['theta'])
                per.setdefault((oy, ox, axes), []).append({'event': e['event'], 'y': p['y'], 'p': export_predict(model, x),
                                                           'thetaDegMax': float(np.degrees(np.abs(p['theta'])).max())})
        if i % 20 == 0: print('event', i, len(events), flush=True)
    def summary(rows):
        y = np.concatenate([r['y'] for r in rows]); p = np.concatenate([r['p'] for r in rows])
        w = np.concatenate([np.full(len(r['y']), 1 / len(r['y'])) for r in rows]); w *= len(w) / w.sum()
        return {'brier': float(brier_score_loss(y, p, sample_weight=w)), 'prAuc': float(average_precision_score(y, p, sample_weight=w)),
                'events': len(rows), 'cells': int(len(y)), 'positives': int(y.sum())}
    results = {f'{oy},{ox},{axes}': summary(rows) for (oy, ox, axes), rows in per.items()}
    base = per[0, 0, 'zone10']; n_ev = len(base)
    rng = np.random.default_rng(20261104); idx = [rng.integers(0, n_ev, n_ev) for _ in range(1000)]
    def paired(variant):
        # Keep every Brier draw; omit an AP draw only when either paired sample has no positives.
        db, dp = [], []
        for ii in idx:
            va = [per[variant][j] for j in ii]; vb = [base[j] for j in ii]
            ya = np.concatenate([r['y'] for r in va]); yb = np.concatenate([r['y'] for r in vb])
            pa = np.concatenate([r['p'] for r in va]); pb = np.concatenate([r['p'] for r in vb])
            wa = np.concatenate([np.full(len(r['y']), 1 / len(r['y'])) for r in va]); wb = np.concatenate([np.full(len(r['y']), 1 / len(r['y'])) for r in vb])
            db.append(brier_score_loss(ya, pa, sample_weight=wa) - brier_score_loss(yb, pb, sample_weight=wb))
            if ya.any() and yb.any(): dp.append(average_precision_score(ya, pa, sample_weight=wa) - average_precision_score(yb, pb, sample_weight=wb))
        q = lambda v: [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))]
        return {'brierDelta': results[f'{variant[0]},{variant[1]},{variant[2]}']['brier'] - results['0,0,zone10']['brier'],
                'prAucDelta': results[f'{variant[0]},{variant[1]},{variant[2]}']['prAuc'] - results['0,0,zone10']['prAuc'],
                'brierDelta95': q(db), 'prAucDelta95': q(dp)}
    deltas = {f'{oy},{ox},{axes}': paired((oy, ox, axes)) for (oy, ox, axes) in per if (oy, ox, axes) != (0, 0, 'zone10')}
    theta = [b['thetaDegMax'] for b in base]
    zb = [v['brier'] for k, v in results.items() if k.endswith('zone10')]; zp = [v['prAuc'] for k, v in results.items() if k.endswith('zone10')]
    gb = [v['brier'] for k, v in results.items() if k.endswith('geographic')]; gp = [v['prAuc'] for k, v in results.items() if k.endswith('geographic')]
    report = {'note': 'Development events only; frozen v2; no fitting. Holdout unused. Deltas are variant minus the evaluated geometry (offset 0,0, zone-10 axes), paired event bootstrap (1000).',
              'comparableEvents': n_ev, 'variants': results, 'pairedDeltasVsEvaluated': deltas,
              'originOffsetRange': {'brier': [min(zb), max(zb)], 'prAuc': [min(zp), max(zp)]},
              'geographicAxesRange': {'brier': [min(gb), max(gb)], 'prAuc': [min(gp), max(gp)]},
              'meanGeographicMinusZone10': {'brier': float(np.mean(gb) - np.mean(zb)), 'prAuc': float(np.mean(gp) - np.mean(zp))},
              'zone10ToTrueNorthDegrees': {'median': float(np.median(theta)), 'max': float(np.max(theta))}}
    (out / 'geometry-sensitivity.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({k: v for k, v in report.items() if k not in ('variants', 'pairedDeltasVsEvaluated')}, indent=2))
    worst = max(deltas.items(), key=lambda kv: abs(kv[1]['prAucDelta'])); print('largest |prAucDelta|', worst[0], json.dumps(worst[1]))
    print('variants whose paired 95% interval excludes zero:', [k for k, v in deltas.items() if v['brierDelta95'][0] > 0 or v['brierDelta95'][1] < 0 or v['prAucDelta95'][0] > 0 or v['prAucDelta95'][1] < 0])


if __name__ == '__main__':
    main()
