#!/usr/bin/env python3
"""Build the harmonized cell-month product from platform masks + fitted factors (DuckDB, out-of-core).

Harmonized value H for each 5 km cell-month, day by day (precedence S-NPP > NOAA-20 > Aqua > Terra):
  a day counts from the highest-precedence platform that was delivering data globally that day
  (availability.json); S-NPP bits count 1, others are converted to S-NPP-equivalent with the fitted factor
  for the cell's 320 km block and calendar month (harmonization-factors.json, shrinkage fallbacks resolved here).
Raw per-sensor cell-days (no conversion) and detection counts are kept for transparency.
Outputs (OUT): cells.parquet (cx, cy, m, h, h_bridged, modis, terra, aqua, snpp, noaa20, det_modis, det_snpp, det_noaa20)
               months.json (global per-month availability: partial / provisional / dominant platform)
Usage: python build_products.py GLOBAL_FIRMS_DIR HARMONIZATION_DIR OUT_DIR
"""
import json, math, sys
from pathlib import Path
import duckdb
import numpy as np
import pandas as pd

root, hdir, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]); out.mkdir(parents=True, exist_ok=True)
plat = root / 'plat'
PLATS = ['terra', 'aqua', 'snpp', 'noaa20', 'noaa21']  # NOAA-21 (2023-) uses the NOAA-20 bridge factor: same VIIRS design
B, SB = 64, 4

avail = json.loads((hdir / 'availability.json').read_text())
factors = json.loads((hdir / 'harmonization-factors.json').read_text())

# ---- availability masks per platform x month ------------------------------------------------
am = {p: {} for p in PLATS}
for p in PLATS:
    for d in avail.get(p, []):
        y, mo, da = int(d[:4]), int(d[5:7]), int(d[8:10])
        m = (y - 2000) * 12 + mo - 1
        am[p][m] = am[p].get(m, 0) | (1 << (da - 1))
_have = set().union(*[set(v) for v in am.values()])
months = list(range(min(_have), max(_have) + 1))  # contiguous; months without any platform data are flagged, not skipped
av = pd.DataFrame({'m': months, **{f'av_{p}': [am[p].get(m, 0) for m in months] for p in PLATS}})


def band_of(by):
    y = (by * B + B / 2) * 5.0; s = max(-1.0, min(1.0, y * math.cos(math.pi / 6) / 6371.0))
    return math.floor(math.degrees(math.asin(s)) / 15)


def q(pair, bx, by, cal):
    f = factors.get(pair)
    if not f: return None
    k = f'{bx}:{by}:{cal}'
    if k in f['block']: return f['block'][k]
    k = f'{bx // SB}:{by // SB}:{cal}'
    if k in f['super']: return f['super'][k]
    k = f'{band_of(by)}:{cal}'
    if k in f['band']: return f['band'][k]
    if str(cal) in f['global']: return f['global'][str(cal)]
    if 'all' in f: return f['all']
    raise SystemExit(f'Bridge {pair} has no factor for calendar month {cal}: refusing to substitute 1.0.')


con = duckdb.connect(); con.execute("PRAGMA threads=8"); con.execute(f"PRAGMA temp_directory='{(out / 'duck-tmp').as_posix()}'")
files = {p: sorted(str(f) for f in plat.glob(f'q_{p}_*.parquet')) for p in PLATS}
parts = []
for i, p in enumerate(PLATS):
    if files[p]:
        parts.append(f"SELECT cx, cy, m, {i} AS p, CAST(days AS BIGINT) AS days, CAST(n AS BIGINT) AS n FROM read_parquet({files[p]!r})")
con.execute(f"CREATE TABLE raw AS {' UNION ALL '.join(parts)}")
con.execute("""CREATE TABLE wide AS SELECT cx, cy, m,
  bit_or(CASE WHEN p=0 THEN days ELSE 0 END) AS m_terra, bit_or(CASE WHEN p=1 THEN days ELSE 0 END) AS m_aqua,
  bit_or(CASE WHEN p=2 THEN days ELSE 0 END) AS m_snpp,  bit_or(CASE WHEN p=3 THEN days ELSE 0 END) AS m_noaa20, bit_or(CASE WHEN p=4 THEN days ELSE 0 END) AS m_noaa21,
  sum(CASE WHEN p IN (0,1) THEN n ELSE 0 END) AS det_modis, sum(CASE WHEN p=2 THEN n ELSE 0 END) AS det_snpp, sum(CASE WHEN p=3 THEN n ELSE 0 END) AS det_noaa20
  FROM raw GROUP BY cx, cy, m""")
con.execute("DROP TABLE raw")
# Factor table for every (block, calendar month) present.
blocks = con.execute(f"SELECT DISTINCT floor(cx/{B})::INT AS bx, floor(cy/{B})::INT AS by, (m % 12)::INT AS cal FROM wide").df()
# A platform with data needs every bridge on its path to S-NPP; never substitute 1.0 for a factor that was not fitted.
NEEDS = {'aqua': ['aqua_to_snpp'], 'terra': ['terra_to_aqua', 'aqua_to_snpp'], 'noaa20': ['noaa20_to_snpp'], 'noaa21': ['noaa20_to_snpp']}
missing = sorted({pair for p, pairs in NEEDS.items() if files[p] for pair in pairs if pair not in factors})
if missing:
    sys.exit(f'Missing bridge factors {missing}: harmonize.py did not fit them (see harmonization-report.json). Refusing to build a product with unconverted sensors.')
for pair in ('aqua_to_snpp', 'terra_to_aqua', 'noaa20_to_snpp'):
    blocks[pair] = [q(pair, a, b, c) if pair in factors else 0.0 for a, b, c in zip(blocks['bx'], blocks['by'], blocks['cal'])]
if blocks[['aqua_to_snpp', 'terra_to_aqua', 'noaa20_to_snpp']].isna().any().any(): sys.exit('A bridge factor lookup returned no value.')
con.register('qtab', blocks); con.register('avtab', av)
M31 = 2147483647
con.execute(f"""CREATE TABLE cells AS
WITH j AS (
  SELECT w.*, coalesce(a.av_terra,0) AS av_t, coalesce(a.av_aqua,0) AS av_a, coalesce(a.av_snpp,0) AS av_n, coalesce(a.av_noaa20,0) AS av_j, coalesce(a.av_noaa21,0) AS av_k,
         q.aqua_to_snpp AS qa, q.terra_to_aqua AS qt, q.noaa20_to_snpp AS qj
  FROM wide w LEFT JOIN avtab a USING (m)
  LEFT JOIN qtab q ON q.bx = floor(w.cx/{B})::INT AND q.by = floor(w.cy/{B})::INT AND q.cal = (w.m % 12)::INT)
SELECT cx, cy, m,
  bit_count(m_snpp & av_n) AS d_n,
  bit_count(m_noaa20 & av_j & xor(av_n, {M31})) * qj + bit_count(m_noaa21 & av_k & xor(av_n | av_j, {M31})) * qj AS d_j,
  bit_count(m_aqua & av_a & xor(av_n | av_j | av_k, {M31})) * qa AS d_a,
  bit_count(m_terra & av_t & xor(av_n | av_j | av_k | av_a, {M31})) * qt * qa AS d_t,
  bit_count(m_terra | m_aqua) AS modis, bit_count(m_terra) AS terra, bit_count(m_aqua) AS aqua, bit_count(m_snpp) AS snpp, bit_count(m_noaa20) AS noaa20,
  det_modis, det_snpp, det_noaa20
FROM j""")
con.execute("DROP TABLE wide")
con.execute("""COPY (SELECT cx::SMALLINT AS cx, cy::SMALLINT AS cy, m::SMALLINT AS m, (d_n + d_j + d_a + d_t)::FLOAT AS h, (d_j + d_a + d_t)::FLOAT AS h_bridged,
  (d_t)::FLOAT AS h_terra, modis::UTINYINT AS modis, terra::UTINYINT AS terra, aqua::UTINYINT AS aqua, snpp::UTINYINT AS snpp, noaa20::UTINYINT AS noaa20,
  det_modis::UINTEGER AS det_modis, det_snpp::UINTEGER AS det_snpp, det_noaa20::UINTEGER AS det_noaa20
  FROM cells WHERE d_n + d_j + d_a + d_t > 0 OR modis + snpp + noaa20 > 0 ORDER BY cx, cy, m) TO '""" + (out / 'cells.parquet').as_posix() + "' (FORMAT PARQUET, COMPRESSION ZSTD)")
stats = con.execute("SELECT count(*) AS rows, count(DISTINCT (cx, cy)) AS cells, min(m) AS m0, max(m) AS m1, sum(h) AS h FROM read_parquet('" + (out / 'cells.parquet').as_posix() + "')").df().to_dict('records')[0]

# ---- per-month global flags -----------------------------------------------------------------
mflags = []
for m in months:
    y, mo = 2000 + m // 12, m % 12 + 1
    ndays = pd.Period(f'{y}-{mo:02d}').days_in_month; full = (1 << ndays) - 1
    n_, j_, a_, t_ = am['snpp'].get(m, 0), am['noaa20'].get(m, 0) | am['noaa21'].get(m, 0), am['aqua'].get(m, 0), am['terra'].get(m, 0)
    cover = (n_ | j_ | a_ | t_) & full
    used = {'snpp': bin(n_ & full).count('1'), 'noaa20': bin(j_ & ~n_ & full).count('1'), 'aqua': bin(a_ & ~(n_ | j_) & full).count('1'), 'terra': bin(t_ & ~(n_ | j_ | a_) & full).count('1')}
    mflags.append({'month': f'{y}-{mo:02d}', 'days': ndays, 'coveredDays': bin(cover).count('1'), 'partial': cover != full, 'provisional': used['terra'] > 0,
                   'source': max(used, key=used.get) if any(used.values()) else None, 'daysBySource': used})
(out / 'months.json').write_text(json.dumps(mflags, indent=0))
print(json.dumps({'stats': {k: (float(v) if isinstance(v, (np.floating, float)) else int(v)) for k, v in stats.items()}, 'months': len(mflags),
                  'partialMonths': [x['month'] for x in mflags if x['partial']][:40]}, indent=1))
