#!/usr/bin/env python3
"""Same-days-of-year climatology per preset (country / province) for the "Right now" panel.

A few recent days should be compared with the SAME days in past years, not with a month's median divided by its
length (Astra reviews 14-15). This builds, for every preset, the daily harmonized series Nov 2000 - Dec 2025 from the
per-day bitmasks, with exactly the day-level splice of build_products.py (S-NPP > NOAA-20 > NOAA-21 > Aqua > Terra on
days each platform delivered data globally; bridged platforms converted with the 320 km block x calendar-month factors),
and stores, over the baseline years:
  week[slot]  = quantiles of the mean daily value over the 7 days ending on that day of the year (365 slots; 29 Feb skipped)
  mtd[c][k]   = quantiles of the mean daily value from day 1 to day k of calendar month c (month-to-date)
  n[slot]     = number of baseline years with a complete 7-day window
A window that contains a day with no satellite coverage is left out for that year.
Output: APP/public/data/harmonized/daily/{safe-id}.json.gz and a "dailyClimatology" entry in meta.json.
Usage: python build_daily_climatology.py GLOBAL_FIRMS_DIR HARMONIZATION_DIR BOUNDARIES_DIR APP_DIR
"""
import gzip, json, math, re, sys, time
from pathlib import Path
import duckdb
import numpy as np
import pandas as pd
import shapely
from shapely.geometry import shape

root, hdir, bdir, app = map(Path, sys.argv[1:5])
plat, prod, web = root / 'plat', root / 'products', app / 'public' / 'data' / 'harmonized'
out = web / 'daily'; out.mkdir(parents=True, exist_ok=True)
PLATS = ['terra', 'aqua', 'snpp', 'noaa20', 'noaa21']
B, SB, R, COS30, M31 = 64, 4, 6371.0, math.cos(math.pi / 6), 2147483647
BASE = (2003, 2025); QS = [10, 25, 50, 75, 90]
t0 = time.time()

# ---- availability (per platform x month day bitmasks) and bridge factors: as build_products.py ----
avail = json.loads((hdir / 'availability.json').read_text()); factors = json.loads((hdir / 'harmonization-factors.json').read_text())
am = {p: {} for p in PLATS}
for p in PLATS:
    for d in avail.get(p, []):
        m = (int(d[:4]) - 2000) * 12 + int(d[5:7]) - 1; am[p][m] = am[p].get(m, 0) | (1 << (int(d[8:10]) - 1))
months = list(range(min(set().union(*[set(v) for v in am.values()])), max(set().union(*[set(v) for v in am.values()])) + 1))
av = pd.DataFrame({'m': months, **{f'av_{p}': [am[p].get(m, 0) for m in months] for p in PLATS}})


def band_of(by):
    y = (by * B + B / 2) * 5.0; s = max(-1.0, min(1.0, y * math.cos(math.pi / 6) / 6371.0))
    return math.floor(math.degrees(math.asin(s)) / 15)


def q(pair, bx, by, cal):
    f = factors[pair]
    for k, level in ((f'{bx}:{by}:{cal}', 'block'), (f'{bx // SB}:{by // SB}:{cal}', 'super'), (f'{band_of(by)}:{cal}', 'band')):
        if k in f[level]: return f[level][k]
    if str(cal) in f['global']: return f['global'][str(cal)]
    if 'all' in f: return f['all']
    raise SystemExit(f'Bridge {pair} has no factor for calendar month {cal}.')


con = duckdb.connect(); con.execute('PRAGMA threads=8'); con.execute(f"PRAGMA temp_directory='{(prod / 'duck-tmp').as_posix()}'")
parts = [f"SELECT cx, cy, m, {i} AS p, CAST(days AS BIGINT) AS days FROM read_parquet({sorted(str(f) for f in plat.glob(f'q_{p}_*.parquet'))!r})"
         for i, p in enumerate(PLATS) if list(plat.glob(f'q_{p}_*.parquet'))]
con.execute(f"""CREATE TABLE wide AS SELECT cx, cy, m,
  bit_or(CASE WHEN p=0 THEN days ELSE 0 END) mt, bit_or(CASE WHEN p=1 THEN days ELSE 0 END) ma, bit_or(CASE WHEN p=2 THEN days ELSE 0 END) mn,
  bit_or(CASE WHEN p=3 THEN days ELSE 0 END) mj, bit_or(CASE WHEN p=4 THEN days ELSE 0 END) mk
  FROM ({' UNION ALL '.join(parts)}) GROUP BY cx, cy, m""")
blocks = con.execute(f"SELECT DISTINCT floor(cx/{B})::INT AS bx, floor(cy/{B})::INT AS by, (m % 12)::INT AS cal FROM wide").df()
for pair in ('aqua_to_snpp', 'terra_to_aqua', 'noaa20_to_snpp'):
    blocks[pair] = [q(pair, a, b, c) for a, b, c in zip(blocks['bx'], blocks['by'], blocks['cal'])]
print('wide + factors', round(time.time() - t0, 1), 's', flush=True)

# ---- exact 5 km preset membership (cell centre in polygon): as build_web.py ----
uc = con.execute("SELECT DISTINCT cx, cy FROM wide").df()
x = (uc['cx'].to_numpy() + 0.5) * 5; y = (uc['cy'].to_numpy() + 0.5) * 5
lon = np.degrees(x / (R * COS30)); lat = np.degrees(np.arcsin(np.clip(y * COS30 / R, -1, 1)))
order = np.argsort(lon); slon, slat = lon[order], lat[order]; ucx, ucy = uc['cx'].to_numpy()[order], uc['cy'].to_numpy()[order]
acx, acy, apid = [], [], []
for path, kind, idkey in ((bdir / 'ne_50m_admin_0_countries.geojson', 'country', 'ADM0_A3'), (bdir / 'ne_10m_admin_1_states_provinces.geojson', 'admin1', 'iso_3166_2')):
    for f in json.loads(path.read_text())['features']:
        pr = f['properties']; pid = pr.get(idkey) or f"{pr.get('adm0_a3')}-{pr.get('name')}"
        g = shapely.make_valid(shape(f['geometry']))
        if g.is_empty: continue
        w, s_, e, n = g.bounds; i0, i1 = np.searchsorted(slon, w), np.searchsorted(slon, e, side='right')
        if i1 <= i0: continue
        sel = np.arange(i0, i1); sel = sel[(slat[sel] >= s_) & (slat[sel] <= n)]
        if not len(sel): continue
        shapely.prepare(g); inside = sel[shapely.contains_xy(g, slon[sel], slat[sel])]
        if len(inside): acx.append(ucx[inside]); acy.append(ucy[inside]); apid.append(np.full(len(inside), f'{kind}:{pid}', dtype=object))
amap = pd.DataFrame({'cx': np.concatenate(acx), 'cy': np.concatenate(acy), 'preset': np.concatenate(apid)}).drop_duplicates(['cx', 'cy', 'preset'])
presets = sorted(amap['preset'].unique()); pidx = {p: i for i, p in enumerate(presets)}
amap['pi'] = amap['preset'].map(pidx).astype(np.int32)
print('membership', len(amap), 'cells', len(presets), 'presets', round(time.time() - t0, 1), 's', flush=True)

# ---- per preset x month x day-of-month harmonized sums (one SQL pass; 31 bit columns) ----
con.register('amap', amap[['cx', 'cy', 'pi']]); con.register('avtab', av); con.register('qtab', blocks)
bit = lambda col, d: f"(({col} >> {d}) & 1)"
day_sums = ',\n  '.join(f"sum({bit('en', d)} + qj * ({bit('ej', d)} + {bit('ek', d)}) + qa * {bit('ea', d)} + qt * qa * {bit('et', d)}) AS d{d}" for d in range(31))
sums = con.execute(f"""WITH j AS (
  SELECT a.pi, w.m,
    (w.mn & coalesce(v.av_snpp,0)) en,
    (w.mj & coalesce(v.av_noaa20,0) & xor(coalesce(v.av_snpp,0), {M31})) ej,
    (w.mk & coalesce(v.av_noaa21,0) & xor(coalesce(v.av_snpp,0) | coalesce(v.av_noaa20,0), {M31})) ek,
    (w.ma & coalesce(v.av_aqua,0) & xor(coalesce(v.av_snpp,0) | coalesce(v.av_noaa20,0) | coalesce(v.av_noaa21,0), {M31})) ea,
    (w.mt & coalesce(v.av_terra,0) & xor(coalesce(v.av_snpp,0) | coalesce(v.av_noaa20,0) | coalesce(v.av_noaa21,0) | coalesce(v.av_aqua,0), {M31})) et,
    q.noaa20_to_snpp qj, q.aqua_to_snpp qa, q.terra_to_aqua qt
  FROM wide w JOIN amap a USING (cx, cy) LEFT JOIN avtab v USING (m)
  JOIN qtab q ON q.bx = floor(w.cx/{B})::INT AND q.by = floor(w.cy/{B})::INT AND q.cal = (w.m % 12)::INT)
SELECT pi, m,
  {day_sums}
FROM j GROUP BY pi, m""").df()
print('day sums', len(sums), 'rows', round(time.time() - t0, 1), 's', flush=True)

# ---- daily arrays: NaN where no satellite delivered data, 0 where covered but nothing burned ----
m0, m1 = months[0], months[-1]
day0 = pd.Timestamp(2000 + m0 // 12, m0 % 12 + 1, 1); dates = pd.date_range(day0, pd.Timestamp(2000 + m1 // 12, m1 % 12 + 1, 1) + pd.offsets.MonthEnd(0), freq='D')
T = len(dates); D = np.zeros((len(presets), T), np.float32)
mstart = {m: (pd.Timestamp(2000 + m // 12, m % 12 + 1, 1) - day0).days for m in months}
ndays = {m: pd.Period(f'{2000 + m // 12}-{m % 12 + 1:02d}').days_in_month for m in months}
cov = np.zeros(T, bool)
for m in months:
    u = 0
    for p in PLATS: u |= am[p].get(m, 0)
    for d in range(ndays[m]): cov[mstart[m] + d] = bool((u >> d) & 1)
pi_arr = sums['pi'].to_numpy(); m_arr = sums['m'].to_numpy(); vals = sums[[f'd{d}' for d in range(31)]].to_numpy(np.float32)
ms = np.array([mstart.get(int(m), -1) for m in m_arr]); nd = np.array([ndays.get(int(m), 0) for m in m_arr])
for d in range(31):
    ok = (d < nd) & (ms >= 0)
    D[pi_arr[ok], ms[ok] + d] = vals[ok, d]
D[:, ~cov] = np.nan
print('daily arrays', D.shape, 'covered days', int(cov.sum()), round(time.time() - t0, 1), 's', flush=True)

# ---- climatologies over the baseline years ----
NONLEAP = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; first_slot = np.cumsum([0] + NONLEAP[:-1])
years = list(range(BASE[0], BASE[1] + 1))
Dz = np.nan_to_num(D); valid = ~np.isnan(D)
cs = np.concatenate([np.zeros((len(presets), 1), np.float64), np.cumsum(Dz, axis=1, dtype=np.float64)], axis=1)
cv = np.concatenate([np.zeros((1,), np.int64), np.cumsum(cov.astype(np.int64))])
week = np.full((len(presets), len(years), 365), np.nan, np.float32)
for yi, yr in enumerate(years):
    for mo in range(12):
        for dd in range(NONLEAP[mo]):
            t = (pd.Timestamp(yr, mo + 1, dd + 1) - day0).days
            if t < 6 or t >= T: continue
            if cv[t + 1] - cv[t - 6] < 7: continue  # a day without satellite coverage in the window
            week[:, yi, first_slot[mo] + dd] = (cs[:, t + 1] - cs[:, t - 6]) / 7.0
mtd = np.full((len(presets), len(years), 12, 31), np.nan, np.float32)
for yi, yr in enumerate(years):
    for mo in range(12):
        t_start = (pd.Timestamp(yr, mo + 1, 1) - day0).days
        if t_start < 0: continue
        for k in range(pd.Period(f'{yr}-{mo + 1:02d}').days_in_month):
            t = t_start + k
            if t >= T or cv[t + 1] - cv[t_start] < k + 1: break
            mtd[:, yi, mo, k] = (cs[:, t + 1] - cs[:, t_start]) / (k + 1)
with np.errstate(all='ignore'):
    wq = np.nanpercentile(week, QS, axis=1)         # (5, presets, 365)
    mq = np.nanpercentile(mtd, QS, axis=1)          # (5, presets, 12, 31)
wn = np.sum(~np.isnan(week), axis=1)                # (presets, 365)
print('climatology', round(time.time() - t0, 1), 's', flush=True)

r2 = lambda a: [None if not np.isfinite(v) else round(float(v), 2) for v in a]
written = 0
for i, pid in enumerate(presets):
    if not np.isfinite(wq[2, i]).any(): continue
    doc = {'id': pid, 'baseline': list(BASE), 'q': QS, 'window': 7,
           'week': [r2(wq[:, i, s]) for s in range(365)], 'n': [int(v) for v in wn[i]],
           'mtd': [[r2(mq[:, i, mo, k]) for k in range(31)] for mo in range(12)]}
    (out / (re.sub(r'[^A-Za-z0-9_-]', '_', pid) + '.json.gz')).write_bytes(gzip.compress(json.dumps(doc, separators=(',', ':')).encode(), compresslevel=9, mtime=0))
    written += 1
meta_path = web / 'meta.json'; meta = json.loads(meta_path.read_text())
meta['dailyClimatology'] = {'path': '/data/harmonized/daily/', 'baseline': list(BASE), 'quantiles': QS, 'window': 7, 'presets': written,
                            'note': 'mean daily harmonized cell-days over the 7 days ending on each day of the year (and month-to-date), quantiles over the baseline years'}
meta_path.write_text(json.dumps(meta, separators=(',', ':')))
print(json.dumps({'presets': written, 'seconds': round(time.time() - t0, 1)}))
