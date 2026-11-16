#!/usr/bin/env python3
"""Pre-holdout amendment 1 to ml-n20/protocol.json (Astra review 3, 2026-11-03).

Written BEFORE any holdout TIFF is downloaded or any holdout NOAA-20 label is
rasterized. Reads only development TIFF headers (footprints) and metadata.

Changes:
 1. Footprint separation. 25 km between metadata centers did not separate
    observation areas: development rasters span ~80x110 km and one holdout
    center fell inside 2021 training rasters with overlapping dates. The 2021
    inspected incidents are therefore REMOVED from development (they cannot be
    tested either). Every holdout event must have a conservative box (center
    +/- the largest development center-to-edge extent) disjoint from every
    development raster footprint within +/-30 days (+3-day window allowance).
 2. Bootstrap clusters = connected holdout events whose conservative boxes
    overlap within +/-30 days (replaces 25 km center components).
 3. Full logistic pipeline frozen (pickle) instead of bare coefficients.
 4. Release gate adds the frozen S-NPP v2 cross-sensor baseline to the Brier
    comparisons. New-cell alert budget is an event-weighted 2% of calibration
    new cells, per scorer, frozen at selection; achieved fractions reported.
 5. Insufficient data: fewer than 10 eligible holdout clusters, or no new-cell
    positives, is reported as inconclusive and fails the gate.
 6. Evaluator and feature-builder source hashes frozen here.
Usage: python amend_n20.py --n20 ../../../ml-n20 --v2 ../../../ml-v2
"""
import argparse, json, math
from datetime import date, datetime, timezone
from pathlib import Path
import tifffile
from pyproj import Transformer
from train_v2 import sha

WINDOW_DAYS = 30


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--n20', type=Path, required=True); ap.add_argument('--v2', type=Path, required=True)
    a = ap.parse_args(); n20 = a.n20.resolve(); v2 = a.v2.resolve()
    if (n20 / 'amendment-1.json').exists(): raise SystemExit('Amendment 1 already frozen')
    if (n20 / 'holdout-data').exists(): raise SystemExit('Holdout data present; amendment must precede holdout access')
    protocol = json.loads((n20 / 'protocol.json').read_text())
    ready = {e['event']: e for e in json.loads((v2 / 'data/ready-events.json').read_text())['events']}
    plan_v2 = {e['event']: e for e in json.loads((v2 / 'plan.json').read_text())['selectionDetails']}
    hold = json.loads((n20 / 'holdout-plan.json').read_text())['selectionDetails']
    dev_splits = {s: [e for e in evs if not e.startswith('2021/')] for s, evs in protocol['developmentSplits'].items()}
    dev_events = [e for evs in dev_splits.values() for e in evs]

    to_geo = Transformer.from_crs(32610, 4326, always_xy=True); to_grid = Transformer.from_crs(4326, 32610, always_xy=True)
    footprints = []; extent = 0.0
    for ev in sorted(ready):  # all v2 rasters, for the conservative extent; only development ones for separation
        e = ready[ev]
        with tifffile.TiffFile(e['files'][0]['path']) as f:
            pg = f.pages[0]; geo = f.geotiff_metadata
            h, w = (pg.shape[-2:] if pg.shape[0] == 23 else pg.shape[:2])
        ox, oy = geo['ModelTiepoint'][3:5]
        c = plan_v2[ev]['metadataCenter']; cx, cy = to_grid.transform(c[1], c[0])
        extent = max(extent, abs(cx - ox), abs(cx - (ox + w * 375)), abs(cy - oy), abs(cy - (oy - h * 375)))
        if ev in dev_events:
            lon, lat = to_geo.transform([ox, ox + w * 375, ox, ox + w * 375], [oy - h * 375, oy - h * 375, oy, oy])
            footprints.append({'event': ev, 'bbox': [min(lon), max(lon), min(lat), max(lat)], 'start': Path(e['files'][0]['name']).stem})
    R = extent / 1000

    def box(e):
        lat, lon = e['metadataCenter']; dlat = R / 111.2; dlon = R / (111.2 * math.cos(math.radians(lat)))
        return [lon - dlon, lon + dlon, lat - dlat, lat + dlat]
    overlap = lambda b, c: not (b[1] < c[0] or b[0] > c[1] or b[3] < c[2] or b[2] > c[3])
    start = lambda e: date.fromisoformat(Path(e['files'][0]['name']).stem)
    keep, conflicts = [], {}
    for e in hold:
        b = box(e); s = start(e)
        bad = [f['event'] for f in footprints if overlap(b, f['bbox']) and abs((s - date.fromisoformat(f['start'])).days) <= WINDOW_DAYS + 3]
        (conflicts.__setitem__(e['event'], bad) if bad else keep.append(e['event']))
    kept = [e for e in hold if e['event'] in keep]
    left = list(kept); clusters = []
    while left:
        g = [left.pop(0)]; i = 0
        while i < len(g):
            nb = [e for e in left if overlap(box(e), box(g[i])) and abs((start(e) - start(g[i])).days) <= WINDOW_DAYS + 3]
            for e in nb: left.remove(e); g.append(e)
            i += 1
        clusters.append(sorted(x['event'] for x in g))
    here = Path(__file__).resolve().parent
    amendment = {
        'id': 'ember-day-ahead-n20-amendment-1', 'createdAt': datetime.now(timezone.utc).isoformat(),
        'protocolSha256': sha(n20 / 'protocol.json'), 'holdoutAccessed': False,
        'reason': 'Astra pre-holdout audit: 25 km center embargo did not separate ~80x110 km observation footprints; logistic baseline not fully frozen; gate/threshold semantics; evaluator not implemented.',
        'developmentSplits': dev_splits, 'removedFromDevelopment': sorted(set(e for evs in protocol['developmentSplits'].values() for e in evs) - set(dev_events)),
        'footprintRule': f'Holdout center +/- {R:.1f} km box (largest development center-to-edge extent) must not intersect any development raster footprint whose window starts within +/-{WINDOW_DAYS} (+3) days.',
        'conservativeHalfExtentKm': R, 'holdoutEvents': sorted(keep), 'holdoutFootprintConflicts': conflicts,
        'holdoutBootstrapClusters': clusters,
        'newCellAlertBudget': 0.02,
        'releaseGate': {'brierStrictlyBelow': ['smoothedPersistence', 'logistic', 'snppV2CrossSensor'], 'prAucAtLeast': ['smoothedPersistence'],
                        'note': 'Minimum retrospective screen, not authorization for live probabilities; live feed/feature parity must be validated separately.'},
        'insufficientData': {'minEligibleClusters': 10, 'requireNewCellPositives': True},
        'codeSha256': {n: sha(here / n) for n in ('train_n20.py', 'experiment_v3_dev.py', 'train.py', 'train_v2.py')},
        'supersededSelection': 'Pre-amendment selection (2021 incidents in training) archived under artifacts/superseded-pre-amendment; never evaluated on holdout.',
    }
    (n20 / 'amendment-1.json').write_text(json.dumps(amendment, indent=2))
    print(json.dumps({'amendmentSha256': sha(n20 / 'amendment-1.json'), 'halfExtentKm': round(R, 1), 'holdoutKept': len(keep), 'conflicts': len(conflicts),
                      'bootstrapClusters': len(clusters), 'developmentCounts': {k: len(v) for k, v in dev_splits.items()}}, indent=2))


if __name__ == '__main__':
    main()
