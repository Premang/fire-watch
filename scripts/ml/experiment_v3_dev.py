#!/usr/bin/env python3
"""V3 DEVELOPMENT experiment (not a release evaluation).

Uses only the frozen v2 train / calibration / selection splits. The 2021 test
split is never prepared or opened here: it was already inspected for v2 and must
not be used to choose a v3. Selection metrics below are optimistic model-choice
evidence; a v3 claim needs a new, untouched holdout (see Astra review notes).

Candidates (suggested by the Astra/GPT review, 2026-11-03):
  * directional interactions: downwind / crosswind displacement from the nearest
    recent fire, upslope displacement, upwind recent-fire density, local front
    expansion (recent minus prior neighbourhood density)
  * calibration of the FINAL blended score (regularized Platt) instead of an
    offset on the tree component only
  * logistic regression as a serious comparator
  * new-cell (previously unoccupied) metrics as an explicit objective

Usage: python experiment_v3_dev.py --run ../../../../ml-v2 --out OUT_DIR
"""
import argparse, json
from pathlib import Path
import numpy as np
import warnings
import tifffile
from pyproj import Transformer
from scipy.ndimage import convolve, map_coordinates
from scipy.optimize import minimize
from scipy.special import expit, logit
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss

import train
from train_v2 import eligible, arrays, threshold, fit_offset

BASE_FEATURES = list(train.FEATURES)
EXTRA_FEATURES = ['downwind_km', 'crosswind_km', 'upslope_km', 'upwind_fire_density', 'front_expansion_7']
_base_features = train.features


CURRENT_EVENT = {}  # set by main() before each prepare(); used only for the grid geometry


def grid_north_offset(shape):
    """Per-cell grid bearing (radians) of TRUE north in the event's projected grid.

    Wind bearings are geographic; displacement and aspect are in UTM grid axes.
    All WSTS events are UTM 10N, so convergence reaches ~10-15 deg in the
    interior West. Computed numerically to avoid sign-convention mistakes:
    grid_bearing = true_bearing + offset.
    """
    path = Path(CURRENT_EVENT['files'][0]['path'])
    with tifffile.TiffFile(path) as f:
        geo = f.geotiff_metadata
    origin = geo['ModelTiepoint'][3:5]; epsg = int(geo['ProjectedCSTypeGeoKey'])
    rows, cols = np.indices(shape)
    ex, ny = origin[0] + (cols + .5) * 1500, origin[1] - (rows + .5) * 1500
    to_geo = Transformer.from_crs(epsg, 4326, always_xy=True); to_grid = Transformer.from_crs(4326, epsg, always_xy=True)
    lon, lat = to_geo.transform(ex, ny)
    ex2, ny2 = to_grid.transform(lon, lat + 0.01)
    return np.arctan2(ex2 - ex, ny2 - ny)


def extended_features(recent, prior, elev, weather, forecast):
    x = _base_features(recent, prior, elev, weather, forecast)
    east, north = x[..., 6], x[..., 7]          # cell minus nearest recent fire (km), grid axes
    sa, ca = x[..., 10], x[..., 11]             # sin/cos of DOWNSLOPE aspect, grid axes
    slope = x[..., 9]
    # Wind FROM bearing rotated from geographic into grid axes.
    wind_grid = np.radians(weather[..., 7]) + grid_north_offset(recent.shape)
    ws, wc = np.sin(wind_grid), np.cos(wind_grid)
    downwind = -(east * ws + north * wc)        # >0: cell lies downwind of the fire
    crosswind = np.abs(east * wc - north * ws)
    # >0: cell lies uphill of the fire along local slope; aspect undefined on flat cells.
    upslope = np.where(slope >= 0.5, -(east * sa + north * ca), 0.)
    # Upwind recent-fire density: bilinear samples of the recent mask at 1..4 cells
    # toward the wind source (east = +col, north = -row). Out-of-grid samples are
    # missing (not zero); density is the mean over in-grid samples.
    h, w = recent.shape
    rows, cols = np.indices((h, w))
    samples = []
    for k in range(1, 5):
        coords = np.stack([rows - k * wc, cols + k * ws])
        samples.append(map_coordinates(recent.astype(float), coords.reshape(2, -1), order=1, mode='constant', cval=np.nan).reshape(h, w))
    samples = np.stack(samples)
    with np.errstate(invalid='ignore'):
        upwind = np.where(np.isfinite(samples).any(0), np.nanmean(np.where(np.isfinite(samples), samples, np.nan), axis=0), np.nan)
    upwind = np.where(np.isfinite(ws) & np.isfinite(wc), upwind, np.nan)
    k7 = np.ones((7, 7), dtype=np.int32)
    expansion = (convolve(recent.astype(np.int32), k7, mode='constant') - convolve(prior.astype(np.int32), k7, mode='constant')) / 49
    return np.concatenate([x, np.stack([downwind, crosswind, upslope, upwind, expansion], axis=-1)], axis=-1)


def platt_fit(y, p, w, shrink=1.0):
    """Regularized Platt on logit(p): sigmoid(a*z+b), a>0, L2 shrink toward (1,0)."""
    z = logit(np.clip(p, 1e-6, 1 - 1e-6)); wn = w / w.sum()
    def loss(t):
        a, b = np.exp(t[0]), t[1]; q = np.clip(expit(a * z + b), 1e-9, 1 - 1e-9)
        return -np.sum(wn * (y * np.log(q) + (1 - y) * np.log(1 - q))) + shrink * 1e-3 * (t[0] ** 2 + b ** 2)
    t = minimize(loss, [0., 0.], method='L-BFGS-B').x
    return float(np.exp(t[0])), float(t[1])


def platt_apply(p, ab):
    return expit(ab[0] * logit(np.clip(p, 1e-6, 1 - 1e-6)) + ab[1])


def report(y, p, w, recent, thr):
    out = {}
    for name, m in (('all', np.ones_like(y, bool)), ('newCells', recent == 0), ('occupied', recent == 1)):
        yy, pp, ww = y[m], p[m], w[m]
        z = pp >= thr
        tp = np.sum(ww * yy * z)
        out[name] = {'prAuc': float(average_precision_score(yy, pp, sample_weight=ww)) if yy.any() else None,
                     'brier': float(brier_score_loss(yy, pp, sample_weight=ww)),
                     'logLoss': float(log_loss(yy, np.clip(pp, 1e-9, 1 - 1e-9), sample_weight=ww, labels=[0, 1])),
                     'recall': float(tp / max(1e-12, np.sum(ww * yy))),
                     'precision': float(tp / max(1e-12, np.sum(ww * z))),
                     'positives': int(yy.sum()), 'cells': int(len(yy))}
    # Reliability on selection (mean predicted vs observed), coarse bins.
    bins = [0, .01, .025, .05, .1, .2, .4, .6, 1.0]
    rel = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        m = (p >= lo) & (p < hi)
        if m.sum():
            rel.append({'bin': [lo, hi], 'meanPredicted': float(np.average(p[m], weights=w[m])),
                        'observed': float(np.average(y[m], weights=w[m])), 'cells': int(m.sum())})
    out['reliability'] = rel
    out['threshold'] = float(thr)
    return out


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--run', type=Path, required=True); ap.add_argument('--out', type=Path, required=True)
    a = ap.parse_args(); run = a.run.resolve(); out = a.out.resolve(); out.mkdir(parents=True, exist_ok=True)
    protocol = json.loads((run / 'protocol.json').read_text()); ready = json.loads((run / 'data/ready-events.json').read_text())
    app = Path(__file__).resolve().parents[2]; boundaries = json.loads((app / 'public/data/us-states.json').read_text())
    train.features = extended_features  # prepare() looks the global up at call time
    groups = {s: [] for s in ('train', 'selection', 'calibration')}
    for e in ready['events']:
        if e['split'] == 'test':
            continue  # never prepared: test labels stay unopened in this experiment
        CURRENT_EVENT.clear(); CURRENT_EVENT.update(e)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', RuntimeWarning)
            p = eligible(e, boundaries)
        if 'skipped' not in p:
            groups[p['split']].append(p)
    data = {}
    for s, evs in groups.items():
        x, y, w = arrays(evs); r = np.concatenate([p['recent'] for p in evs])
        data[s] = (x, y, w, r)
        print(s, 'events', len(evs), 'cells', len(y), 'positives', int(y.sum()), 'newCellPositives', int(y[r == 0].sum()), flush=True)
    nb = len(BASE_FEATURES)
    cfg = protocol['candidates']
    xt, yt, wt, rt = data['train']; xc, yc, wc, rc = data['calibration']; xs, ys, ws, rs = data['selection']
    rates = np.array([np.average(yt[xt[:, 0] == v], weights=wt[xt[:, 0] == v]) for v in (0, 1)])
    base = lambda x: rates[x[:, 0].astype(int)]

    results = {}; saved = {}
    sel_event = np.concatenate([np.full(len(p['y']), i) for i, p in enumerate(groups['selection'])])
    def gbt(cols, leaves, lr=None, l2=None, msl=None):
        m = HistGradientBoostingClassifier(max_iter=cfg['maxIter'], max_leaf_nodes=leaves, learning_rate=lr or cfg['learningRate'],
                                           min_samples_leaf=msl or cfg['minSamplesLeaf'], l2_regularization=cfg['l2Regularization'] if l2 is None else l2,
                                           early_stopping=False, random_state=cfg['randomState'])
        return m.fit(xt[:, cols], yt, sample_weight=wt)

    def evaluate(name, raw_c, raw_s, tree_weights=(0.5, 0.75, 1.0)):
        """raw_*: component probabilities on calibration / selection."""
        off = fit_offset(yc, raw_c, wc, True)
        for tw in tree_weights:
            for calib in ('offset-component', 'platt-final'):
                if calib == 'offset-component':
                    pc = tw * expit(logit(np.clip(raw_c, 1e-6, 1 - 1e-6)) + off) + (1 - tw) * base(xc)
                    ps = tw * expit(logit(np.clip(raw_s, 1e-6, 1 - 1e-6)) + off) + (1 - tw) * base(xs)
                else:
                    blend_c = tw * raw_c + (1 - tw) * base(xc); blend_s = tw * raw_s + (1 - tw) * base(xs)
                    ab = platt_fit(yc, blend_c, wc); pc = platt_apply(blend_c, ab); ps = platt_apply(blend_s, ab)
                # Threshold chosen on CALIBRATION (not selection) so selection recall is not threshold-tuned.
                thr = threshold(yc, pc, wc)
                key = f'{name}|w={tw}|{calib}'
                saved[key] = ps
                results[key] = report(ys, ps, ws, rs, thr)
                r = results[key]
                print(f"{key:58s} selBrier {r['all']['brier']:.5f} selPR {r['all']['prAuc']:.4f} newPR {r['newCells']['prAuc']:.4f} newRecall {r['newCells']['recall']:.3f} thr {thr:.3f}", flush=True)

    base_cols = list(range(nb)); ext_cols = list(range(nb + len(EXTRA_FEATURES)))
    for leaves in cfg['maxLeafNodes']:
        for tag, cols in (('base', base_cols), ('ext', ext_cols)):
            m = gbt(cols, leaves)
            evaluate(f'gbt-{tag}-L{leaves}', m.predict_proba(xc[:, cols])[:, 1], m.predict_proba(xs[:, cols])[:, 1])
    # Smaller-data regularized GBT variant.
    for tag, cols in (('base', base_cols), ('ext', ext_cols)):
        m = gbt(cols, 7, lr=0.05, l2=1.0, msl=200)
        evaluate(f'gbt-{tag}-reg', m.predict_proba(xc[:, cols])[:, 1], m.predict_proba(xs[:, cols])[:, 1])
    for tag, cols in (('base', base_cols), ('ext', ext_cols)):
        lg = make_pipeline(SimpleImputer(add_indicator=True), StandardScaler(), LogisticRegression(max_iter=2000, C=.1, random_state=42))
        lg.fit(xt[:, cols], yt, logisticregression__sample_weight=wt)
        evaluate(f'logistic-{tag}', lg.predict_proba(xc[:, cols])[:, 1], lg.predict_proba(xs[:, cols])[:, 1], tree_weights=(1.0,))
    results['_persistence'] = report(ys, base(xs), ws, rs, threshold(yc, base(xc), wc))
    # Paired event-bootstrap on SELECTION vs the v2 recipe (still development evidence).
    rng = np.random.default_rng(20261103); n_ev = sel_event.max() + 1
    idx_by_event = [np.flatnonzero(sel_event == i) for i in range(n_ev)]
    boot = {}
    pairs = [('gbt-ext-L7|w=0.5|offset-component', 'gbt-base-L15|w=0.5|offset-component'),
             ('gbt-ext-L7|w=0.75|platt-final', 'gbt-base-L15|w=0.5|offset-component'),
             ('gbt-ext-L7|w=0.5|offset-component', 'gbt-base-L7|w=0.5|offset-component'),  # isolates feature effect
             ('gbt-ext-L15|w=0.5|offset-component', 'gbt-base-L15|w=0.5|offset-component')]
    for key, ref in pairs:
        db, dp, dn = [], [], []
        for _ in range(1000):
            ii = np.concatenate([idx_by_event[j] for j in rng.integers(0, n_ev, n_ev)])
            yy, ww, rr = ys[ii], ws[ii], rs[ii]
            if not yy.any() or not yy[rr == 0].any():
                continue
            a, b = saved[key][ii], saved[ref][ii]
            db.append(brier_score_loss(yy, a, sample_weight=ww) - brier_score_loss(yy, b, sample_weight=ww))
            dp.append(average_precision_score(yy, a, sample_weight=ww) - average_precision_score(yy, b, sample_weight=ww))
            m = rr == 0
            dn.append(average_precision_score(yy[m], a[m], sample_weight=ww[m]) - average_precision_score(yy[m], b[m], sample_weight=ww[m]))
        q = lambda v: [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))]
        boot[f'{key} VS {ref}'] = {'brierDelta95': q(db), 'prAucDelta95': q(dp), 'newCellPrAucDelta95': q(dn), 'draws': len(db)}
        print('BOOT', key, 'VS', ref, json.dumps(boot[f'{key} VS {ref}']), flush=True)
    results['_bootstrapVsV2Recipe'] = boot
    (out / 'v3-dev-results.json').write_text(json.dumps({'note': 'Selection-split development metrics only. 2021 test never opened. Optimistic; not a release evaluation.',
                                                          'extraFeatures': EXTRA_FEATURES, 'results': results}, indent=2))
    print('WROTE', out / 'v3-dev-results.json')


if __name__ == '__main__':
    main()
