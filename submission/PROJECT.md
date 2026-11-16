# Fire Watch: every fire season on one scale

*Challenge: MODIS and VIIRS Hot Spots (NASA Space Apps 2026). Submission text; all numbers come from the final full-archive build.*

## High-level summary
Fire Watch is a web app that turns 26 years of NASA satellite fire detections into one consistent
**burning-activity calendar** for any place on Earth. MODIS (2000 onward) and VIIRS (2012 onward)
see fire differently: for the same fires, raw Aqua counts sit about 75% below VIIRS, so the record
jumps roughly 4× when VIIRS takes over. We harmonize both records onto a single scale, Suomi NPP
VIIRS-equivalent 5 km cell-days. That largely removes the sensor-driven discontinuity, and we test the
result on years and regions the method never saw.

You can pick a country or province, draw an area, or type coordinates. The app then shows which
months burn, which years were extreme, and how any month from November 2000 to November 2026
compared with the same month in other years. A live panel shows whether the last few days are
running above the usual pace. The monthly calendar downloads as CSV or PNG, and the latest week's
individual hotspots as CSV.

## What it does
- **Any area of interest.** Search 4,800+ countries and provinces in English or Spanish, draw a
  rectangle, polygon or circle on the map, or enter latitude and longitude with a radius or a
  bounding box. Countries and provinces are computed from exact 5 km cells; drawn areas use 10, 40
  or 160 km tiles.
- **The burning calendar.** A year × month heatmap from November 2000 to November 2026:
  - Two colour modes: activity on a log scale, or "vs usual", the percentile against the same
    month in the other years.
  - Colour-vision-safe ramps (cividis, viridis, inferno, and a blue–orange diverging ramp).
  - Optional numbers in the cells, a table view, and full keyboard navigation.
  - Flags for partial months (sensor outages) and provisional months (the Terra-only bridge).
- **Answers, not just pixels.** For each area, a plain-language summary gives:
  - when the fire season peaks and what share of the year's activity it holds
  - how the latest complete month compares with the same month in other years, by median,
    multi-year average and percentile
  - the most active year and the five most active months on record
  - a planning line based on when a tenth of a typical year's burning has already happened
- **Critical periods over time.** A fire-season timing chart shows, for every year, when 10%, 50%
  and 90% of the year's burning had occurred. Its trend says whether the season is starting earlier
  (Theil–Sen with a Mann–Kendall test). Fire years start after the area's quietest month, so
  southern-summer seasons aren't split in two.
- **English and Spanish.** One click switches the interface, place names and number formats. The
  challenge's partner agency, CONAE, is in Argentina.
- **Right now.** On demand, the app takes the latest complete days of NASA FIRMS near-real-time VIIRS
  (NOAA-20 and NOAA-21) on the same harmonized scale and compares them with the **same dates in 2003–2025**.
  For example: "within the usual range for these dates, median 4.7 per day, middle half 3.0–10.0". The comparison
  draws on each country's and province's own daily harmonized record, rebuilt from the per-day satellite data.
  The month-to-date version is used when the days start on the 1st. Drawn areas fall back to the monthly median's
  daily pace. Known industrial heat sources are masked out using the archive.
- **Context charts:**
  - a seasonal profile with the median and 10th–90th percentile band, plus any chosen year
  - annual totals coloured by source sensor, with bridge-error envelopes and a Theil–Sen trend with a
    Mann–Kendall test
  - a raw MODIS vs raw VIIRS vs harmonized chart for the area, showing the jump the harmonization
    removes
- **Downloads:**
  - monthly calendar CSV with the harmonized value, bridge-error envelope, anomaly, coverage days,
    source sensor and each sensor's raw counts
  - calendar image (PNG) with a quantitative legend
  - CSV of individual hotspots inside the area: the latest 7 days by default, or any period of up
    to 62 days when a free FIRMS key is configured
  - a share link that reopens the exact view
- **Harmonization evidence.** A dedicated page shows, for each sensor bridge, the errors on held-out
  years, on held-out regions and at a staged sensor switch.
- **3D fire view.** From a month in the calendar, open its busiest fire day in 3D. The land is the
  real terrain with real ground imagery. Fire is drawn where the VIIRS satellite detected it, smoke
  blows with the wind recorded for that hour, and the light matches the actual time of the pass, day
  or night. You can stand at ground level or fly out to the satellite's view. The flames and smoke
  are simulated, and the page lists what is measured and what is simulated.

## How it works
1. **Data.** We use the NASA FIRMS standard-processing archives for every country:
   - MODIS Collection 6.1 (Terra and Aqua), 2000–2026
   - VIIRS 375 m from Suomi NPP (2012 – 2 Nov 2026), NOAA-20 (2018–2026) and NOAA-21 (2026)
   - NOAA-21 and all three near-real-time feeds for recent days

   Filters: presumed vegetation fires only (FIRMS `type` 0), MODIS confidence ≥ 30, VIIRS nominal or
   high.
2. **A unit that survives the pixel-size change.** Each detection is assigned to a 5 km cell on an
   equal-area grid. The unit is the **cell-day**: one cell with at least one detection on one day,
   counted for each satellite separately. Counting cells rather than pixels removes most of the 1 km
   vs 375 m difference.
3. **Matched days only.** A satellite counts as "delivering" on a day when its global detections
   reach at least half of its usual (31-day median) level. Bridge factors are fitted only on days
   when both satellites were delivering.
4. **Bridge factors.** Three separate bridges: Aqua→S-NPP, NOAA-20→S-NPP and Terra→Aqua.
   - Each ratio is fitted per 320 km region × calendar month.
   - Sparse regions are shrunk toward broader ones: 1,280 km region → 15° latitude band → global
     month.
   - The shrinkage strength is tuned on separate years.
5. **Day-by-day splice.** Each day takes the best available satellite, in the order S-NPP › NOAA-20
   (and NOAA-21) › Aqua › Terra, converted to the S-NPP scale. NOAA-20 carries the record past the
   end of Suomi NPP's mission.
6. **Error envelopes.** Each bridged month carries the held-out error of its bridge at the largest
   validated scale that fits inside the area (40 km, 320 km or 1,280 km), so an area between two scales
   gets the more conservative one. These are empirical error envelopes, not confidence intervals.

## How well it works (held-out validation)
Every number below comes from data the fit never saw. Errors are normalized absolute errors of monthly totals,
compared with what the reference satellite actually recorded.

| Bridge (used for) | Test years | Error, 320 km regions: raw → harmonized | Global monthly error (bias) | Regions left out of the fit | Backward in time | Step at a staged sensor switch: raw → harmonized |
|---|---|---|---|---|---|---|
| MODIS Aqua → VIIRS S-NPP (2002–2011, outages) | 2020–21 | 75% → **16%** | 75% → **4.2%** (−2.9%) | 29% | 15% (2012–13) | **−75% → −4%** |
| VIIRS NOAA-20 → VIIRS S-NPP (outages; after 2 Nov 2026) | 2023–25 | 5% → 5% | 1.9% → **0.8%** (+0.4%) | 5% | — | +1.9% → **+0.3%** |
| MODIS Terra → MODIS Aqua (Nov 2000 – Jun 2002) | 2012–13 | 56% → **21%** | 51% → **4.2%** (+0.1%) | 46% | 21% (2003–04) | **−50% → +1%** |

Notes on the table:
- **Aqua through its 2022–2025 orbit drift:** 18% at 320 km, 3.7% globally.
- **NOAA-20 and Suomi NPP carry the same VIIRS instrument.** Their counts already agree to about 5% at 320 km, so the
  bridge only removes a small global offset. Tuning correctly chose a near-global factor.
- **Error falls quickly with area.** Single 40 km cells are noisy (41% for Aqua), because two satellites passing at
  different times see different fires. Province- and country-sized areas are stable.
- **The app's error envelopes use these errors at the matching scale.** For bridges applied before their overlap
  period, they use the larger of the forward and backward errors. Terra months chain two bridges, combined in
  quadrature as an approximation.
- **One caveat on independence.** The shrinkage strength (λ, one number per bridge) was tuned once on all regions,
  so the leave-region-out and backward checks are conditional on that choice.
- **Above / typical / below agreement.** This is the app's own question: is a month below, near or above the
  same month in other years? It is scored for every 320 km region with regular burning (at least 50 reference
  cell-days in the test years) and every test month, against the reference satellite's own answer. Chance, from the
  observed class frequencies, is about a third (31–35% across bridges and methods). **Aqua → S-NPP agrees 61% of the time, against 35% for a raw splice. Raw
  splicing catches only 8% of truly above-normal months, harmonization 58%**, as many as a single-satellite
  analysis catches. Terra → Aqua is 65% against 59%. NOAA-20 is 81% either way, since it is the same instrument.
- **Sanity check:** the pipeline's sensor-availability rule independently flags the known Terra outages of June–July
  2001 and March–April 2002 as partial months.

Scale of the product: 68.7 million cell-months over 3.01 million 5 km cells, Nov 2000 – Nov 2026.

## Why it matters
Fire managers ask simple questions: *When does our season start? Was last year unusual? Is this week
worse than normal?* With raw counts, the honest answer is "it depends on the satellite". Fire Watch
gives one consistent record from November 2000 to November 2026 for any area a user draws, plus a
live check of the latest week. This lets
emergency managers, land managers and scientists:
- time surveillance and prevention before the season
- recognise months that break historical patterns
- export the evidence for reports

The default view, Córdoba, Argentina, makes this concrete:
- A late-winter season, July–September, holds half of a typical year's activity. A tenth of the year's burning has
  typically already happened by mid-May.
- October 2020, during the large Sierras de Córdoba fires, stands out at 2.4× its usual level (91st percentile).
- 2003 remains the most active year on record. The long decline since then appears in raw MODIS and raw VIIRS alike,
  so it is not an artefact of the sensor change.

## Status: what is demonstrated and what needs a key
- **Demonstrated (no key needed):**
  - the harmonized calendar, Nov 2000 – Nov 2026, for any area, with the validation shown
  - the live 7-day pace check
  - calendar CSV and PNG
  - latest-week hotspot CSV
  - English and Spanish
- **Run against NASA's API with a free FIRMS key** (the server needs `FIRMS_MAP_KEY`; without it these fall back to
  NASA's public 7-day files):
  - the 2026 backfill that extends the calendar to the present: run on 14 November 2026 (FIRMS Area API, 1 January to
    13 November 2026). November 2026 is a partial month and is flagged as one.
  - hotspot export for any past period of up to 62 days: checked on 15 November 2026 (October 2020 around Córdoba
    returned 5,133 detections from MODIS, Suomi NPP and NOAA-20).
- **Implemented, not exercised end to end with a key:** month-to-date pace.
- **Done for countries and provinces:** "Right now" compares the latest days with the same dates in 2003–2025, from
  per-place daily climatologies. Its month-to-date variant is used with a FIRMS key. Drawn areas still use the
  monthly pace.

## Honest limits
- Agreement between satellites is not ground truth: clouds, smoke and overpass timing hide fires
  from every sensor.
- Cell-days measure where and how often burning was detected, not burned area or the number of
  individual fires.
- Agricultural and prescribed burning are included.
- Near-real-time data lack the vegetation flag, so known static heat sources are masked using the
  archive.
- The "right now" pace is an early signal over a few days. The monthly calendar is the official
  comparison.
- The 3D fire view is an illustration, not a camera image. Fire positions are satellite detections
  (375 m pixels); the flames, the smoke and the exact line of the fire between detections are
  simulated. It is not for safety or operational decisions.

## Tools
- Languages: Python and TypeScript.
- Pipeline: pandas, NumPy, DuckDB, PyArrow, Shapely and pyproj.
- Web app: Next.js on Cloudflare Workers, React, Leaflet, Esri basemaps and Lucide icons.
- 3D fire view: three.js (WebGL 2), open elevation tiles, Esri World Imagery, Open-Meteo wind
  records and photo-scanned plants from Poly Haven.
- Data products: custom binary tiles (gzipped varints) plus per-place series, 188 MB in total.
- Tests: 192 automated tests, including Python ↔ TypeScript tile-format parity.

## Space agency data
- NASA FIRMS MODIS Collection 6.1 and VIIRS 375 m active fire archives (standard processing), all
  countries.
- NASA FIRMS near-real-time MODIS, VIIRS NOAA-20 and VIIRS NOAA-21.

Citations are in `DATA-CITATIONS.md`.

## Use of artificial intelligence
See `AI-USE.md`.
