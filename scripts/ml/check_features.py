#!/usr/bin/env python3
"""Build independent Python feature/projection references for the JavaScript tests.

Run after changing train.py or fire-predictor.ts, then run the Node predictor test.
--model-dir also refreshes model probability fixtures from a completed training.
Requires the training dependencies. --data optionally audits every source TIFF's
shape, CRS, pixel origin, and spacing across the four-day event windows. No
network requests, model fitting, label-based selection, or app data changes.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from pyproj import Transformer
import tifffile

from train import FEATURES, block, features

APP = Path(__file__).resolve().parents[2]


def safe(value):
    if isinstance(value, dict):
        return {key: safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [safe(item) for item in value]
    if isinstance(value, np.ndarray):
        return safe(value.tolist())
    if isinstance(value, (float, np.floating)):
        return float(value) if np.isfinite(value) else None
    if isinstance(value, (np.integer, np.bool_)):
        return value.item()
    return value


def weather_fields(w):
    return dict(precip=w[5], tmin=w[8], tmax=w[9], q=w[11], wind=w[6],
                direction=w[7], erc=w[10], pdsi=w[15])


def fixture_case(name, size, recent_points, prior_points, kind="plane"):
    rows, cols = np.indices((size, size))
    recent = np.zeros((size, size), dtype=bool)
    prior = np.zeros_like(recent)
    for row, col in recent_points:
        recent[row, col] = True
    for row, col in prior_points:
        prior[row, col] = True
    elev = 1000. + 30 * cols + 15 * rows
    if kind == "curved":
        elev += .5 * rows**2 - 2 * cols**2
    if kind == "flat":
        elev[:] = 1000
    weather = np.zeros((size, size, 23))
    for band, value in {5: 2.4, 6: 8., 8: 273.15, 9: 300.15,
                        10: 54., 11: .005, 15: -1.3}.items():
        weather[..., band] = value + rows * .001 + cols * .0001
    weather[..., 7] = np.array([359., 1., 0., 360., -1.])[cols % 5]
    forecast = np.zeros_like(weather)
    forecast[..., 18] = 4.5 + rows * .01
    forecast[..., 20] = 22. + cols * .1
    forecast[..., 21] = .007
    if kind == "missing":
        elev[2, 2] = np.nan
        elev[3, 3] = np.nan
        weather[1, 1, 5] = np.nan
        weather[1, 1, 7] = np.nan
        forecast[1, 1, 21] = np.nan
    expected = features(recent, prior, elev, weather, forecast)
    positions = sorted({(0, 0), (0, size - 1), (size - 1, 0),
                        (size - 1, size - 1), (1, 1), (1, 2), (2, 1),
                        (2, 2), (3, 3), (size // 2, size // 2),
                        (size // 2 + 1, size // 2 + 1)})
    queries = []
    for row, col in positions:
        f = forecast[row, col]
        for width, feature_index in [(3, 4), (7, 5)]:
            radius = (width - 1) // 2
            count = int(recent[max(0, row - radius):row + radius + 1,
                               max(0, col - radius):col + radius + 1].sum())
            assert expected[row, col, feature_index] == count / width**2, "Density must use exact integer counts before division"
        queries.append(dict(row=row, col=col,
                            weather=weather_fields(weather[row, col]),
                            gfs=dict(temperatureC=f[20], q=f[21], vectorWind=f[18]),
                            expected=expected[row, col]))
    return safe(dict(name=name, size=size, recent=recent.ravel(),
                     prior=prior.ravel(), elevation=elev.ravel(), queries=queries))


def audit_data(directory):
    manifest = json.loads((directory / "ready-events.json").read_text())
    if not manifest["complete"]:
        raise ValueError("Cannot audit an incomplete extraction")
    identities = set()
    shapes = set()
    years = {}
    files = 0
    for event in manifest["events"]:
        if event["event"] in identities:
            raise ValueError("Duplicate event across splits")
        identities.add(event["event"])
        expected = None
        dates = []
        for source in event["files"]:
            # Prefer the requested cache location over absolute paths in old manifests.
            path = directory / source["name"]
            with tifffile.TiffFile(path) as tif:
                shape = tif.series[0].shape
                geo = tif.geotiff_metadata
            if shape[-1] != 23 or geo["ModelPixelScale"][:2] != [375., 375.]:
                raise ValueError(f"Unexpected channels or pixel scale: {source['name']}")
            if geo["ModelTiepoint"][:3] != [0., 0., 0.]:
                raise ValueError(f"Unsupported nonzero raster tiepoint: {source['name']}")
            crs = int(geo["ProjectedCSTypeGeoKey"])
            if not 32601 <= crs <= 32660:
                raise ValueError(f"Not a northern WGS84 UTM CRS: {source['name']}")
            identity = (shape, crs, tuple(geo["ModelTiepoint"]), tuple(geo["ModelPixelScale"]))
            if expected is not None and identity != expected:
                raise ValueError(f"Four-day raster alignment differs: {event['event']}")
            expected = identity
            dates.append(np.datetime64(path.stem))
            shapes.add(shape)
            files += 1
        if len(dates) != 4 or any(dates[i + 1] - dates[i] != np.timedelta64(1, "D") for i in range(3)):
            raise ValueError(f"Nonconsecutive source dates: {event['event']}")
        year = int(str(dates[0])[:4])
        expected_splits = {"train"} if year in (2018, 2019) else {"validation", "selection", "calibration"} if year == 2020 else {"test"} if year == 2021 else set()
        if event["split"] not in expected_splits:
            raise ValueError(f"Year split differs from protocol: {event['event']}")
        years[str(year)] = years.get(str(year), 0) + 1
    return dict(events=len(identities), files=files, eventsByYear=years,
                uniqueRasterShapes=len(shapes), alignment="All four daily TIFFs share shape, CRS, tiepoint and375m spacing.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=APP / "tests/fixtures/fire-features.json")
    parser.add_argument("--data", type=Path)
    parser.add_argument("--model-dir", type=Path)
    args = parser.parse_args()
    # Verify aggregation conventions independently of the TS builder.
    raw = np.full((8, 8), np.nan)
    raw[0, 0] = 0.  # Midnight is an actual detection, not a false boolean value.
    assert block(np.isfinite(raw).astype(float), "max").tolist() == [[1., 0.], [0., 0.]]
    angle = np.tile([359., 1., 359., 1.], (4, 1))
    circular = np.degrees(np.arctan2(block(np.sin(np.radians(angle))), block(np.cos(np.radians(angle))))) % 360
    assert min(abs(circular.item()), abs(circular.item() - 360)) < 1e-10
    assert block(np.ones((9, 10))).shape == (2, 2)
    cases = [
        fixture_case("row-major ties and planar terrain", 9, [(2, 4), (4, 2), (4, 6), (6, 4)], [(0, 0)]),
        fixture_case("empty prior and curved terrain", 9, [(1, 1), (7, 6)], [], "curved"),
        fixture_case("all-fire finite border densities", 5, list(np.ndindex(5, 5)), [(4, 4)], "flat"),
        fixture_case("no detections sentinel", 7, [], [], "flat"),
        fixture_case("missing terrain and covariates", 7, [(0, 0), (4, 4)], [(2, 5)], "missing"),
    ]
    projections = []
    for lat, lon in [(39.8, -121.6), (49., -124.999), (25., -80.), (30., -95.4),
                     (45., -120.), (47., -114.000001), (47., -113.999999), (30., -100.)]:
        zone = int((lon + 180) // 6) + 1
        x, y = Transformer.from_crs(4326, 32600 + zone, always_xy=True).transform(lon, lat)
        projections.append(dict(lat=lat, lon=lon, zone=zone, x=x, y=y))
    result = dict(schemaVersion=1,
                  description="Deterministic numerical unit-test inputs, not satellite observations or training data.",
                  reference="Python train.features (NumPy/SciPy) and pyproj WGS84 UTM; regenerate with scripts/ml/check_features.py",
                  featureNames=FEATURES, cases=cases, projections=projections)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    summary = dict(featureVectors=sum(len(c["queries"]) for c in cases), projectionReferences=len(projections),
                   sha256=hashlib.sha256(args.output.read_bytes()).hexdigest(), output=str(args.output))
    if args.data:
        summary["sourceAudit"] = audit_data(args.data)
    if args.model_dir:
        model_bytes = (args.model_dir / "model.json").read_bytes()
        model = json.loads(model_bytes)
        parity = json.loads((args.model_dir / "parity.json").read_text())
        report = json.loads((args.model_dir / "evaluation.json").read_text())
        digest = hashlib.sha256(model_bytes).hexdigest()
        assert report["modelSha256"] == digest, "Model and evaluation are from different runs"
        assert len(parity["vectors"]) == len(parity["probabilities"]) == report["test"]["model"]["cells"], "Export every held-out vector"
        assert model["features"] == FEATURES, "Fitted feature order has changed"
        parity["modelSha256"] = digest
        parity["source"] = "Python sklearn training export; every held-out feature vector, without outcome selection."
        path = args.output.parent / "fire-model-parity.json"
        path.write_text(json.dumps(parity, separators=(",", ":"), allow_nan=False) + "\n")
        summary["modelParityVectors"] = len(parity["vectors"])
        summary["modelParityOutput"] = str(path)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
