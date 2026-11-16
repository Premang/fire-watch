#!/usr/bin/env python3
"""NOAA-20 day-ahead model under ml-n20/protocol.json + ml-n20/amendment-1.json.

Stage `select`: rebuild prior/recent/target masks from NOAA-20 FIRMS points for
every development event (WSTS weather/terrain reused), fit the frozen candidate
grid on train, calibrate on calibration, choose on selection, and FREEZE
selection.json, model.json and the full logistic baseline. Holdout untouched.

Stage `holdout`: one-shot evaluation, run only after the holdout TIFFs are
downloaded. Verifies protocol, amendment, selection, model, baseline and source
hashes first; scores the frozen model FROM THE EXPORTED model.json; applies the
amended release gate; writes evaluation.json. Refuses to run twice.

Usage:
  python train_n20.py --stage select  --n20 ../../../ml-n20 --v2 ../../../ml-v2
  python train_n20.py --stage holdout --n20 ../../../ml-n20 --v2 ../../../ml-v2
"""
import argparse, csv, json, pickle, warnings
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
import tifffile
from pyproj import Transformer
from scipy.special import expit, logit
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.metrics import average_precision_score, brier_score_loss

import train
from train import block, us_mask, metrics, tree_export
from train_v2 import arrays, threshold, fit_offset, export_predict, sha
import experiment_v3_dev as dirfeat

CALIBRATIONS = ('identity', 'offset-component', 'platt-final')
NB = len(train.FEATURES)


def load_firms(firms_dir, protocol, wanted_dates):
    pts = defaultdict(list)
    for name, digest in protocol['firmsFiles'].items():
        path = firms_dir / name
        if sha(path) != digest: raise ValueError(f'FIRMS file changed after freeze: {name}')
        with open(path, newline='') as f:
            for row in csv.DictReader(f):
                if row['acq_date'] in wanted_dates and row['confidence'] in ('n', 'h') and row['type'] == '0':
                    pts[row['acq_date']].append((float(row['longitude']), float(row['latitude'])))
    return {d: np.asarray(v) for d, v in pts.items()}


def check_geometry(geo, raw_shape):
    """Enforce the audited assumptions behind n20_mask (Astra review 3)."""
    scale = geo.get('ModelPixelScale')
    if scale is None or abs(scale[0] - 375) > 1e-6 or abs(scale[1] - 375) > 1e-6:
        raise ValueError(f'Unexpected pixel scale {scale}; n20_mask assumes 375 m')
    tp = geo['ModelTiepoint']
    if tp[0] != 0 or tp[1] != 0: raise ValueError(f'Unexpected tiepoint raster coordinates {tp[:2]}')
    if int(geo['ProjectedCSTypeGeoKey']) != 32610: raise ValueError('Unexpected CRS; protocol audited UTM 10N only')


def n20_mask(points, day, geo, raw_shape):
    """1.5 km block mask: True where >=1 NOAA-20 point center falls in the block."""
    check_geometry(geo, raw_shape)
    h, w = raw_shape[0] // 4, raw_shape[1] // 4
    m = np.zeros((h, w), bool)
    p = points.get(day)
    if p is None or not len(p): return m
    ox, oy = geo['ModelTiepoint'][3:5]
    x, y = Transformer.from_crs(4326, int(geo['ProjectedCSTypeGeoKey']), always_xy=True).transform(p[:, 0], p[:, 1])
    c = np.floor((np.asarray(x) - ox) / 1500).astype(int); r = np.floor((oy - np.asarray(y)) / 1500).astype(int)
    ok = (r >= 0) & (r < h) & (c >= 0) & (c < w)
    m[r[ok], c[ok]] = True
    return m


def prepare_n20(event, split, boundaries, points):
    """train.prepare() with fire masks from NOAA-20; everything else identical."""
    paths = [Path(f['path']) for f in event['files']]; dates = [p.stem for p in paths]
    with tifffile.TiffFile(paths[0]) as f: raw = f.asarray(); geo = f.geotiff_metadata
    if raw.shape[-1] != 23: raw = np.moveaxis(raw, 0, -1)
    weather = block(raw); elev = weather[..., 14]
    weather[..., 7] = np.degrees(np.arctan2(block(np.sin(np.radians(raw[..., 7]))), block(np.cos(np.radians(raw[..., 7]))))) % 360
    future = tifffile.imread(paths[2]); future = future if future.shape[-1] == 23 else np.moveaxis(future, 0, -1)
    forecast = block(future)
    old = n20_mask(points, dates[0], geo, raw.shape); recent = n20_mask(points, dates[1], geo, raw.shape)
    labels = n20_mask(points, dates[3], geo, raw.shape)
    if not recent.any(): return {'skipped': 'No recent NOAA-20 detections; outside model domain', 'event': event['event'], 'split': split}
    dirfeat.CURRENT_EVENT.clear(); dirfeat.CURRENT_EVENT.update(event)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)
        x = dirfeat.extended_features(recent, old, elev, weather, forecast)
    h, w = recent.shape; rows, cols = np.indices((h, w)); origin = geo['ModelTiepoint'][3:5]
    lon, lat = Transformer.from_crs(int(geo['ProjectedCSTypeGeoKey']), 4326, always_xy=True).transform(origin[0] + (cols + .5) * 1500, origin[1] - (rows + .5) * 1500)
    valid = us_mask(lon, lat, boundaries) & np.isfinite(elev) & (x[..., 2] <= 12)
    valid[:3] = False; valid[-3:] = False; valid[:, :3] = False; valid[:, -3:] = False
    valid &= np.isfinite(x).all(axis=-1)  # v2 eligibility: complete features only
    if valid.sum() < 1: return {'skipped': 'No eligible CONUS cells with complete features', 'event': event['event'], 'split': split}
    return {'event': event['event'], 'split': split, 'x': x[valid], 'y': labels[valid].astype(int), 'recent': recent[valid].astype(int),
            'center': [float(np.mean(lat[valid])), float(np.mean(lon[valid]))]}


def build(events_by_split, boundaries, points):
    """Prepare each event once with directional features; base = first 25 columns."""
    groups = {s: [] for s in events_by_split}; skipped = []
    for s, evs in events_by_split.items():
        for e in evs:
            p = prepare_n20(e, s, boundaries, points)
            (skipped if 'skipped' in p else groups[s]).append(p)
    return groups, skipped


def predict_exported(model, x):
    """Score an exported NOAA-20 model.json, INCLUDING finalCalibration.

    train_v2.export_predict ignores finalCalibration (Astra review 3, item 5), so
    the mixture is recomputed here and Platt is applied to the final blend.
    """
    nf = len(model['features']); x = x[:, :nf]
    core = dict(model); core.pop('mixture', None)
    p_tree = export_predict(core, x)  # tree + component calibration (offset or identity)
    mix = model['mixture']; baseline = np.asarray(mix['baselineRates'])[x[:, mix['baselineFeatureIndex']].astype(int)]
    p = mix['treeWeight'] * p_tree + (1 - mix['treeWeight']) * baseline
    if model.get('finalCalibration'):
        p = dirfeat.platt_apply(p, model['finalCalibration'])
    return p


def weighted_quantile(v, w, q):
    o = np.argsort(v); cw = np.cumsum(w[o]) / w.sum()
    return float(v[o][np.searchsorted(cw, q)])


def newcell_report(y, p, w, r, thr):
    m = r == 0; yy, pp, ww = y[m], p[m], w[m]; z = pp >= thr
    return {'alertThreshold': thr, 'eventWeightedAlertFraction': float(np.sum(ww * z) / ww.sum()),
            'recall': float(np.sum(ww * yy * z) / max(1e-12, np.sum(ww * yy))),
            'precision': float(np.sum(ww * yy * z) / max(1e-12, np.sum(ww * z))),
            'prAuc': float(average_precision_score(yy, pp, sample_weight=ww)) if yy.any() else None,
            'positives': int(yy.sum()), 'cells': int(m.sum())}


def load_spec(n20):
    protocol = json.loads((n20 / 'protocol.json').read_text())
    amendment_path = n20 / 'amendment-1.json'
    if not amendment_path.exists(): raise SystemExit('amendment-1.json required (pre-holdout amendment)')
    amendment = json.loads(amendment_path.read_text())
    assert amendment['protocolSha256'] == sha(n20 / 'protocol.json'), 'protocol changed after amendment'
    return protocol, amendment


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--stage', choices=('select', 'holdout'), required=True)
    ap.add_argument('--n20', type=Path, required=True); ap.add_argument('--v2', type=Path, required=True)
    ap.add_argument('--dry-run-on-selection', type=Path, help='Exercise the holdout code path on the SELECTION split; writes only to this directory')
    a = ap.parse_args(); n20 = a.n20.resolve(); v2 = a.v2.resolve(); out = n20 / 'artifacts'; out.mkdir(exist_ok=True)
    protocol, amendment = load_spec(n20)
    assert sha(v2 / 'plan.json') == protocol['v2PlanSha256'], 'v2 plan changed'
    assert sha(n20 / 'holdout-plan.json') == protocol['holdoutPlanSha256'], 'holdout plan changed'
    app = Path(__file__).resolve().parents[2]; boundaries = json.loads((app / 'public/data/us-states.json').read_text())
    ready = {e['event']: e for e in json.loads((v2 / 'data/ready-events.json').read_text())['events']}
    dev = {s: [ready[ev] for ev in evs] for s, evs in amendment['developmentSplits'].items()}
    cfg = protocol['candidates']

    if a.stage == 'select':
        if (out / 'selection.json').exists(): raise SystemExit('Selection already frozen; refusing to refit')
        wanted = {Path(f['name']).stem for evs in dev.values() for e in evs for f in e['files']}
        points = load_firms(n20 / 'firms', protocol, wanted)
        groups, skipped = build(dev, boundaries, points)
        data = {}
        for s, evs in groups.items():
            x, y, w = arrays(evs); r = np.concatenate([p['recent'] for p in evs]); data[s] = (x, y, w, r)
        support = {s: {'events': len(groups[s]), 'cells': int(len(data[s][1])), 'positives': int(data[s][1].sum()),
                       'newCellPositives': int(data[s][1][data[s][3] == 0].sum()), 'positiveEvents': sum(bool(p['y'].sum()) for p in groups[s])} for s in groups}
        print('Development support', json.dumps(support), flush=True)
        xt, yt, wt, rt = data['train']; xc, yc, wc, rc = data['calibration']; xs, ys, ws, rs = data['selection']
        rates = [float(np.average(yt[xt[:, 0] == v], weights=wt[xt[:, 0] == v])) for v in (0, 1)]
        base = lambda x: np.asarray(rates)[x[:, 0].astype(int)]
        offset_allowed = bool(yc.sum() >= 50 and (1 - yc).sum() >= 50 and support['calibration']['positiveEvents'] >= 5)
        fs_cols = {'base': list(range(NB)), 'directional': list(range(NB + len(dirfeat.EXTRA_FEATURES)))}
        cal_rank = {c: i for i, c in enumerate(CALIBRATIONS)}
        candidates = []; models = {}
        for fs in cfg['featureSet']:
            cols = fs_cols[fs]
            for leaves in cfg['maxLeafNodes']:
                m = HistGradientBoostingClassifier(max_iter=cfg['maxIter'], max_leaf_nodes=leaves, learning_rate=cfg['learningRate'], min_samples_leaf=cfg['minSamplesLeaf'],
                                                   l2_regularization=cfg['l2Regularization'], early_stopping=False, random_state=cfg['randomState']).fit(xt[:, cols], yt, sample_weight=wt)
                models[fs, leaves] = m
                rc_, rs_ = m.predict_proba(xc[:, cols])[:, 1], m.predict_proba(xs[:, cols])[:, 1]
                off = fit_offset(yc, rc_, wc, offset_allowed)
                for calib in CALIBRATIONS:
                    if calib == 'offset-component' and not offset_allowed: continue
                    for tw in cfg['treeWeights']:
                        if calib == 'platt-final':
                            ab = dirfeat.platt_fit(yc, tw * rc_ + (1 - tw) * base(xc), wc)
                            ps = dirfeat.platt_apply(tw * rs_ + (1 - tw) * base(xs), ab); spec = {'offset': 0.0, 'platt': list(ab)}
                        else:
                            off_ = off if calib == 'offset-component' else 0.0
                            ps = tw * expit(logit(np.clip(rs_, 1e-6, 1 - 1e-6)) + off_) + (1 - tw) * base(xs); spec = {'offset': float(off_), 'platt': None}
                        candidates.append({'featureSet': fs, 'leaves': leaves, 'calibration': calib, 'treeWeight': tw, **spec,
                                           'selectionBrier': float(brier_score_loss(ys, ps, sample_weight=ws)),
                                           'selectionPrAuc': float(average_precision_score(ys, ps, sample_weight=ws))})
                print('fitted', fs, leaves, flush=True)
        key = lambda c: (round(c['selectionBrier'], 12), c['featureSet'] != 'base', c['leaves'], cal_rank[c['calibration']], c['treeWeight'])
        winner = min(candidates, key=key); cols = fs_cols[winner['featureSet']]; model = models[winner['featureSet'], winner['leaves']]
        exported = tree_export(model) | {'schemaVersion': 3, 'id': 'ember-day-ahead-n20-v1', 'sensor': 'VIIRS NOAA-20',
                                         'features': train.FEATURES + (dirfeat.EXTRA_FEATURES if winner['featureSet'] == 'directional' else []),
                                         'calibration': {'slope': 1., 'intercept': winner['offset']}, 'finalCalibration': winner['platt'],
                                         'baselineRates': rates, 'mixture': {'treeWeight': winner['treeWeight'], 'baselineFeatureIndex': 0, 'baselineRates': rates}}
        # Exported-model parity with the in-memory winner on selection.
        raw = model.predict_proba(xs[:, cols])[:, 1]; tw = winner['treeWeight']
        direct = dirfeat.platt_apply(tw * raw + (1 - tw) * base(xs), winner['platt']) if winner['platt'] else tw * expit(logit(np.clip(raw, 1e-6, 1 - 1e-6)) + winner['offset']) + (1 - tw) * base(xs)
        parity = float(np.max(np.abs(predict_exported(exported, xs) - direct)))
        if parity > 1e-9: raise ValueError(f'Exported model parity failure {parity}')
        logistic = make_pipeline(SimpleImputer(add_indicator=True), StandardScaler(), LogisticRegression(max_iter=2000, C=.1, random_state=42))
        logistic.fit(xt[:, :NB], yt, logisticregression__sample_weight=wt)
        v2_model = json.loads((v2 / 'artifacts/model.json').read_text())
        scorers = {'model': lambda x: predict_exported(exported, x), 'smoothedPersistence': base, 'persistence': lambda x: x[:, 0].astype(float),
                   'logistic': lambda x: logistic.predict_proba(x[:, :NB])[:, 1], 'snppV2CrossSensor': lambda x: export_predict(v2_model, x[:, :NB])}
        thresholds = {k: threshold(yc, f(xc), wc) for k, f in scorers.items()}
        # Per-scorer new-cell alert thresholds: event-weighted calibration quantile, frozen here.
        newcell_thresholds = {k: weighted_quantile(f(xc)[rc == 0], wc[rc == 0], 1 - amendment['newCellAlertBudget']) for k, f in scorers.items()}
        newcell_thr = newcell_thresholds['model']
        exported |= {'threshold': thresholds['model'], 'newCellAlertThreshold': newcell_thr}
        (out / 'model.json').write_text(json.dumps(exported, separators=(',', ':'), allow_nan=False))
        with open(out / 'logistic.pkl', 'wb') as f: pickle.dump(logistic, f)
        (out / 'baseline-rates.json').write_text(json.dumps(rates))
        sel_metrics = {k: metrics(ys, f(xs), ws, thresholds[k]) for k, f in scorers.items()}
        selection = {'protocolSha256': sha(n20 / 'protocol.json'), 'amendmentSha256': sha(n20 / 'amendment-1.json'),
                     'modelSha256': sha(out / 'model.json'), 'logisticSha256': sha(out / 'logistic.pkl'), 'baselineRatesSha256': sha(out / 'baseline-rates.json'),
                     'snppV2ModelSha256': sha(v2 / 'artifacts/model.json'), 'exportParityMaxAbs': parity,
                     'winner': winner, 'candidates': candidates, 'support': support, 'skipped': skipped, 'offsetAllowed': offset_allowed,
                     'thresholds': thresholds, 'newCellThresholds': newcell_thresholds, 'selectionMetrics': sel_metrics,
                     'selectionNewCells': {k: newcell_report(ys, f(xs), ws, rs, newcell_thresholds[k]) for k, f in scorers.items()},
                     'holdoutOpened': False, 'frozenAt': datetime.now(timezone.utc).isoformat()}
        (out / 'selection.json').write_text(json.dumps(selection, indent=2))
        print('SELECTION FROZEN', json.dumps(winner), 'modelSHA256', selection['modelSha256'], 'parity', parity, flush=True)
        for k, v in sel_metrics.items(): print(f"  {k:22s} selBrier {v['brier']:.5f} selPR {v['prAuc']:.4f}")
        print('  new cells (model)', json.dumps(selection['selectionNewCells']['model']))
        return

    # ---------------- holdout stage: one shot ----------------
    dry = a.dry_run_on_selection
    eval_path = (dry / 'evaluation-dryrun.json') if dry else (out / 'evaluation.json')
    if eval_path.exists(): raise SystemExit('Holdout already evaluated; one-shot only')
    selection = json.loads((out / 'selection.json').read_text())
    checks = {'amendmentSha256': sha(n20 / 'amendment-1.json'), 'modelSha256': sha(out / 'model.json'), 'logisticSha256': sha(out / 'logistic.pkl'),
              'baselineRatesSha256': sha(out / 'baseline-rates.json'), 'snppV2ModelSha256': sha(v2 / 'artifacts/model.json')}
    for k, v in checks.items():
        if selection[k] != v: raise ValueError(f'{k} changed after selection freeze')
    amendment2 = json.loads((n20 / 'amendment-2.json').read_text())
    if amendment2['amendment1Sha256'] != sha(n20 / 'amendment-1.json') or amendment2['selectionSha256'] != sha(out / 'selection.json'):
        raise ValueError('Amendment 2 does not match the frozen amendment 1 / selection')
    # Amendment 2 supersedes amendment 1's code hashes (the evaluator gained the candidate hierarchy).
    for name, digest in amendment2['codeSha256'].items():
        if sha(Path(__file__).resolve().parent / name) != digest: raise ValueError(f'Evaluator/feature code changed after amendment 2: {name}')
    if dry:
        dry.mkdir(parents=True, exist_ok=True)
        hold_events = dev['selection']; clusters = [[e['event']] for e in hold_events]
    else:
        hold_ready = json.loads((n20 / 'holdout-data/ready-events.json').read_text())
        plan = {e['event']: e for e in json.loads((n20 / 'holdout-plan.json').read_text())['selectionDetails']}
        hold_events = []
        for e in hold_ready['events']:
            if e['event'] not in amendment['holdoutEvents']: continue
            assert [f['name'] for f in e['files']] == [f['name'] for f in plan[e['event']]['files']], 'holdout files differ from plan'
            for f in e['files']:
                if sha(Path(f['path'])) != f['sha256']: raise ValueError('Holdout file changed after download verification')
            hold_events.append(e)
        if sorted(x['event'] for x in hold_events) != sorted(amendment['holdoutEvents']): raise ValueError('Holdout download incomplete')
        clusters = [c for c in amendment['holdoutBootstrapClusters']]
    opened_at = datetime.now(timezone.utc).isoformat()
    wanted = {Path(f['name']).stem for e in hold_events for f in e['files']}
    points = load_firms(n20 / 'firms', protocol, wanted)
    groups, skipped = build({'holdout': hold_events}, boundaries, points)
    evs = groups['holdout']
    eligible_ids = {p['event'] for p in evs}
    eligible_clusters = [[e for e in c if e in eligible_ids] for c in clusters]; eligible_clusters = [c for c in eligible_clusters if c]
    model = json.loads((out / 'model.json').read_text()); rates = np.asarray(json.loads((out / 'baseline-rates.json').read_text()))
    with open(out / 'logistic.pkl', 'rb') as f: logistic = pickle.load(f)
    v2_model = json.loads((v2 / 'artifacts/model.json').read_text())
    scorers = {'model': lambda x: predict_exported(model, x), 'smoothedPersistence': lambda x: rates[x[:, 0].astype(int)],
               'persistence': lambda x: x[:, 0].astype(float), 'logistic': lambda x: logistic.predict_proba(x[:, :NB])[:, 1],
               'snppV2CrossSensor': lambda x: export_predict(v2_model, x[:, :NB])}
    evaluation = {'openedAt': opened_at, 'selectionSha256': sha(out / 'selection.json'), 'skipped': skipped,
                  'eligibleEvents': len(evs), 'eligibleClusters': len(eligible_clusters)}
    rule = amendment['insufficientData']
    if len(eligible_clusters) < rule['minEligibleClusters']:
        evaluation |= {'result': 'inconclusive', 'reason': f'only {len(eligible_clusters)} eligible clusters', 'gate': {'passed': False}}
        eval_path.write_text(json.dumps(evaluation, indent=2)); print(json.dumps(evaluation, indent=2)); return
    x, y, w = arrays(evs); r = np.concatenate([p['recent'] for p in evs])
    ev_index = np.concatenate([np.full(len(p['y']), i) for i, p in enumerate(evs)]); id_to_i = {p['event']: i for i, p in enumerate(evs)}
    preds = {k: f(x) for k, f in scorers.items()}
    th = selection['thresholds']
    evaluation['holdout'] = {k: metrics(y, p, w, th[k]) for k, p in preds.items()}
    # Thresholds come only from selection.json (calibration-derived); nothing is fitted on the holdout.
    evaluation['holdoutNewCells'] = {k: newcell_report(y, p, w, r, selection['newCellThresholds'][k]) for k, p in preds.items()}
    if not y[r == 0].any() and rule.get('requireNewCellPositives'):
        evaluation['result'] = 'inconclusive'; evaluation['reason'] = 'no new-cell positives'
    candidates = amendment2['candidates']  # ordered hierarchy: primary first
    pairs = [(c['scorer'], k) for c in candidates for k in preds if k != c['scorer']]
    rng = np.random.default_rng(protocol['seed']); boots = {p: {'brier': [], 'prAuc': []} for p in pairs}; undefined = 0
    cluster_rows = [np.concatenate([np.flatnonzero(ev_index == id_to_i[e]) for e in c]) for c in eligible_clusters]
    for _ in range(1000):
        ii = np.concatenate([cluster_rows[j] for j in rng.integers(0, len(cluster_rows), len(cluster_rows))])
        yy, ww = y[ii], w[ii]
        b = {k: brier_score_loss(yy, p[ii], sample_weight=ww) for k, p in preds.items()}
        ap_ = {k: average_precision_score(yy, p[ii], sample_weight=ww) for k, p in preds.items()} if yy.any() else None
        if ap_ is None: undefined += 1
        for c, k in pairs:
            boots[c, k]['brier'].append(b[c] - b[k])
            if ap_ is not None: boots[c, k]['prAuc'].append(ap_[c] - ap_[k])
    q = lambda v: [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))] if v else None
    evaluation['pairedDeltas'] = {f'{c} minus {k}': {'brierDelta95': q(v['brier']), 'prAucDelta95': q(v['prAuc'])} for (c, k), v in boots.items()}
    evaluation['undefinedPrAucDraws'] = undefined
    h = evaluation['holdout']; inconclusive = evaluation.get('result') == 'inconclusive'
    gates = []
    for c in candidates:
        s, g = c['scorer'], c['gate']
        ok = all(h[s]['brier'] < h[k]['brier'] for k in g['brierStrictlyBelow']) and all(h[s]['prAuc'] >= h[k]['prAuc'] for k in g['prAucAtLeast'])
        gates.append({'candidate': s, 'role': c['role'], 'passed': bool(ok and not inconclusive), 'rule': g})
    evaluation['gates'] = gates
    # Descriptive calibration (no fitting): event-weighted calibration-in-the-large and logit slope per scorer.
    calib = {}
    for k, p in preds.items():
        z = logit(np.clip(p, 1e-6, 1 - 1e-6)); lr = LogisticRegression(C=1e6, max_iter=2000).fit(z[:, None], y, sample_weight=w)
        calib[k] = {'meanPredicted': float(np.average(p, weights=w)), 'observedRate': float(np.average(y, weights=w)),
                    'logitSlope': float(lr.coef_[0, 0]), 'logitIntercept': float(lr.intercept_[0])}
    evaluation['calibrationDescriptive'] = calib
    first = next((g for g in gates if g['passed']), None)
    evaluation['result'] = 'inconclusive' if inconclusive else (f"passed: {first['candidate']} ({first['role']})" if first else 'failed')
    eval_path.write_text(json.dumps(evaluation, indent=2))
    print(json.dumps({k: evaluation[k] for k in ('result', 'eligibleEvents', 'eligibleClusters', 'gates')}, indent=2))
    for k, v in h.items(): print(f"  {k:22s} Brier {v['brier']:.5f} PR {v['prAuc']:.4f}  newCellRecall {evaluation['holdoutNewCells'][k]['recall']:.3f}")


if __name__ == '__main__':
    main()
