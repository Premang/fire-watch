# Fire Watch — runbook

How to run the app, rebuild the harmonized global record, and extend it to the present.

## Run the app locally
```bash
cd ember-atlas
npm install
npm run dev            # http://localhost:5173 — opens on the Burning calendar
```
Dev-server quirk (Vinext): after editing server routes (`app/api/**`), the dev server can fail with
"Maximum call stack size exceeded" in `als-registry.js` (its AsyncLocalStorage registry grows on every
hot reload). Restart `npm run dev`. Production builds are unaffected.

Tests: `node --experimental-strip-types --test tests/harmonized-*.test.ts` (analytics, tile codec parity,
AOI geometry and aggregation, near-real-time logic). Type check: `npx tsc --noEmit`. Lint: `npm run lint`.

## Optional: full hotspot export and "to the present"
Set a free NASA FIRMS key (email only): https://firms.modaps.eosdis.nasa.gov/api/map_key/
```bash
export FIRMS_MAP_KEY=your_key          # server environment for /api/hotspots
```
- **Without a key:** the hotspot CSV and the "Is this week unusual?" panel use NASA's public global 7-day
  near-real-time files.
- **With a key:** the hotspot CSV covers any period up to 62 days (archive or near-real-time), and the
  panel compares month-to-date.

To extend the calendar itself through yesterday (the yearly archive stops at 2025):
```bash
FIRMS_MAP_KEY=... python ember-atlas/scripts/global/backfill_firms_api.py global-firms --from 2026-01-01
python ember-atlas/scripts/global/build_platform_masks.py global-firms
# then regenerate global-firms/harmonization/availability.json from global-firms/plat/daily_q.json
# (same rule as harmonize.availability; see OVERNIGHT-LOG 2026-11-14) so the new months are included
python ember-atlas/scripts/global/build_products.py global-firms global-firms/harmonization global-firms/products
python ember-atlas/scripts/global/build_web.py global-firms/products global-firms/harmonization global-firms/boundaries ember-atlas
```

## Rebuild the global harmonized record from scratch
Python 3.12 with numpy 1.26.4, pandas 2.2.3, pyarrow 17, duckdb 1.1.3, shapely 2.0.6, scikit-learn 1.4.2.
1. Download the FIRMS standard-processing archive, `*_all_countries.zip` per year, from
   https://firms.modaps.eosdis.nasa.gov/data/country/zips/:
   - MODIS 2000–2025: about 2.0 GB
   - VIIRS S-NPP 2012–2025: about 5.0 GB
   - VIIRS NOAA-20 2018–2025: about 2.8 GB

   Sizes are checked against `yearly_summary_files.txt`, and each zip is tested.
2. `aggregate_global.py ZIP global-firms/agg`, per zip. This writes per-cell monthly day-bitmasks
   with satellite, confidence, day/night and country, plus static-source cells. It takes about
   15–70 s per year.
3. `build_platform_masks.py global-firms`: per-satellite masks (quality filter: MODIS ≥ 30, VIIRS
   nominal/high) and a daily global availability calendar.
4. `harmonize.py global-firms global-firms/harmonization`: fits the bridge factors and writes the
   validation report, which feeds the Evidence page.
5. `relative_error.py global-firms/harmonization ember-atlas`: the uncertainty table.
6. `build_boundaries.py global-firms/boundaries ember-atlas/public/data`: Natural Earth presets.
7. `build_products.py global-firms global-firms/harmonization global-firms/products`: the
   day-level harmonized cell-month product (DuckDB).
8. `build_web.py global-firms/products global-firms/harmonization global-firms/boundaries ember-atlas`:
   tiles, presets and `meta.json`.
9. `build_daily_climatology.py global-firms global-firms/harmonization global-firms/boundaries ember-atlas`: for every
   country and province, the daily harmonized series (same day-level splice), summarised as quantiles over 2003–2025
   of the 7-day window ending on each date and of month-to-date. It takes about 2 minutes and adds 22 MB gzipped, used
   by "Right now". Check: September's month-to-date median × 30 equals the median September total of the calendar.

Steps 3–9 in one command, after all zips are aggregated:
```bash
PYTHON=/path/to/python ember-atlas/scripts/global/run_all.sh global-firms ember-atlas
```

## Data products (`ember-atlas/public/data/`)
- `harmonized/meta.json`: month flags (partial/provisional/source), tile levels, uncertainty table,
  validation report, NRT factors and sources.
- `harmonized/tiles/L{0,1,2}/{tx}_{ty}.bin.gz`: 10 / 40 / 160 km cell-month tiles (EAT1 varint
  format; reader in `lib/harmonized/data.ts`).
- `harmonized/presets/*.json`: exact 5 km monthly series for countries and provinces.
- `harmonized/static-cells.bin`: archive static heat sources, masked out of near-real-time data.
- `aoi/`: Natural Earth countries and provinces, simplified, for search and outlines.

## Deployment notes (not done; nothing is deployed)
- The app is static data (`public/data`, about 150–250 MB) plus one server route, `/api/hotspots`.
- **Without a FIRMS key**, `/api/hotspots` downloads NASA's public global 7-day files: about 30 MB
  for each VIIRS satellite and about 10 MB for MODIS. It keeps a compact copy in memory, roughly
  40–60 MB, for 10 minutes. That works on a normal server, but it is heavy for edge runtimes with
  tight CPU or memory limits.
- **With `FIRMS_MAP_KEY`**, requests use the FIRMS Area API for just the area's bounding box, which
  is small. Use this in production. Routing between standard processing (SP) and near-real-time
  (NRT) follows NASA's `data_availability` table, cached for one hour.
- Static files are gzip-compressed tiles (`*.bin.gz`). Some hosts serve them with
  `Content-Encoding: gzip`, others as raw gzip; the client handles both (`maybeGunzip`).

## Constraints to keep
- The **NOAA-20 trial run** (`ml-n20/shadow/`) is frozen. Don't edit files listed in
  `ml-n20/shadow/protocol.json` → `frozenFiles`; that includes `lib/fire-outlook.ts`,
  `lib/fire-predictor.ts`, `lib/geography.ts` and others. All calendar work lives in new files.
- Nothing here deploys automatically. The hosted site (`.openai/hosting.json`) is updated only
  when you deploy it yourself.

## World fire-seasons map (landing page)
After the web tiles are built, regenerate the 80 km monthly grid behind the animated world map:
`cd ember-atlas && node --experimental-strip-types scripts/global/build_world_seasons.mts`
(writes `public/data/harmonized/world-seasons.bin`, about 324 KB).

## 3D fire view
- Page: `/scene` (`app/scene/page.tsx`, `components/fire-scene-view.tsx`). Engine: `lib/scene3d/` (three.js). Data: `app/api/scene/route.ts` and `lib/scene-data.ts`.
- Links: `/scene?lat=..&lon=..[&date=YYYY-MM-DD]` for a place, `/scene?month=YYYY-MM&west&south&east&north` for the busiest day of a month in a box (needs `FIRMS_MAP_KEY`), `/scene?demo=cordoba` for the bundled example (works without a key).
- What the visitor's browser fetches: elevation tiles from AWS (`elevation-tiles-prod`), imagery tiles from Esri (`server.arcgisonline.com`), about 270 tiles and 5 MB per view. What the server fetches: VIIRS detections from NASA FIRMS and one wind record from Open-Meteo.
- Plant pictures (`public/scene3d/veg-*.webp`, `veg.json`) are baked from Poly Haven models. To rebuild them, in `work/video`:
  `python3 scripts/fetch_polyhaven.py` (205 MB of models), `node scripts/bake/run.mjs 1024`, then `python3 scripts/bake/compose.py ../ember-atlas/public/scene3d`.
- The demo video's 3D shots are filmed from this page. With the app running locally, in `work/video`:
  - the opening (night pass of 5 October 2020):
    `DEMO=cordoba-night END="-32.96,-65.01,30000" OUT=hook QUERY="&path=hook&hold=18" node scripts/scene-film.mjs 150 12`
  - the flight down to the fire line in the one-minute cut (the same night pass; the camera path is in `scripts/keys-dive6.json`):
    `OUT=dive6 node scripts/scene-path.mjs scripts/keys-dive6.json 220 12`
    then the page at the starting view: `node scripts/scene-ui-top.mjs cordoba-night src/dive6.json public/dive6/ui-top.jpg first keep`
  - then `npm run render` (one-minute cut) or `npm run render:30` (30-second cut).
- Tests: `tests/scene3d.test.ts` (detection parsing, satellite passes, fire-front layout, sun and moon position).
