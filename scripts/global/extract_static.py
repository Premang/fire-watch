#!/usr/bin/env python3
"""Backfill static-source cells (FIRMS type 1 volcano, type 2 static land source) for zips aggregated before
aggregate_global.py recorded them. Output: AGG/{sensor}_{year}_static.parquet (cx, cy, type, n).
Usage: python extract_static.py ZIPS_DIR AGG_DIR"""
import re, sys, zipfile
from pathlib import Path
import numpy as np, pandas as pd
R, COS30 = 6371.0, np.cos(np.pi / 6)
zips, agg = Path(sys.argv[1]), Path(sys.argv[2])
for z in sorted(zips.glob('*_all_countries.zip')):
    sensor, year = re.match(r'(.+)_(\d{4})_all_countries\.zip', z.name).groups()
    out = agg / f'{sensor}_{year}_static.parquet'
    if out.exists() or not (agg / f'{sensor}_{year}.parquet').exists(): continue
    parts = []
    with zipfile.ZipFile(z) as zf:
        for n in zf.namelist():
            if not n.endswith('.csv'): continue
            with zf.open(n) as f: df = pd.read_csv(f, usecols=['latitude', 'longitude', 'type'], dtype={'latitude': 'float64', 'longitude': 'float64', 'type': 'Int8'})
            st = df[df['type'].isin([1, 2])]
            if len(st):
                lat, lon = st['latitude'].to_numpy(), st['longitude'].to_numpy()
                parts.append(pd.DataFrame({'cx': np.floor(R * np.radians(lon) * COS30 / 5).astype(np.int16), 'cy': np.floor(R * np.sin(np.radians(lat)) / COS30 / 5).astype(np.int16), 'type': st['type'].to_numpy().astype(np.int8)}))
    if parts:
        pd.concat(parts).groupby(['cx', 'cy', 'type'], as_index=False).size().rename(columns={'size': 'n'}).to_parquet(out, index=False)
        print('static', z.name, flush=True)
