#!/usr/bin/env python3
"""Simplified Natural Earth boundaries for AOI presets (public domain, naturalearthdata.com).

Writes public/data/aoi/countries.json (admin-0, simplified) and public/data/aoi/admin1/<ADM0_A3>.json
(admin-1 per country, simplified), plus an index with names (English/Spanish), ISO codes and bboxes.
Full-resolution polygons stay in global-firms/boundaries for the offline preset series.
Usage: python build_boundaries.py BOUNDARIES_DIR APP_PUBLIC_DATA_DIR
"""
import json, sys
from pathlib import Path
import shapely
from shapely.geometry import shape, mapping

src, out = Path(sys.argv[1]), Path(sys.argv[2]) / 'aoi'
(out / 'admin1').mkdir(parents=True, exist_ok=True)


def rounded(geom, nd=3):
    return json.loads(json.dumps(mapping(geom)), parse_float=lambda x: round(float(x), nd))


def simplify(geom, tol):
    g = shapely.make_valid(geom).simplify(tol, preserve_topology=True)
    return g if not g.is_empty else geom


countries = json.loads((src / 'ne_50m_admin_0_countries.geojson').read_text())['features']
c_out, index = [], []
for f in countries:
    p = f['properties']; code = p['ADM0_A3']; g = shape(f['geometry'])
    s = simplify(g, 0.02)
    c_out.append({'type': 'Feature', 'properties': {'id': f'country:{code}', 'code': code, 'iso3': p.get('ISO_A3'), 'name': p.get('NAME_EN') or p['ADMIN'], 'nameEs': p.get('NAME_ES')},
                  'geometry': rounded(s)})
    index.append({'id': f'country:{code}', 'kind': 'country', 'code': code, 'name': p.get('NAME_EN') or p['ADMIN'], 'nameEs': p.get('NAME_ES'), 'bbox': [round(v, 3) for v in g.bounds]})
(out / 'countries.json').write_text(json.dumps({'type': 'FeatureCollection', 'source': 'Natural Earth 1:50m admin-0 (public domain), simplified 0.02 deg', 'features': c_out}, separators=(',', ':')))

prov = json.loads((src / 'ne_10m_admin_1_states_provinces.geojson').read_text())['features']
by = {}
for f in prov:
    p = f['properties']; code = p.get('adm0_a3'); g = shape(f['geometry'])
    if not code or g.is_empty: continue
    s = simplify(g, 0.01)
    pid = p.get('iso_3166_2') or f"{code}-{p.get('name')}"
    by.setdefault(code, []).append({'type': 'Feature', 'properties': {'id': f'admin1:{pid}', 'code': pid, 'country': code, 'name': p.get('name_en') or p.get('name'), 'nameEs': p.get('name_es'), 'kind': p.get('type_en')},
                                    'geometry': rounded(s)})
    index.append({'id': f'admin1:{pid}', 'kind': 'admin1', 'code': pid, 'country': code, 'name': p.get('name_en') or p.get('name'), 'nameEs': p.get('name_es'), 'bbox': [round(v, 3) for v in g.bounds]})
for code, feats in by.items():
    (out / 'admin1' / f'{code}.json').write_text(json.dumps({'type': 'FeatureCollection', 'source': 'Natural Earth 1:10m admin-1 (public domain), simplified 0.01 deg', 'features': feats}, separators=(',', ':')))
(out / 'index.json').write_text(json.dumps({'source': 'Natural Earth (public domain): https://www.naturalearthdata.com/about/terms-of-use/', 'presets': index}, separators=(',', ':')))
sizes = {p.name: p.stat().st_size for p in [out / 'countries.json', out / 'index.json']}
print(json.dumps({'countries': len(c_out), 'admin1Countries': len(by), 'admin1': sum(len(v) for v in by.values()), 'bytes': sizes,
                  'admin1TotalBytes': sum(p.stat().st_size for p in (out / 'admin1').glob('*.json')), 'ARG': (out / 'admin1' / 'ARG.json').stat().st_size}))
