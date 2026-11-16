#!/usr/bin/env python3
"""Freeze the NOAA-20 (VIIRS JPSS-1) day-ahead experiment BEFORE any NOAA-20
fire mask is built or any new outcome is inspected.

Metadata only: reads WSTS event coordinates, the archive byte index, the v1/v2
plans and the FIRMS file checksums. It never opens a TIFF or a FIRMS row.

Design (follows v2/noaa20-next-experiment.txt and the Astra review, 2026-11-03):
  * Development reuses all 250 v2 events with labels and fire inputs REBUILT from
    NOAA-20 points; WSTS weather/terrain TIFFs are reused. Inspected v2-test 2021
    incidents join TRAINING (more support; they can no longer be a test).
  * A fresh untouched 2021 holdout is drawn by metadata only, >=25 km from every
    v1/v2-inspected 2021 incident and from every development event.
  * Windows before NOAA-20 coverage (2018-04-01) are unavailable, never empty.
Usage: python freeze_n20.py --research ../../../ml-research --v2 ../../../ml-v2 --firms ../../../ml-n20/firms --out ../../../ml-n20
"""
import argparse, hashlib, json, math, random, re
from datetime import date, timedelta, datetime, timezone
from pathlib import Path

SEED = 20261103
N20_START = date(2018, 4, 1)
HOLDOUT_EVENTS = 50
EMBARGO_KM = 25


def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    for k in ('research', 'v2', 'firms', 'out'): ap.add_argument('--' + k, type=Path, required=True)
    a = ap.parse_args(); a.out.mkdir(parents=True, exist_ok=True)
    if (a.out / 'protocol.json').exists(): raise SystemExit('Already frozen; refusing to change the existing protocol')
    index = json.loads((a.research / 'wfts-data/archive-index.json').read_text())['entries']
    meta = {}
    for year in range(2018, 2022):
        for m in re.finditer(r'(fire_\d+):\n  latitude: ([\d.-]+)\n  longitude: ([\d.-]+)', (a.research / f'wfts-events-{year}.yml').read_text()):
            meta[f'{year}/{m[1]}'] = (float(m[2]), float(m[3]))
    files = {}
    for name, v in index.items():
        if v['bytes'] <= 12_000_000 and v['compressedBytes'] <= 12_000_000:
            files.setdefault('/'.join(name.split('/')[:2]), []).append(name)
    windows = {}
    for event, names in sorted(files.items()):
        if event not in meta: continue
        lat, lon = meta[event]
        if not (24 <= lat <= 50 and -125 <= lon <= -66): continue
        dates = sorted(date.fromisoformat(Path(n).stem) for n in names); have = set(dates)
        starts = [d for d in dates if d >= N20_START and all(d + timedelta(days=i) in have for i in range(4))]
        if starts: windows[event] = starts

    def dist(e, f):
        (la, lo), (lb, lb2) = meta[e], meta[f]
        return math.hypot((la - lb) * 111.2, (lo - lb2) * 111.2 * math.cos(math.radians((la + lb) / 2)))
    near = lambda e, f: dist(e, f) < EMBARGO_KM

    def components(events):
        left = sorted(events); groups = []
        while left:
            g = [left.pop(0)]; i = 0
            while i < len(g):
                nb = [e for e in left if near(e, g[i])]
                for e in nb: left.remove(e); g.append(e)
                i += 1
            groups.append(sorted(g))
        return groups

    v1_plan = json.loads((a.research / 'wfts-subset-plan.json').read_text())
    v2_plan = json.loads((a.v2 / 'plan.json').read_text()); v2_protocol = json.loads((a.v2 / 'protocol.json').read_text())
    inspected_2021 = sorted({e['event'] for e in v1_plan['selectionDetails'] if e['event'].startswith('2021/')} |
                            {e['event'] for e in v2_plan['selectionDetails'] if e['event'].startswith('2021/')})
    development = {e['event']: e for e in v2_plan['selectionDetails']}
    # Development split mapping: inspected v2 test incidents join training.
    dev_split = {ev: ('train' if d['split'] == 'test' else d['split']) for ev, d in development.items()}
    unavailable = sorted(ev for ev, d in development.items() if date.fromisoformat(Path(d['files'][0]['name']).stem) < N20_START)

    pool = [e for e in windows if e.startswith('2021/') and e not in development
            and all(not near(e, o) for o in inspected_2021) and all(not near(e, d) for d in development)]
    rng = random.Random(SEED)
    groups = components(pool); rng.shuffle(groups)
    holdout = []
    for g in groups:
        if len(holdout) + len(g) <= HOLDOUT_EVENTS: holdout.extend(g)
        if len(holdout) == HOLDOUT_EVENTS: break
    if len(holdout) != HOLDOUT_EVENTS: raise ValueError(f'Only {len(holdout)} fresh separated 2021 holdout events available')
    for h in holdout:
        assert all(not near(h, o) for o in inspected_2021 + list(development))

    details = []
    for e in sorted(holdout):
        local = random.Random(hashlib.sha256(f'{SEED}:{e}'.encode()).hexdigest())
        d = local.choice(windows[e]); names = [f'{e}/{d + timedelta(days=i)}.tif' for i in range(4)]
        entries = [{'name': n, **index[n]} for n in names]
        details.append({'event': e, 'split': 'holdout', 'metadataCenter': list(meta[e]), 'files': entries,
                        'compressedBytes': sum(v['compressedBytes'] for v in entries)})
    plan = {'schemaVersion': 3, 'seed': SEED, 'events': len(details), 'files': len(details) * 4,
            'compressedBytes': sum(e['compressedBytes'] for e in details),
            'selection': 'Metadata-only random 2021 incident clusters (25 km connected metadata centers) and one uniformly random four-consecutive-day window per event on or after NOAA-20 coverage start. No fire labels of any sensor used; no replacement after eligibility filtering.',
            'splits': {'holdout': [2021]}, 'selectionDetails': details}
    (a.out / 'holdout-plan.json').write_text(json.dumps(plan, indent=2))
    firms_sums = (a.firms / 'SHA256SUMS').read_text()

    protocol = {
        'id': 'ember-day-ahead-n20-frozen-20261103', 'createdAt': datetime.now(timezone.utc).isoformat(), 'seed': SEED,
        'sensor': 'VIIRS NOAA-20 (JPSS-1), FIRMS standard archive country files, version 2',
        'firmsFiles': {line.split()[1]: line.split()[0] for line in firms_sums.strip().splitlines()},
        'holdoutPlanSha256': digest(a.out / 'holdout-plan.json'), 'v2PlanSha256': digest(a.v2 / 'plan.json'),
        'v2ProtocolSha256': digest(a.v2 / 'protocol.json'), 'sourceIndexSha256': digest(a.research / 'wfts-data/archive-index.json'),
        'developmentSplits': {s: sorted(ev for ev, v in dev_split.items() if v == s and ev not in unavailable) for s in ('train', 'selection', 'calibration')},
        'developmentUnavailableBeforeN20': unavailable,
        'inspected2021Excluded': inspected_2021, 'spatialEmbargoKm': EMBARGO_KM,
        'holdoutClusters': components(holdout), 'holdoutCandidatePoolEvents': len(pool),
        'labels': {
            'source': 'FIRMS VIIRS NOAA-20 375 m points; acq_date is the UTC day.',
            'filter': 'confidence in {n, h} (low excluded); type == 0 (presumed vegetation fire); day and night overpasses both kept.',
            'raster': "Each point is projected to the event TIFF CRS and assigned to the 1.5 km block containing its center, using the same origin and the same 4x4 truncation as train.block(). A block is positive if it contains >=1 point. Point footprints are not expanded.",
            'days': 'prior = window day 0, recent = day 1 (issue I-1), target = day 3 (I+1). Weather/terrain/GFS bands from WSTS TIFFs unchanged.',
            'crossBorder': 'US country files omit Canadian/Mexican detections; cells are already CONUS-only. Events with metadata center within 25 km of the international border are reported as a subgroup; not excluded.',
        },
        'eligibility': 'Identical to v2 (CONUS, <=12 km from NOAA-20 recent fire, 3-cell border, all features finite) using NOAA-20 recent fire. No recent NOAA-20 detections -> skipped, no replacement. Never filter on target labels.',
        'featureSets': {'base': '25 v2 features computed from NOAA-20 prior/recent masks',
                        'directional': 'base + downwind_km, crosswind_km, upslope_km, upwind_fire_density, front_expansion_7 as in experiment_v3_dev.py (grid-convergence corrected, bilinear upwind sampling, flat-terrain upslope = 0)'},
        'candidates': {'featureSet': ['base', 'directional'], 'maxLeafNodes': [7, 15, 31], 'maxIter': 120, 'learningRate': 0.06, 'minSamplesLeaf': 40,
                       'l2Regularization': 5, 'randomState': 42, 'calibration': ['identity', 'offset-component', 'platt-final'], 'treeWeights': [0, 0.25, 0.5, 0.75, 1],
                       'calibrationFit': 'Calibration split only. offset-component as v2. platt-final: sigmoid(a*logit(blend)+b), a>0, event-weighted log loss + 1e-3*(log(a)^2+b^2).',
                       'selection': 'Lowest event-weighted selection Brier; ties: base before directional, fewer leaves, identity < offset-component < platt-final, lower tree weight.'},
        'baselines': ['NOAA-20 train-fitted smoothed persistence', 'NOAA-20 hard persistence', 'NOAA-20 train-fitted logistic (imputed, standardized, C=0.1, base features)',
                      'Released S-NPP v2 scored on NOAA-20 inputs (cross-sensor baseline only, not a validated comparator)'],
        'thresholds': 'Operating threshold maximizes CALIBRATION-split F1 on the v2 grid. New-cell alert threshold: the score at which 2% of calibration new cells (recent=0) are alerted. Thresholds do not affect the release gate.',
        'weighting': 'Each eligible event equal total weight. No negative downsampling.',
        'uncertainty': '1000 seeded paired bootstrap resamples of whole holdout clusters.',
        'releaseGate': 'NOAA-20 model eligible only if holdout event-weighted Brier is strictly lower than BOTH NOAA-20 smoothed persistence and NOAA-20 logistic AND holdout PR-AUC >= NOAA-20 smoothed persistence. Point estimates gate; improvement claims need paired intervals. If failed, the live app keeps abstaining; no test-guided changes.',
        'holdoutAccess': 'Holdout TIFFs are downloaded and its NOAA-20 labels rasterized only after selection.json is frozen. One-shot; no replacement or tuning afterwards.',
        'limitations': [
            'Reuses WSTS event selection (S-NPP-based), so claims are limited to those sampled contexts.',
            'Holdout shares calendar year 2021 with training incidents; separated by >=25 km metadata centers, not by time.',
            'Historical science-quality NOAA-20 product differs from the near-real-time live feed; live parity must be validated separately.',
            'Missing NOAA-20 detections are not proof of clear-sky observation or an unburned cell.',
            'Single four-day window per event; more issue days per incident remain future work.'],
    }
    (a.out / 'protocol.json').write_text(json.dumps(protocol, indent=2))
    print(json.dumps({'protocolSha256': digest(a.out / 'protocol.json'), 'holdoutEvents': len(details), 'holdoutClusters': len(protocol['holdoutClusters']),
                      'holdoutCandidatePool': len(pool), 'holdoutCompressedBytes': plan['compressedBytes'],
                      'developmentCounts': {k: len(v) for k, v in protocol['developmentSplits'].items()}, 'unavailableBeforeN20': len(unavailable)}, indent=2))


if __name__ == '__main__':
    main()
