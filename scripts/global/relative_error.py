#!/usr/bin/env python3
"""Uncertainty table for the app, from held-out validation in harmonization-report.json.

For each bridge pair, the normalized absolute error (NAE) of the harmonized series on TEST years (and, where the bridge is
used before its overlap years, the larger of that and the BACKCAST error) at the
40 km / 320 km / 1,280 km / global-monthly aggregation scales is used as the relative half-width of the band
applied to the bridged part of an AOI's monthly value. AOIs are matched to a scale by area.
Terra-bridged months chain Terra->Aqua->S-NPP: errors combined in quadrature (assumes independence).
Usage: python relative_error.py HARMONIZATION_DIR APP_DIR
"""
import json, sys, math
from pathlib import Path

hdir, app = Path(sys.argv[1]), Path(sys.argv[2])
rep = json.loads((hdir / 'harmonization-report.json').read_text())['pairs']
# unitAreaKm2 = area of one validation unit. An AOI uses the error of the LARGEST validated scale whose unit fits inside it
# (so an area between two scales gets the smaller scale's, larger, error: conservative; Astra 15). 'global' applies to global totals only.
SCALES = [('40km', 40 ** 2), ('320km', 320 ** 2), ('1280km', 1280 ** 2), ('global', None)]


def nae(pair, scale):
    """Held-out error; for bridges applied before their overlap years (Aqua, Terra) the larger of the forward test and the backcast."""
    try: e = float(rep[pair]['test']['scales'][scale]['pred']['nae'])
    except (KeyError, TypeError): sys.exit(f'No test-year error for {pair} at {scale}: run harmonize.py on the full archive first (no invented fallback).')
    b = rep[pair].get('backcast', {}).get('scales', {}).get(scale, {}).get('pred', {}).get('nae')
    return max(e, float(b)) if b is not None else e


rows = []
for scale, unit_area in SCALES:
    a = nae('aqua_to_snpp', scale); t = nae('terra_to_aqua', scale); j = nae('noaa20_to_snpp', scale)
    # Terra chains Terra->Aqua->S-NPP: combined in quadrature as an approximation (assumes independent errors; not an interval).
    rows.append({'scale': scale, 'unitAreaKm2': unit_area, 'aqua': round(a, 4), 'terra': round(math.sqrt(a ** 2 + t ** 2), 4), 'noaa20': round(j, 4)})
out = app / 'public' / 'data' / 'harmonized'; out.mkdir(parents=True, exist_ok=True)
(out / 'relative-error.json').write_text(json.dumps(rows, indent=1))
print(json.dumps(rows))
