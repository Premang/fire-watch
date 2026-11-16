"""Shared command-line paths for the offline FIRMS archive pipeline."""
import argparse
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def parse_paths(description):
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument(
        "--cache-dir", type=Path,
        default=Path(os.environ.get("EMBER_ARCHIVE_CACHE", REPO_ROOT / "work" / "archive")),
        help="Intermediate directory containing archive/ CSVs and the manifest (default: repo/work/archive).",
    )
    parser.add_argument(
        "--output-dir", type=Path,
        default=Path(os.environ.get("EMBER_DATA_OUTPUT", REPO_ROOT / "public" / "data")),
        help="Public JSON directory; must contain us-states.json before aggregation (default: repo/public/data).",
    )
    args = parser.parse_args()
    args.cache_dir = args.cache_dir.expanduser().resolve()
    args.output_dir = args.output_dir.expanduser().resolve()
    return args
