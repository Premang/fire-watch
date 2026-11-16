#!/usr/bin/env python3
"""Spread-metric baselines at native 375 m on WSTS DEVELOPMENT windows (no fitting, no holdout).

Each 4-day window d0..d3: the 'current fire' is the d2 active-fire mask; the forecast target is d3.
  footprint  C2 = d0|d1|d2 (burned so far in the window), C3 = C2|d3
  new growth G  = d3 & ~C2 (fire tomorrow where there was none in the window so far)
Baselines (all label-free rules):
  persistence        : tomorrow's footprint = today's footprint (no growth)
  dilate-k           : spread zone = cells within k pixels (k*375 m) of today's fire, outside C2
  wind-k             : as dilate-k, but beyond 1 pixel only cells within +/-60 deg of downwind
Reported, so the '90%' definitions can be compared on real numbers:
  footprint Dice/IoU, spread-zone coverage of new growth (recall) with zone precision and area,
  growth F1, and the smallest zone reaching 90% coverage.
Usage: python baselines_375m.py --v2 ../../../ml-v2 --n20 ../../../ml-n20 --out DIR
"""
import argparse, json
from pathlib import Path
import numpy as np
import tifffile
from scipy.ndimage import binary_dilation, distance_transform_edt

KS = (1, 2, 3, 4, 6, 8, 12)


def load(path):
    a = tifffile.imread(path)
    return a if a.shape[-1] == 23 else np.moveaxis(a, 0, -1)


def dice(a, b):
    s = a.sum() + b.sum()
    return 1.0 if s == 0 else 2 * (a & b).sum() / s


def iou(a, b):
    u = (a | b).sum()
    return 1.0 if u == 0 else (a & b).sum() / u


def main():
    ap = argparse.ArgumentParser()
    for k in ('v2', 'n20', 'out'): ap.add_argument('--' + k, type=Path, required=True)
    a = ap.parse_args(); a.out.mkdir(parents=True, exist_ok=True)
    ready = {e['event']: e for e in json.loads((a.v2 / 'data/ready-events.json').read_text())['events']}
    dev = [ev for evs in json.loads((a.n20 / 'amendment-1.json').read_text())['developmentSplits'].values() for ev in evs]
    tot = {}; per_event = []; n_used = 0; n_growth = 0
    def acc(key, **v):
        d = tot.setdefault(key, {}); [d.__setitem__(k, d.get(k, 0) + x) for k, x in v.items()]
    for ev in dev:
        e = ready[ev]; arr = [load(f['path']) for f in e['files']]
        m = [np.isfinite(x[..., 22]) for x in arr]
        if not m[2].any(): continue  # no current fire: outside the spread task
        n_used += 1
        C2 = m[0] | m[1] | m[2]; C3 = C2 | m[3]; G = m[3] & ~C2
        n_growth += bool(G.any())
        acc('persistence', footprintInter=(C2 & C3).sum(), footprintSum=C2.sum() + C3.sum(), footprintUnion=(C2 | C3).sum(), growth=G.sum())
        rec = {'event': ev, 'footprintDicePersistence': dice(C2, C3), 'growthPixels': int(G.sum()), 'footprintPixels': int(C3.sum())}
        # Nearest current-fire pixel for every cell, for the downwind cone.
        dist, idx = distance_transform_edt(~m[2], return_indices=True)
        rows, cols = np.indices(m[2].shape)
        east = cols - idx[1]; north = idx[0] - rows  # displacement from nearest fire (pixels; north = up)
        wfrom = np.radians(np.nan_to_num(arr[2][..., 7], nan=0.0)); wto_e, wto_n = -np.sin(wfrom), -np.cos(wfrom)
        norm = np.hypot(east, north); cosang = np.where(norm > 0, (east * wto_e + north * wto_n) / np.maximum(norm, 1e-9), 1.0)
        for k in KS:
            Z = (dist <= k) & ~C2
            W = Z & ((dist <= 1) | (cosang >= np.cos(np.radians(60))))
            for name, zone in ((f'dilate-{k}', Z), (f'wind-{k}', W)):
                hit = (zone & G).sum(); P = C2 | zone
                acc(name, hit=hit, zone=zone.sum(), growth=G.sum(), footprintInter=(P & C3).sum(), footprintSum=P.sum() + C3.sum(), footprintUnion=(P | C3).sum())
                if k in (2, 4): rec[f'{name}-coverage'] = float(hit / G.sum()) if G.sum() else None
        per_event.append(rec)
    out = {}
    for name, d in tot.items():
        r = {'footprintDice': 2 * d['footprintInter'] / d['footprintSum'], 'footprintIoU': d['footprintInter'] / d['footprintUnion']}
        if 'zone' in d:
            cov = d['hit'] / d['growth']; prec = d['hit'] / d['zone'] if d['zone'] else 0.0
            r |= {'growthCoverage': cov, 'zonePrecision': prec, 'growthF1': 2 * cov * prec / (cov + prec) if cov + prec else 0.0,
                  'zoneKm2PerEvent': d['zone'] * 0.375 ** 2 / n_used}
        out[name] = r
    fp = [r['footprintDicePersistence'] for r in per_event]
    report = {'note': 'Development windows only; WSTS S-NPP active-fire masks at 375 m; no fitting.', 'eventsWithCurrentFire': n_used,
              'eventsWithNewGrowth': n_growth, 'pooled': out,
              'perEventFootprintDicePersistence': {'median': float(np.median(fp)), 'p10': float(np.percentile(fp, 10)), 'p90': float(np.percentile(fp, 90))},
              'smallestZoneReaching90Coverage': next(({'rule': k, **v} for k, v in sorted(out.items(), key=lambda kv: kv[1].get('zoneKm2PerEvent', 1e9)) if v.get('growthCoverage', 0) >= 0.9), None)}
    (a.out / 'spread-baselines-375m.json').write_text(json.dumps(report, indent=2))
    (a.out / 'spread-baselines-375m-events.json').write_text(json.dumps(per_event, indent=1))
    print(json.dumps({k: v for k, v in report.items() if k != 'pooled'}, indent=2))
    for name, v in sorted(out.items(), key=lambda kv: (kv[0].split('-')[0], int(kv[0].split('-')[1]) if '-' in kv[0] else 0)):
        print(f"{name:12s} footprintDice {v['footprintDice']:.3f}  " + (f"coverage {v['growthCoverage']:.3f}  precision {v['zonePrecision']:.3f}  F1 {v['growthF1']:.3f}  zone/event {v['zoneKm2PerEvent']:7.1f} km2" if 'growthCoverage' in v else ''))


if __name__ == '__main__':
    main()
