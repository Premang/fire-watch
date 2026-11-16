"""Read completed fire lines for one fire from a NIFC Operational Data Archive file geodatabase (2020, 2021).
Returns the same structure as fireline_effect.fetch_lines: paths in the fire's UTM zone, dates in ms."""
import json, math, struct
from pathlib import Path
import numpy as np

WHERE = "FeatureCategory LIKE 'Completed%' OR FeatureCategory = 'Road as Completed Line' OR FeatureCategory = 'Line Break Completed'"

def to_utm(lon, lat, epsg):
    """Forward UTM on WGS84 (northern zones), standard series; accurate to well under a metre."""
    assert 32601 <= int(epsg) <= 32660
    a, f, k0 = 6378137.0, 1 / 298.257223563, 0.9996; e2 = f * (2 - f); ep2 = e2 / (1 - e2)
    lon0 = math.radians((int(epsg) - 32600) * 6 - 183); p = np.radians(np.asarray(lat, float)); l = np.radians(np.asarray(lon, float)) - lon0
    s, c, t = np.sin(p), np.cos(p), np.tan(p); N = a / np.sqrt(1 - e2 * s**2); T = t**2; C = ep2 * c**2; A = c * l
    M = a * ((1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256) * p - (3 * e2 / 8 + 3 * e2**2 / 32 + 45 * e2**3 / 1024) * np.sin(2 * p) + (15 * e2**2 / 256 + 45 * e2**3 / 1024) * np.sin(4 * p) - (35 * e2**3 / 3072) * np.sin(6 * p))
    x = k0 * N * (A + (1 - T + C) * A**3 / 6 + (5 - 18 * T + T**2 + 72 * C - 58 * ep2) * A**5 / 120) + 500000
    y = k0 * (M + N * t * (A**2 / 2 + (5 - T + 9 * C + 4 * C**2) * A**4 / 24 + (61 - 58 * T + T**2 + 600 * C - 330 * ep2) * A**6 / 720))
    return x, y

def wkb_lines(buf):
    """Minimal WKB reader for LineString / MultiLineString (any Z/M flags). Returns a list of (n,2) arrays."""
    out = []; view = memoryview(buf)
    def read(o):
        e = '<' if view[o] == 1 else '>'; kind, = struct.unpack_from(e + 'I', view, o + 1); o += 5
        base = kind & 0xFF if kind > 3000 or kind & 0xE0000000 else kind % 1000
        dims = 2 + (1 if (kind & 0x80000000 or (kind // 1000) in (1, 3)) else 0) + (1 if (kind & 0x40000000 or (kind // 1000) in (2, 3)) else 0)
        if base == 2:
            n, = struct.unpack_from(e + 'I', view, o); o += 4
            arr = np.frombuffer(view, dtype=e + 'f8', count=n * dims, offset=o).reshape(n, dims)[:, :2]; out.append(arr); return o + n * dims * 8
        if base in (5, 7):
            n, = struct.unpack_from(e + 'I', view, o); o += 4
            for _ in range(n): o = read(o)
            return o
        raise ValueError(f'Unsupported WKB type {kind}')
    read(0); return out

def ms(v):
    if v is None: return None
    try:
        if np.isnat(v): return None
    except TypeError: pass
    return float(np.datetime64(v, 'ms').astype('int64'))

def fetch_lines_gdb(event, cache, gdb):
    from pyogrio.raw import read
    f = Path(cache) / (event['event'].replace('/', '_') + '.json')
    if f.exists(): return json.loads(f.read_text())
    bbox = (float(event['lon'].min()) - .05, float(event['lat'].min()) - .04, float(event['lon'].max()) + .05, float(event['lat'].max()) + .04)
    import pyogrio
    # Layer name and coordinate system differ by year: 2020 is EventLine in EPSG:4326, 2021 is Event_Line_2021 in Web Mercator.
    layer = next(n for n, _ in pyogrio.list_layers(str(gdb)) if 'line' in n.lower())
    merc = '3857' in str(pyogrio.read_info(str(gdb), layer=layer)['crs'])
    R = 6378137.0
    if merc:
        fx = lambda lon: R * np.radians(lon); fy = lambda lat: R * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))
        bbox = (fx(bbox[0]), fy(bbox[1]), fx(bbox[2]), fy(bbox[3]))
    meta, _, geoms, fields = read(str(gdb), layer=layer, bbox=bbox, where=WHERE, columns=['FeatureCategory', 'LineDateTime', 'CreateDate'])
    names = list(meta['fields']); cat, line, created = (fields[names.index(k)] for k in ('FeatureCategory', 'LineDateTime', 'CreateDate'))
    feats = []
    for i, g in enumerate(geoms):
        if g is None: continue
        paths = []
        for arr in wkb_lines(g):
            if merc: arr = np.stack([np.degrees(arr[:, 0] / R), np.degrees(2 * np.arctan(np.exp(arr[:, 1] / R)) - np.pi / 2)], 1)
            x, y = to_utm(arr[:, 0], arr[:, 1], event['epsg']); paths.append(np.stack([x, y], 1).round(1).tolist())
        feats.append({'category': cat[i], 'line': ms(line[i]), 'created': ms(created[i]), 'paths': paths})
    f.parent.mkdir(parents=True, exist_ok=True); f.write_text(json.dumps(feats, separators=(',', ':')))
    return feats
