# Rebuild the historical observation data

This offline pipeline produced the application's historical JSON. It downloads official NASA FIRMS science archives, computes per-state observations, and marks missing source dates. It does not generate synthetic detections or fit the app's sensor-calibration model.

## Requirements

Use Python 3.9 or newer with NumPy and Shapely 2.x. No pandas or pyshp is needed for these scripts. From the repository root:

```sh
python3 -m venv work/archive-venv
work/archive-venv/bin/python -m pip install numpy 'shapely>=2,<3'
work/archive-venv/bin/python scripts/archive/download.py
work/archive-venv/bin/python scripts/archive/aggregate.py
work/archive-venv/bin/python scripts/archive/mark-gaps.py
```

Run all three steps in that order. Downloads total approximately 814 MB for the 39 files used in this snapshot; they are cached and reused. Four independent files are processed concurrently. The existing `/work/` rule in `.gitignore` excludes caches, intermediate aggregates, and the virtual environment.

Every command accepts `--cache-dir` and `--output-dir`. Defaults resolve relative to the repository, regardless of your current working directory:

- Cache: `work/archive` (CSVs in `work/archive/archive/`, manifest and intermediate aggregates alongside that subdirectory).
- Outputs: `public/data`.

`EMBER_ARCHIVE_CACHE` and `EMBER_DATA_OUTPUT` environment variables can override the defaults; command-line arguments take precedence. To reuse an existing cache, supply the directory containing `archive-manifest.json` and `archive/`. An alternate output directory must already contain a copy of `us-states.json`, for example:

```sh
mkdir -p work/rebuilt-data
cp public/data/us-states.json work/rebuilt-data/
work/archive-venv/bin/python scripts/archive/aggregate.py --cache-dir /path/to/existing/data-research --output-dir work/rebuilt-data
work/archive-venv/bin/python scripts/archive/mark-gaps.py --cache-dir /path/to/existing/data-research --output-dir work/rebuilt-data
```

Aggregation overwrites `history.json`, `history-index.json`, `history/*.json`, and `dixie-replay.json` in the selected output directory. The final gap step updates the histories and availability metadata. It is safe to rerun that step. The `retrievedAt` metadata records rebuild time, so rebuilt files are not byte-identical. The scripts preserve the calculation and output schema used in the bundled snapshot; upstream archive revisions may change observations.

## Sources and calculation

Official country archive URL pattern:

```text
https://firms.modaps.eosdis.nasa.gov/data/country/{sensor}/{year}/{sensor}_{year}_United_States.csv
```

The fixed snapshot uses `modis` for 2001–2025 and `viirs-snpp` for 2012–2025. No API key is needed. Each successful source URL, source version, date extent, and row count is included in the generated metadata. Download failures are written to the cache manifest and produce a nonzero exit code; resolve them before proceeding.

The checked-in state geometry is derived from the [2025 Census 1:20 million state boundaries](https://www2.census.gov/geo/tiger/GENZ2025/shp/cb_2025_us_state_20m.zip). These scripts reuse that GeoJSON rather than rebuilding it.

Only FIRMS `type=0` presumed vegetation-fire detections inside the 50 states and DC are retained; all confidence classes remain. MODIS combines Terra and Aqua, while VIIRS uses only Suomi NPP. A spherical cylindrical equal-area grid uses radius 6,371 km, standard parallel 30 degrees, and 5 km cells. Each sensor contributes at most one count per cell per UTC date. Monthly values sum daily occupied cells: they are **cell-days, not burned area**. Raw detection counts are preserved separately.

Suomi NPP dates before January 20, 2012 are null. Dates with no records of any fire type anywhere in the US source archive are also null across all regions. Monthly availability fields measure national archive record availability, not local cloud-free observation. Zero retained detections does not establish zero burning. The replay contains genuine detections in a bounding box around the Dixie Fire region, without attributing each detection to that incident or treating points as perimeters.
