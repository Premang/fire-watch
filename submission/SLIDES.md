# Seven-slide outline (alternative to the video)

The built deck, with the final numbers and screenshots, is at https://claude.ai/artifact/V82TpAXkzLxxaDjhGuRXoU
(private; downloads as PPTX or PDF). It contains two `[Team name]` placeholders.

1. **Fire Watch: every fire season, on one scale.**
   - Team name, challenge (MODIS and VIIRS Hot Spots), one screenshot of Córdoba's calendar.
   - Tagline: "26 years of NASA fire satellites, harmonized so a change of satellite no longer drives the pattern."
2. **The problem.**
   - The raw MODIS vs raw VIIRS chart for a real area: counts jump in 2012 when VIIRS arrives.
   - Fire managers can't tell whether this year is unusual or the satellite simply changed.
3. **The answer, for Córdoba.**
   - Córdoba: season Jul–Sep (half of a typical year); Oct 2020, during the Sierras fires, at 2.4× its usual level
     (91st percentile); 2003 the most active year; a decline visible in raw MODIS and raw VIIRS alike.
   - The "vs usual" view, and the season-timing chart.
   - Any area: 4,800+ places, drawn polygons and circles, coordinates.
4. **The method.**
   - Flow: 5 km equal-area cell-days → matched days → bridge factors per 320 km region × month,
     shrunk to broader regions → day-by-day splice S-NPP › NOAA-20 › Aqua › Terra → uncertainty.
   - One line on why cell-days: they remove most of the 1 km vs 375 m pixel effect.
5. **Proof.**
   - The validation table: raw → harmonized error at 320 km, leave-region-out, backward-in-time,
     and the sensor-switch step: raw Aqua sits 75% below VIIRS, harmonized 4%. Above/typical/below agreement 35% → 61%; above-normal
     months caught 8% → 58%.
   - "Every number is from years or regions the fit never saw."
6. **Right now, plus evidence to take away.**
   - The near-real-time panel: the latest days vs the same dates in 2003–2025, on the same scale.
   - Exports: CSV with uncertainty and anomalies, PNG with legend, hotspot CSV, share links,
     English and Spanish.
7. **Impact and next steps.**
   - Who uses it: emergency managers, provincial fire services, land managers, scientists.
   - Limits: detections ≠ burned area, smoke and clouds.
   - Next: a FIRMS key backfill that extends the calendar to yesterday (built, not yet run), month-to-date vs the same
     elapsed days in past years, alerts when the pace exceeds usual, more languages.
