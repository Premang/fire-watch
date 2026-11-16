"""Download the fixed official FIRMS country archives used by Ember Atlas."""
import concurrent.futures
import json
import time
import urllib.request
from paths import parse_paths

JOBS = [("modis", year) for year in range(2001, 2026)] + [
    ("viirs-snpp", year) for year in range(2012, 2026)
]


def download(job, archive_dir):
    sensor, year = job
    url = (
        "https://firms.modaps.eosdis.nasa.gov/data/country/"
        f"{sensor}/{year}/{sensor}_{year}_United_States.csv"
    )
    destination = archive_dir / f"{sensor}_{year}.csv"
    temporary = destination.with_suffix(".csv.part")
    start = time.monotonic()
    try:
        if not destination.exists():
            with urllib.request.urlopen(url, timeout=100) as response, temporary.open("wb") as output:
                while block := response.read(1024 * 1024):
                    output.write(block)
            temporary.replace(destination)
        size = destination.stat().st_size
        print(f"{sensor} {year}: {size / 1e6:.1f} MB, {time.monotonic() - start:.1f}s", flush=True)
        return {"sensor": sensor, "year": year, "url": url, "bytes": size,
                "path": str(destination), "ok": True}
    except Exception as error:
        temporary.unlink(missing_ok=True)
        print(f"FAILED {sensor} {year}: {error}", flush=True)
        return {"sensor": sensor, "year": year, "url": url, "ok": False, "error": str(error)}


def main():
    args = parse_paths("Download MODIS 2001–2025 and Suomi NPP VIIRS 2012–2025 US science archives.")
    archive_dir = args.cache_dir / "archive"
    archive_dir.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda job: download(job, archive_dir), JOBS))
    (args.cache_dir / "archive-manifest.json").write_text(json.dumps(results, indent=2))
    print("TOTAL MB", sum(result.get("bytes", 0) for result in results) / 1e6, flush=True)
    if any(not result["ok"] for result in results):
        raise SystemExit("Some downloads failed; inspect the manifest and rerun before aggregating.")


if __name__ == "__main__":
    main()
