#!/usr/bin/env python3
"""Per-platform cell-month daily occupancy masks from the per-sensor-year aggregates.

Platforms are kept separate (Astra review 13): 0 Terra, 1 Aqua, 2 Suomi NPP, 3 NOAA-20.
Quality filter (default harmonization input): MODIS confidence >= 30, VIIRS nominal/high (class >= 1).
All-confidence masks are also written for a sensitivity analysis.
Outputs (global-firms/plat):
  {variant}_{platform}_{year}.parquet  columns cx, cy, m, days (uint32 day-of-month bitmask), n (detections)
  daily_{variant}.json                 global occupied 5 km cells per platform per day (availability evidence)
Usage: python build_platform_masks.py GLOBAL_FIRMS_DIR
"""
import json, sys
from pathlib import Path
import numpy as np
import pandas as pd

root = Path(sys.argv[1]); agg, out = root / 'agg', root / 'plat'; out.mkdir(exist_ok=True)
NAMES = {0: 'terra', 1: 'aqua', 2: 'snpp', 3: 'noaa20', 4: 'noaa21'}
VARIANTS = {'q': 1, 'all': 0}  # minimum confidence class
daily = {v: {} for v in VARIANTS}
for v in VARIANTS:
    p = out / f'daily_{v}.json'
    if p.exists(): daily[v] = json.loads(p.read_text())

for f in sorted(agg.glob('*.parquet')):
    if f.stem.endswith('_static'): continue  # static-source cells, not detections
    sensor, year = f.stem.rsplit('_', 1)
    sats = (0, 1) if sensor == 'modis' else (2,) if sensor == 'viirs-snpp' else (4,) if sensor == 'viirs-jpss2' else (3,)
    outs = [out / f'{v}_{NAMES[s]}_{year}.parquet' for v in VARIANTS for s in sats]
    # Up to date only if every output exists and is newer than its input (a backfilled or re-aggregated year is rebuilt).
    if all(o.exists() and o.stat().st_mtime >= f.stat().st_mtime for o in outs) and all(any(k.startswith(f'{year}-') for k in daily[v].get(NAMES[s], {})) for v in VARIANTS for s in sats): continue
    for v in VARIANTS:  # drop this year's stale per-day counts before recomputing them
        for s in sats: daily[v][NAMES[s]] = {k: c for k, c in daily[v].get(NAMES[s], {}).items() if not k.startswith(f'{year}-')}
    for o in outs: o.unlink(missing_ok=True)
    d = pd.read_parquet(f, columns=['cx', 'cy', 'm', 'sat', 'conf', 'days', 'n'])
    for v, minc in VARIANTS.items():
        x = d[d['conf'] >= minc]
        for sat, g in x.groupby('sat'):
            g = g.sort_values(['cx', 'cy', 'm'])
            key = g[['cx', 'cy', 'm']].to_numpy()
            change = np.ones(len(g), bool); change[1:] = (key[1:] != key[:-1]).any(axis=1)
            starts = np.flatnonzero(change)
            days = np.bitwise_or.reduceat(g['days'].to_numpy(), starts)
            n = np.add.reduceat(g['n'].to_numpy(), starts)
            res = pd.DataFrame({'cx': key[starts, 0], 'cy': key[starts, 1], 'm': key[starts, 2].astype(np.int16), 'days': days.astype(np.uint32), 'n': n.astype(np.uint32)})
            res.to_parquet(out / f'{v}_{NAMES[int(sat)]}_{year}.parquet', index=False)
            # Global occupied cells per day: count masks with bit d set, per month.
            per = daily[v].setdefault(NAMES[int(sat)], {})
            for m, mg in res.groupby('m'):
                bits = mg['days'].to_numpy()
                y, mo = 2000 + int(m) // 12, int(m) % 12 + 1
                ndays = pd.Period(f'{y}-{mo:02d}').days_in_month
                for day in range(ndays):
                    per[f'{y}-{mo:02d}-{day + 1:02d}'] = int(((bits >> np.uint32(day)) & np.uint32(1)).sum())
    for v in VARIANTS: (out / f'daily_{v}.json').write_text(json.dumps(daily[v], separators=(',', ':')))
    print('masks', f.stem, flush=True)
print('done', {v: {k: len(x) for k, x in daily[v].items()} for v in VARIANTS})
