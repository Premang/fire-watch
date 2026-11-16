#!/usr/bin/env python3
"""Aggregate one FIRMS all-countries archive zip (one sensor, one year) to per-cell monthly records.

Input : FIRMS standard-processing archive, e.g. viirs-snpp_2020_all_countries.zip (one CSV per country).
Grid  : the same spherical cylindrical equal-area grid as the existing U.S. history (standard parallel 30 deg,
        R = 6371 km, 5 km cells): x = R*lon*cos30, y = R*sin(lat)/cos30, cx = floor(x/5), cy = floor(y/5).
Filter: type == 0 (presumed vegetation fire; excludes volcanoes, static land sources such as gas flares,
        and offshore). All confidence classes are kept but recorded, so harmonization can choose.
Output: parquet with one row per (country, cx, cy, month, satellite, confidence class, day/night):
        days   uint32 bitmask of days-of-month with >= 1 detection (OR-combinable -> exact cell-days)
        n      detections, frp summed FRP (MW).
Usage : python aggregate_global.py ZIP OUT_DIR
"""
import io, re, sys, time, zipfile
from pathlib import Path
import numpy as np
import pandas as pd

R, COS30 = 6371.0, np.cos(np.pi / 6)
SAT = {'Terra': 0, 'T': 0, 'Aqua': 1, 'A': 1, 'N': 2, 'N20': 3, '1': 3, 'N21': 4, '2': 4}


def cells(lat, lon):
    x = R * np.radians(lon) * COS30
    y = R * np.sin(np.radians(lat)) / COS30
    return np.floor(x / 5).astype(np.int16), np.floor(y / 5).astype(np.int16)


def conf_class(conf, modis):
    if modis:
        c = pd.to_numeric(conf, errors='coerce').to_numpy()
        return np.where(c >= 80, 2, np.where(c >= 30, 1, 0)).astype(np.int8)
    s = conf.astype(str).str.strip().str.lower().str[0].to_numpy()
    out = np.full(len(s), -1, np.int8); out[s == 'l'] = 0; out[s == 'n'] = 1; out[s == 'h'] = 2
    if (out < 0).any(): raise ValueError(f'unknown VIIRS confidence values: {set(s[out < 0])}')
    return out


def aggregate_member(df, modis, country_id):
    df = df[df['type'] == 0]
    if df.empty: return None
    cx, cy = cells(df['latitude'].to_numpy(), df['longitude'].to_numpy())
    d = pd.to_datetime(df['acq_date'], format='%Y-%m-%d')
    m = ((d.dt.year - 2000) * 12 + d.dt.month - 1).to_numpy().astype(np.int16)
    bit = (np.uint32(1) << (d.dt.day.to_numpy().astype(np.uint32) - 1)).astype(np.uint32)
    sat = df['satellite'].astype(str).map(SAT)
    if sat.isna().any(): raise ValueError(f'unknown satellite codes: {set(df.loc[sat.isna(), "satellite"])}')
    g = pd.DataFrame({'cx': cx, 'cy': cy, 'm': m, 'sat': sat.to_numpy().astype(np.int8), 'conf': conf_class(df['confidence'], modis),
                      'dn': (df['daynight'].astype(str).str.upper().str[0] == 'N').to_numpy().astype(np.int8), 'bit': bit, 'frp': df['frp'].astype('float32').to_numpy()})
    # Vectorised group-by: pack the key into int64, sort, reduce runs (bitwise OR of day bits, counts, FRP sums).
    k = ((g['cx'].to_numpy().astype(np.int64) + 4096) << 40) | ((g['cy'].to_numpy().astype(np.int64) + 2048) << 28) | (g['m'].to_numpy().astype(np.int64) << 12) \
        | (g['sat'].to_numpy().astype(np.int64) << 4) | (g['conf'].to_numpy().astype(np.int64) << 1) | g['dn'].to_numpy().astype(np.int64)
    order = np.argsort(k, kind='stable'); ks = k[order]
    change = np.ones(len(ks), bool); change[1:] = ks[1:] != ks[:-1]; starts = np.flatnonzero(change)
    days = np.bitwise_or.reduceat(g['bit'].to_numpy()[order], starts)
    n = np.diff(np.append(starts, len(ks))); frp = np.add.reduceat(g['frp'].to_numpy()[order], starts)
    u = ks[starts]
    agg = pd.DataFrame({'cx': ((u >> 40) - 4096).astype(np.int16), 'cy': (((u >> 28) & 0xFFF) - 2048).astype(np.int16), 'm': ((u >> 12) & 0xFFFF).astype(np.int16),
                        'sat': ((u >> 4) & 0xFF).astype(np.int8), 'conf': ((u >> 1) & 0x7).astype(np.int8), 'dn': (u & 1).astype(np.int8),
                        'days': days.astype(np.uint32), 'n': n.astype(np.int64), 'frp': frp.astype(np.float32)})
    agg['country'] = np.int16(country_id)
    return agg


def main():
    zpath, out = Path(sys.argv[1]), Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
    sensor, year = re.match(r'(modis|viirs-snpp|viirs-jpss1|viirs-jpss2)_(\d{4})_all_countries\.zip', zpath.name).groups()
    modis = sensor == 'modis'; t0 = time.time(); parts = []; countries = []; rows_in = 0; rows_kept = 0; types = {}; static_parts = []
    with zipfile.ZipFile(zpath) as z:
        members = [n for n in z.namelist() if n.endswith('.csv')]
        for name in sorted(members):
            country = re.sub(rf'^{sensor}_{year}_', '', Path(name).stem)
            with z.open(name) as f:
                df = pd.read_csv(f, usecols=['latitude', 'longitude', 'acq_date', 'satellite', 'confidence', 'frp', 'daynight', 'type'],
                                 dtype={'latitude': 'float64', 'longitude': 'float64', 'acq_date': 'string', 'satellite': 'string', 'confidence': 'string', 'frp': 'float64', 'daynight': 'string', 'type': 'Int8'})
            rows_in += len(df)
            for t, c in df['type'].value_counts(dropna=False).items(): types[str(t)] = types.get(str(t), 0) + int(c)
            st = df[df['type'].isin([1, 2])]  # volcanoes and static land sources (e.g. gas flares): NRT mask
            if len(st):
                sx, sy = cells(st['latitude'].to_numpy(), st['longitude'].to_numpy())
                static_parts.append(pd.DataFrame({'cx': sx, 'cy': sy, 'type': st['type'].to_numpy().astype(np.int8)}))
            a = aggregate_member(df, modis, len(countries)); countries.append(country)
            if a is not None: rows_kept += int(a['n'].sum()); parts.append(a)
    res = pd.concat(parts, ignore_index=True)
    res.to_parquet(out / f'{sensor}_{year}.parquet', index=False)
    if static_parts:
        st = pd.concat(static_parts).groupby(['cx', 'cy', 'type'], as_index=False).size().rename(columns={'size': 'n'})
        st.to_parquet(out / f'{sensor}_{year}_static.parquet', index=False)
    meta = {'zip': zpath.name, 'sensor': sensor, 'year': int(year), 'members': len(members), 'countries': countries, 'rowsIn': rows_in, 'type0Detections': rows_kept,
            'typeCounts': types, 'aggRows': len(res), 'seconds': round(time.time() - t0, 1)}
    (out / f'{sensor}_{year}.json').write_text(__import__('json').dumps(meta))
    print({k: v for k, v in meta.items() if k != 'countries'}, flush=True)


if __name__ == '__main__':
    main()
