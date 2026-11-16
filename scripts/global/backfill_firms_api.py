#!/usr/bin/env python3
"""Extend the harmonized record "to the present" with the NASA FIRMS Area API (needs a free MAP_KEY).

The yearly all-countries archive stops at the last complete year; this fills the current year so the
calendar's latest months and "this month vs the historical median" are live. Get a key (email only) at
https://firms.modaps.eosdis.nasa.gov/api/map_key/ and run:

  FIRMS_MAP_KEY=... python backfill_firms_api.py GLOBAL_FIRMS_DIR --from 2026-01-01 [--to YESTERDAY]
  then: build_platform_masks.py, build_products.py, build_web.py (as in the main pipeline; harmonization factors are reused)

For each source and 5-day chunk it requests the whole world (`world` area), applies the same 5 km grid,
confidence classes and day bitmasks as aggregate_global.py, and writes AGG/{sensor}_{year}.parquet
(country = -1). Rows lacking the FIRMS `type` field (near-real-time) are kept only outside the archive's
static-source cells (AGG/*_static.parquet: volcanoes and static land sources such as gas flares).
Standard-processing (SP) sources are preferred; near-real-time (NRT) fills the most recent ~3 months.
Requests are paced and retried; downloaded chunks are cached under GLOBAL_FIRMS_DIR/api-cache.
"""
import argparse, io, os, sys, time, urllib.error, urllib.request
from datetime import date, timedelta
from pathlib import Path
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aggregate_global import aggregate_member, cells  # same grid, confidence classes and bitmask logic

API = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{source}/world/{days}/{date}'
# (archive sensor name, platform satellite code, SP source, NRT source, last valid date)
SOURCES = [('viirs-jpss1', 'N20', 'VIIRS_NOAA20_SP', 'VIIRS_NOAA20_NRT', None),
           ('viirs-jpss2', 'N21', None, 'VIIRS_NOAA21_NRT', None),
           ('viirs-snpp', 'N', 'VIIRS_SNPP_SP', 'VIIRS_SNPP_NRT', date(2026, 11, 2)),
           ('modis', None, 'MODIS_SP', 'MODIS_NRT', None)]


def fetch(url, cache: Path, tries=4):
    if cache.exists(): return cache.read_text()
    i = waits = 0
    while i < tries:
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'EmberAtlas-Research/1.0'}), timeout=180) as r:
                text = r.read().decode('utf-8', 'replace')
            if text.lstrip().startswith('<') or 'Invalid' in text[:200]: raise ValueError(text[:200])
            cache.parent.mkdir(parents=True, exist_ok=True); cache.write_text(text); time.sleep(2.0); return text
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', 'replace')[:200]
            # The key allows 5,000 transactions per 10 minutes and a whole-world request costs many: wait for the window to clear.
            if 'transaction limit' in body and waits < 60: waits += 1; print('rate limit; waiting 90 s', flush=True); time.sleep(90); continue
            i += 1; print('retry', i, url.split('/csv/')[1].split('/', 1)[1], f'HTTP {e.code} {body}'[:120], flush=True); time.sleep(10 * i)
        except (urllib.error.URLError, ValueError, TimeoutError) as e:
            i += 1
            print('retry', i, url.split('/csv/')[1].split('/', 1)[1], str(e)[:120], flush=True); time.sleep(10 * i)
    raise RuntimeError(f'failed: {url}')


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('root', type=Path); ap.add_argument('--from', dest='start', required=True)
    ap.add_argument('--to', dest='end', default=(date.today() - timedelta(days=1)).isoformat()); a = ap.parse_args()
    key = os.environ.get('FIRMS_MAP_KEY', '').strip()
    if not key: sys.exit('Set FIRMS_MAP_KEY (free: https://firms.modaps.eosdis.nasa.gov/api/map_key/).')
    start, end = date.fromisoformat(a.start), date.fromisoformat(a.end)
    agg = a.root / 'agg'; static = set()
    for f in agg.glob('*_static.parquet'):
        s = pd.read_parquet(f); static |= set(zip(s['cx'].astype(int), s['cy'].astype(int)))
    # Ask NASA which dates each source really covers; standard-processing (SP) ends where near-real-time (NRT) begins.
    with urllib.request.urlopen(f'https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/{key}/all', timeout=120) as r:
        avail = {row.split(',')[0]: date.fromisoformat(row.split(',')[2]) for row in r.read().decode().strip().splitlines()[1:]}
    for sensor, sat, sp, nrt, last in SOURCES:
        frames = []
        d = start
        while d <= min(end, last or end):
            span = min(5, (min(end, last or end) - d).days + 1)
            sp_end = avail.get(sp) if sp else None
            if sp_end and d <= sp_end: span = min(span, (sp_end - d).days + 1); src = sp  # never let a chunk straddle the SP/NRT handover
            else: src = nrt
            text = fetch(API.format(key=key, source=src, days=span, date=d.isoformat()), a.root / 'api-cache' / src / f'{d.isoformat()}_{span}.csv')
            df = pd.read_csv(io.StringIO(text), dtype={'acq_date': 'string', 'satellite': 'string', 'confidence': 'string', 'daynight': 'string'})
            if len(df):
                if 'type' not in df.columns:  # NRT: no vegetation flag -> drop archive static-source cells
                    cx, cy = cells(df['latitude'].to_numpy(), df['longitude'].to_numpy())
                    keep = np.array([(int(x), int(y)) not in static for x, y in zip(cx, cy)])
                    df = df[keep].assign(type=0)
                if sat and 'satellite' in df.columns: df['satellite'] = df['satellite'].fillna(sat).replace({'1': 'N20', '2': 'N21'})
                df['type'] = pd.to_numeric(df['type'], errors='coerce').fillna(0).astype('Int8')
                r = aggregate_member(df[['latitude', 'longitude', 'acq_date', 'satellite', 'confidence', 'frp', 'daynight', 'type']], sensor == 'modis', -1)
                if r is not None: frames.append(r)
            print(sensor, src, d.isoformat(), span, len(df), flush=True)
            d += timedelta(days=span)
        if not frames: continue
        res = pd.concat(frames)
        for year, g in res.groupby(res['m'] // 12 + 2000):
            out = agg / f'{sensor}_{int(year)}.parquet'
            if out.exists() and int(year) <= 2025: print('archive year exists; skipping', out.name); continue
            g.to_parquet(out, index=False); print('wrote', out, len(g), flush=True)


if __name__ == '__main__':
    main()
