#!/usr/bin/env python3
"""Write the browser data products: AOI tile pyramid (EAT1 binary, gzipped), preset series, and meta.json.

Inputs : PRODUCTS_DIR/cells.parquet + months.json (build_products.py), HARMONIZATION_DIR/harmonization-report.json,
         BOUNDARIES_DIR (Natural Earth full-resolution polygons for exact 5 km preset assignment).
Outputs: APP/public/data/harmonized/{meta.json, tiles/L{n}/{tx}_{ty}.bin.gz, presets/{safe-id}.json}
Tile fields (all unsigned ints): h10 (harmonized x10), hb10 (bridged part x10), modis, snpp, noaa20 (raw cell-days),
                                 det_modis, det_snpp, det_noaa20 (raw detections). Reader: lib/harmonized/data.ts.
Usage: python build_web.py PRODUCTS_DIR HARMONIZATION_DIR BOUNDARIES_DIR APP_DIR
"""
import gzip, json, math, re, sys, time
from datetime import datetime, timezone
from pathlib import Path
import duckdb
import numpy as np
import pandas as pd
import shapely
from shapely.geometry import shape

prod, hdir, bdir, app = map(Path, sys.argv[1:5])
web = app / 'public' / 'data' / 'harmonized'
LEVELS = [(0, 10, 32), (1, 40, 32), (2, 160, 32)]  # (level, cellKm, tileCells)
FIELDS = ['h10', 'hb10', 'modis', 'snpp', 'noaa20', 'det_modis', 'det_snpp', 'det_noaa20']
R, COS30 = 6371.0, math.cos(math.pi / 6)


def varints(values: np.ndarray) -> bytes:
    """Vectorised unsigned LEB128 encoding of a 1-D uint64 array."""
    v = values.astype(np.uint64)
    if v.size == 0: return b''
    nbytes = np.ones(v.size, np.int64); t = v >> np.uint64(7)
    while t.any(): nbytes += (t > 0); t >>= np.uint64(7)
    out = np.zeros(int(nbytes.sum()), np.uint8); starts = np.concatenate(([0], np.cumsum(nbytes)[:-1]))
    for k in range(int(nbytes.max())):
        sel = nbytes > k
        byte = ((v[sel] >> np.uint64(7 * k)) & np.uint64(0x7F)).astype(np.uint8)
        more = (nbytes[sel] > k + 1)
        out[starts[sel] + k] = byte | (more.astype(np.uint8) << 7)
    return out.tobytes()


def zigzag(n: int) -> int: return (n << 1) if n >= 0 else ((-n << 1) - 1)


def encode_tile(level, cell_km, tc, tx, ty, df):
    """df: rows for one tile sorted by (idx, m) with columns idx, m and FIELDS."""
    head = b'EAT1' + varints(np.array([level, cell_km, zigzag(tx), zigzag(ty), tc, 0, len(FIELDS)], np.uint64))
    idx = df['idx'].to_numpy(np.int64); m = df['m'].to_numpy(np.int64)
    cstart = np.flatnonzero(np.concatenate(([True], idx[1:] != idx[:-1]))); ncell = len(cstart)
    counts = np.diff(np.append(cstart, len(idx)))
    cell_idx = idx[cstart]; idx_delta = np.diff(np.concatenate(([0], cell_idx)))
    mdelta = m.copy(); mdelta[1:] = m[1:] - m[:-1]; mdelta[cstart] = m[cstart]  # first month per cell relative to monthBase 0
    vals = np.column_stack([mdelta] + [df[f].to_numpy(np.int64) for f in FIELDS])  # R x (1 + F)
    if (vals < 0).any(): raise ValueError('negative value in tile')
    W = vals.shape[1]; R_ = len(idx)
    total = 2 * ncell + W * R_; stream = np.zeros(total, np.uint64)
    cell_of_row = np.repeat(np.arange(ncell), counts)
    row_pos = 2 * (cell_of_row + 1) + W * np.arange(R_)
    for k in range(W): stream[row_pos + k] = vals[:, k]
    head_pos = 2 * np.arange(ncell) + W * cstart
    stream[head_pos] = idx_delta; stream[head_pos + 1] = counts
    return head + varints(np.array([ncell], np.uint64)) + varints(stream)


def main():
    t0 = time.time()
    (web / 'tiles').mkdir(parents=True, exist_ok=True); (web / 'presets').mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(); con.execute('PRAGMA threads=8')
    cells = (prod / 'cells.parquet').as_posix()
    base = f"""SELECT cx, cy, m, round(h*10)::BIGINT AS h10, round(h_bridged*10)::BIGINT AS hb10, modis::BIGINT AS modis, snpp::BIGINT AS snpp, noaa20::BIGINT AS noaa20,
               det_modis::BIGINT AS det_modis, det_snpp::BIGINT AS det_snpp, det_noaa20::BIGINT AS det_noaa20 FROM read_parquet('{cells}')"""
    levels_meta = []
    for level, cell_km, tc in LEVELS:
        f = cell_km // 5
        q = f"""WITH b AS ({base}), g AS (
                  SELECT floor(cx/{f})::BIGINT AS gx, floor(cy/{f})::BIGINT AS gy, m, sum(h10) h10, sum(hb10) hb10, sum(modis) modis, sum(snpp) snpp, sum(noaa20) noaa20,
                         sum(det_modis) det_modis, sum(det_snpp) det_snpp, sum(det_noaa20) det_noaa20 FROM b GROUP BY ALL)
                SELECT floor(gx/{tc})::BIGINT AS tx, floor(gy/{tc})::BIGINT AS ty, ((gy - floor(gy/{tc})*{tc}) * {tc} + (gx - floor(gx/{tc})*{tc}))::BIGINT AS idx, m, {', '.join(FIELDS)}
                FROM g WHERE h10 + modis + snpp + noaa20 > 0 ORDER BY tx, ty, idx, m"""
        df = con.execute(q).df()
        d = web / 'tiles' / f'L{level}'; d.mkdir(parents=True, exist_ok=True)
        names, sizes = [], []
        for (tx, ty), g in df.groupby(['tx', 'ty'], sort=False):
            blob = gzip.compress(encode_tile(level, cell_km, tc, int(tx), int(ty), g), compresslevel=9, mtime=0)
            name = f'{int(tx)}_{int(ty)}'; (d / f'{name}.bin.gz').write_bytes(blob); names.append(name); sizes.append(len(blob))
        levels_meta.append({'level': level, 'cellKm': cell_km, 'tileCells': tc, 'path': f'/data/harmonized/tiles/L{level}/', 'tiles': names,
                            'bytes': int(sum(sizes)), 'maxTileBytes': int(max(sizes)), 'records': int(len(df))})
        print('level', level, cell_km, 'km tiles', len(names), 'MB', round(sum(sizes) / 1e6, 1), 'max tile MB', round(max(sizes) / 1e6, 2), 'records', len(df), flush=True)

    # ---- exact 5 km preset assignment (cell centre in polygon) ----
    uc = con.execute(f"SELECT DISTINCT cx, cy FROM read_parquet('{cells}')").df()
    x = (uc['cx'].to_numpy() + 0.5) * 5; y = (uc['cy'].to_numpy() + 0.5) * 5
    lon = np.degrees(x / (R * COS30)); lat = np.degrees(np.arcsin(np.clip(y * COS30 / R, -1, 1)))
    # Fast exact assignment: per polygon, bbox pre-filter on sorted longitudes, then prepared contains_xy.
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
    print('preset cells', len(amap), 'presets', amap['preset'].nunique(), round(time.time() - t0, 1), 's', flush=True)
    con.register('amap', amap)
    ps = con.execute(f"""SELECT a.preset, c.m, sum(c.h) h, sum(c.h_bridged) hb, sum(c.modis) modis, sum(c.terra) terra, sum(c.aqua) aqua, sum(c.snpp) snpp, sum(c.noaa20) noaa20,
                         sum(c.det_modis) det_modis, sum(c.det_snpp) det_snpp, sum(c.det_noaa20) det_noaa20, count(*) n
                         FROM read_parquet('{cells}') c JOIN amap a USING (cx, cy) GROUP BY ALL ORDER BY a.preset, c.m""").df()
    months = json.loads((prod / 'months.json').read_text())
    first, last = months[0]['month'], months[-1]['month']
    m0 = (int(first[:4]) - 2000) * 12 + int(first[5:7]) - 1; m1 = (int(last[:4]) - 2000) * 12 + int(last[5:7]) - 1
    index = json.loads((app / 'public/data/aoi/index.json').read_text())['presets']; names = {p['id']: p for p in index}
    areas = {}
    for path, kind, idkey in ((bdir / 'ne_50m_admin_0_countries.geojson', 'country', 'ADM0_A3'), (bdir / 'ne_10m_admin_1_states_provinces.geojson', 'admin1', 'iso_3166_2')):
        for f in json.loads(path.read_text())['features']:
            pr = f['properties']; pid = pr.get(idkey) or f"{pr.get('adm0_a3')}-{pr.get('name')}"
            g = shapely.make_valid(shape(f['geometry']))
            # equal-area: project to CEA and take planar area
            def proj(c):
                c = np.asarray(c); return np.column_stack([R * np.radians(c[:, 0]) * COS30, R * np.sin(np.radians(c[:, 1])) / COS30])
            areas[f'{kind}:{pid}'] = float(shapely.transform(g, proj).area)
    rel = json.loads((web / 'relative-error.json').read_text()) if (web / 'relative-error.json').exists() else None
    written = 0; available = []
    for pid, g in ps.groupby('preset', sort=False):
        rows = []; byM = {int(m): r for m, r in zip(g['m'], g.itertuples(index=False))}
        area = areas.get(pid, 0.0); err = None
        if rel:
            scaled = sorted((r for r in rel if r.get('unitAreaKm2')), key=lambda r: r['unitAreaKm2'])
            fits = [r for r in scaled if r['unitAreaKm2'] <= area]
            err = fits[-1] if fits else scaled[0]  # largest validated scale that fits inside the area (conservative between scales)
        for mi in range(m0, m1 + 1):
            r = byM.get(mi); src = months[mi - m0]['source']
            if r is None: rows.append([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); continue
            e = (err or {}).get('terra' if src == 'terra' else 'noaa20' if src == 'noaa20' else 'aqua', 0.0)
            h = float(r.h); hb = float(r.hb)
            rows.append([round(h, 1), round(max(0.0, h - e * hb), 1), round(h + e * hb, 1), int(r.modis), int(r.terra), int(r.aqua), int(r.snpp), int(r.noaa20), int(r.det_modis), int(r.det_snpp), int(r.det_noaa20)])
        meta = names.get(pid, {})
        out = {'id': pid, 'name': meta.get('name', pid), 'nameEs': meta.get('nameEs'), 'kind': pid.split(':')[0], 'areaKm2': round(area), 'cells5km': int(g['n'].max()),
               'start': first, 'fields': ['h', 'lo', 'hi', 'modis', 'terra', 'aqua', 'snpp', 'noaa20', 'det_modis', 'det_snpp', 'det_noaa20'], 'rows': rows}
        (web / 'presets' / (re.sub(r'[^A-Za-z0-9_-]', '_', pid) + '.json')).write_text(json.dumps(out, separators=(',', ':')))
        written += 1; available.append(pid)
    # Static industrial / volcanic heat sources (FIRMS type 1-2 in the archive, >= 3 detections) for the NRT mask.
    st_files = sorted((prod.parent / 'agg').glob('*_static.parquet'))
    static_n = 0
    if st_files:
        st = con.execute(f"SELECT cx, cy, sum(n) n FROM read_parquet({[f.as_posix() for f in st_files]!r}) GROUP BY cx, cy HAVING sum(n) >= 3 ORDER BY cx, cy").df()
        (web / 'static-cells.bin').write_bytes(np.column_stack([st['cx'].to_numpy(np.int16), st['cy'].to_numpy(np.int16)]).astype('<i2').tobytes())
        static_n = len(st)
    fac = json.loads((hdir / 'harmonization-factors.json').read_text()) if (hdir / 'harmonization-factors.json').exists() else {}
    nrt = {'noaa20ToSnppByCalendarMonth': [float(fac.get('noaa20_to_snpp', {}).get('global', {}).get(str(c), fac.get('noaa20_to_snpp', {}).get('all', 1.0))) for c in range(12)],
           'staticCells': static_n, 'staticCellsPath': '/data/harmonized/static-cells.bin',
           'note': 'Near-real-time NOAA-20/21 VIIRS (no vegetation flag; archive type 1-2 cells masked), converted to Suomi NPP-equivalent with the global calendar-month factor.'}
    validation = json.loads((hdir / 'harmonization-report.json').read_text())
    meta = {'version': 1, 'unit': 'Suomi NPP VIIRS-equivalent 5 km cell-days (harmonized)', 'firstMonth': first, 'lastMonth': last, 'baseline': [2003, int(last[:4]) if last[5:7] == '12' else int(last[:4]) - 1],  # last complete year only
            'generatedAt': datetime.now(timezone.utc).isoformat(), 'months': months, 'levels': levels_meta, 'relativeError': rel or [],
            'presetsWithData': available, 'validation': validation, 'nrt': nrt,
            'sources': [{'name': 'NASA FIRMS MODIS Collection 6.1 and VIIRS 375 m standard-processing archives (all countries, yearly)', 'url': 'https://firms.modaps.eosdis.nasa.gov/download/',
                         'citation': 'NASA FIRMS. MODIS C6.1 (MCD14ML) and VIIRS 375 m (VNP14IMG / VJ114IMG) active fire products, distributed by LANCE FIRMS.'},
                        {'name': 'Natural Earth admin-0 and admin-1 boundaries (public domain)', 'url': 'https://www.naturalearthdata.com/'}]}
    (web / 'meta.json').write_text(json.dumps(meta, separators=(',', ':')))
    print(json.dumps({'presets': written, 'seconds': round(time.time() - t0, 1), 'metaBytes': (web / 'meta.json').stat().st_size}))


if __name__ == '__main__':
    main()
