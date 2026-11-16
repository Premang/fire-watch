#!/bin/bash
# Rebuild every derived product once all yearly zips are aggregated (aggregate_global.py ZIP AGG, per zip).
#   static backfill -> platform masks -> harmonization + validation -> uncertainty table -> cell-month product -> web tiles/presets/meta
# Usage: PYTHON=/path/to/python run_all.sh GLOBAL_FIRMS_DIR APP_DIR
set -euo pipefail
ROOT=${1:?GLOBAL_FIRMS_DIR}; APP=${2:?APP_DIR}; PY=${PYTHON:-python3}
D=$(cd "$(dirname "$0")" && pwd)
step() { echo "== $(date -u +%H:%M:%S) $*"; }
step static;       "$PY" -I "$D/extract_static.py" "$ROOT/zips" "$ROOT/agg"
step masks;        "$PY" -I "$D/build_platform_masks.py" "$ROOT"
step harmonize;    "$PY" -I "$D/harmonize.py" "$ROOT" "$ROOT/harmonization"
step uncertainty;  "$PY" -I "$D/relative_error.py" "$ROOT/harmonization" "$APP"
step products;     "$PY" -I "$D/build_products.py" "$ROOT" "$ROOT/harmonization" "$ROOT/products"
step web;          rm -rf "$APP/public/data/harmonized/tiles" "$APP/public/data/harmonized/presets"
                   "$PY" -I "$D/build_web.py" "$ROOT/products" "$ROOT/harmonization" "$ROOT/boundaries" "$APP"
step daily;        "$PY" -I "$D/build_daily_climatology.py" "$ROOT" "$ROOT/harmonization" "$ROOT/boundaries" "$APP"
step done;         du -sh "$APP/public/data/harmonized"
