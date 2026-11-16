# Fire Watch: a fire calendar for any place on Earth

**NASA Space Apps 2026 · MODIS and VIIRS Hot Spots challenge.** Fire Watch turns 26 years of NASA FIRMS active-fire
detections (MODIS Terra/Aqua 2000–, VIIRS Suomi NPP 2012–, NOAA-20 2018–, NOAA-21 2026) into one consistent
**burning-activity calendar** for any area on Earth. Older (MODIS) and newer (VIIRS) satellites count fire differently,
so Fire Watch converts the older counts to the newer scale; you can then see when a place usually burns, spot unusual
months, and compare the latest satellite passes with the usual pace. Tested on years it had never seen, the error in
monthly fire counts drops from 75% to 16%.

- **Demo video (30 s):** https://drive.google.com/file/d/1xq4wRLl68Z-2-atgaKWbH-gVzhDYSjOo/view (also `submission/fire-watch-demo.mp4`)
- **Project write-up:** [`submission/PROJECT.md`](submission/PROJECT.md) · data sources: [`submission/DATA-CITATIONS.md`](submission/DATA-CITATIONS.md) · use of AI: [`submission/AI-USE.md`](submission/AI-USE.md)
- **Screenshots of the 3D fire view:** [`submission/3d-view-night.jpg`](submission/3d-view-night.jpg), [`submission/3d-view-day.jpg`](submission/3d-view-day.jpg)

## Run

Requires Node.js 22.13+.

```sh
npm install
npm run dev        # http://localhost:5173 — opens on the global burning calendar
```

Optional: `FIRMS_MAP_KEY` (free, https://firms.modaps.eosdis.nasa.gov/api/map_key/) enables hotspot exports for any
period up to 62 days and month-to-date comparisons; without it the app uses NASA's public global 7-day files.

## The global burning calendar

- **Any area:** search 4,800+ countries/provinces (English/español), draw a rectangle, polygon or circle, or enter
  coordinates. Presets use exact 5 km cells; drawn areas use 10/40/160 km tiles (`lib/harmonized/data.ts`).
- **Calendar:** year × month heatmap, Nov 2000 – Nov 2026 (November 2026 partial); activity (log scale) or "vs usual" (percentile against the
  same month in the other baseline years — one shared policy, `analytics.monthAnomaly`); colour-vision-safe ramps,
  numbers on demand, table view, keyboard navigation; partial and provisional months flagged.
- **Answers:** season peak and share, latest month vs usual (median, mean, percentile), most active years and months,
  trend (Theil–Sen + Mann–Kendall), fire-season timing per year (onset/midpoint/end and their trends), seasonal profile,
  annual totals by source sensor with uncertainty, raw-vs-harmonized chart. English / Spanish interface.
- **Right now:** latest complete days of FIRMS NRT VIIRS (NOAA-20/21) on the same scale, compared with the same dates in
  2003–2025 for countries and provinces (per-place daily climatology, `build_daily_climatology.py`; month-to-date with a
  FIRMS key), else with the usual daily pace. Platform availability is checked globally, quiet days stay zeros and static
  heat sources are masked (`lib/harmonized/recent.ts`).
- **Exports:** monthly calendar CSV (value, uncertainty, anomaly, coverage, source, raw counts), calendar PNG with a
  quantitative legend, hotspot CSV for the exact area, shareable links.
- **Harmonization evidence:** held-out years, leave-region-out cross-validation, backcast, staged sensor switch.

### Method (scripts/global/)
1. `aggregate_global.py` — FIRMS yearly all-countries archives → per-satellite 5 km equal-area cell-day bitmasks
   (type 0 vegetation fires; MODIS confidence ≥ 30, VIIRS nominal/high).
2. `build_platform_masks.py` — per-platform masks and daily global availability.
3. `harmonize.py` — bridge factors (Aqua→S-NPP, NOAA-20→S-NPP, Terra→Aqua) per 320 km region × calendar month on
   matched days, shrunk to 1,280 km / latitude band / global; λ tuned on separate years; validated on held-out years,
   5-fold leave-region-out CV, backcast and a staged switch.
4. `relative_error.py` — uncertainty table from held-out errors by spatial scale.
5. `build_products.py` — day-by-day splice S-NPP › NOAA-20/21 › Aqua › Terra on the S-NPP scale (DuckDB).
6. `build_web.py` — EAT1 binary tiles, exact presets, `meta.json`.
7. `build_daily_climatology.py` — per-place daily series and same-date quantiles for "Right now". `run_all.sh` runs steps 2–7.

See `../submission/RUNBOOK.md` for rebuilding the archive and extending it to the present with the FIRMS API.

### Tests
```sh
npx tsc --noEmit && npm run lint
node --experimental-strip-types --test tests/*.test.ts
```

## U.S. prototype tools (earlier work, kept as secondary pages)

### What works

- All 50 states, DC, and U.S. aggregate historical calendars, 2001–2025.
- MODIS and Suomi NPP VIIRS series, raw counts and deduplicated 5 km occupied cell-days.
- Experimental per-region/month calibration: fit 2012–2021, evaluate 2022–2025.
- Six public FIRMS feeds: MODIS, NOAA-20 and NOAA-21, each for CONUS/Hawaii and Alaska.
- Source health, actual acquisition timestamps, five-minute application polling, sensor filters, interactive maps, and CSV export.
- Live Watch: named NIFC wildfire reports, selectable 40 km areas, age-colored observations, and an acquisition-time timeline for the latest 24 hours.
- Timestamped 24-frame NOAA GOES-East CONUS and GOES-West Pacific Southwest Fire Temperature RGB and GeoColor loops; automatic 60-second refresh, latest-follow mode, playback, and zoom.
- Daily July–August 2021 Dixie-area observation replay, with a prior-day persistence benchmark and precision, recall, and intersection over union.

### Scientific limits (U.S. tools)

This is a research prototype, not an incident command or crew allocation tool. Thermal points are not wildfire incidents or perimeters. Current NRT detections can also include agricultural burns, industrial heat, and volcanoes. The 15 km hotspot groups are grid summaries, not identified fires. NIFC reports identify incident locations, not active flame fronts; nearby hotspots are not automatically attributed to them. Historical records include agricultural/prescribed burning. GeoColor imagery is not a thermal fire product. Fire Temperature RGB highlights relative infrared signals; colors are not measured temperatures or fire boundaries. NOAA scans normally arrive every five minutes over CONUS, with delivery delays and occasional gaps. FIRMS satellite overpasses have a different cadence; five-minute polling does not guarantee new hotspot observations. Satellite basemaps are archival.

The 5 km grid and seasonal adjustment improve comparability, but do not correct all sensor detection, cloud, viewing geometry, and revisit biases. MODIS is not ground truth. Mean absolute error measures intersensor agreement only. Known partial months are omitted from calibration, baselines, evaluation, and the adjusted index; raw partial totals remain inspectable. Zero detections never establish no fire.

The replay benchmark predicts persistence of detected cells, not physical fire spread. Future spread modeling needs terrain, fuels, weather, perimeters, uncertainty estimates, and independent validation before any response planning.

### Data and implementation (U.S. tools)

- `public/data/history-index.json`: official source URLs, source versions, retrieval time, coverage flags, region index.
- `public/data/history/`: daily and monthly regional histories.
- `public/data/dixie-replay.json`: actual archived observations in the Dixie-area bounding box; no incident attribution is assumed.
- `public/data/us-states.json`: Census 2025 cartographic boundaries.
- `lib/history.ts`: seasonal calibration and missing-data handling.
- `lib/fire-analysis.ts`: CSV parsing, time/coordinate checks, sensor-cell-day counting.
- `app/api/fires/route.ts`: allowlisted current NASA feeds, source-level failures and five-minute memory cache.
- `app/api/imagery/route.ts`: allowlisted NOAA directory reads; acquisition times decoded from filenames, 60-second cache.
- `app/api/incidents/route.ts`: official NIFC/WFIGS current wildfire reports, capped at 150 recent eligible incidents, five-minute cache and explicit source failures.
- `lib/live-timeline.ts`: acquisition-time filtering, fixed hourly frames, 15 km grouping, and injected-clock age labels.

No source credentials or API key are needed for these public feeds. Raw NASA CSV archives are kept outside the public directory. Source observations are static through December 2025; current feeds refresh independently.

### Validation (U.S. tools)

```sh
npx tsc --noEmit
npm run lint
node --experimental-strip-types --test tests/*.test.ts
```

The 28 tests cover malformed inputs, UTC grouping, grid deduplication, inactive-sensor periods, training/holdout separation, partial-month handling, and real-archive calibration invariants, future-observation exclusion, fixed replay boundaries, and valid grouping metadata. Browser QA covers state filtering, calendar inspection, CSV download contents, NOAA playback, replay controls, and responsive layouts.
