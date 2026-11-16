EMBER ATLAS: REPRODUCIBLE FIRE-ACTIVITY MODEL V2
Release: 2026-10-25. Model: ember-day-ahead-v2.

This research model estimates retained S-NPP satellite detections in 1.5 km
cells near existing activity. It does not predict flame arrival or establish
safe evacuation, suppression, or crew placement decisions.

WHAT CHANGED
The fixed sample increased from 60 to 250 randomly selected events (1,000
verified daily TIFFs). Training, calibration and model selection now use
separate geographically separated fires. The selected predictor blends 50%
calibrated gradient-boosted trees and 50% train-fitted smoothed persistence.
It has 25 unchanged features, 120 trees, up to 15 leaves per tree, an intercept
calibration offset +0.312939 and a selection-chosen score threshold of 0.20.
The complete candidate protocol and selection record are in scripts/ml/v2.

RETAINED DATA AFTER INPUT ELIGIBILITY
Training: 43 events / 19,274 cells / 573 positive cells.
Calibration: 28 events / 10,599 cells / 334 positives across 17 events.
Selection: 31 events / 17,335 cells / 853 positives.
Fresh 2021 test: 27 events / 16,694 cells / 1,040 positives.
All events have equal total weight. No target-positive filtering or negative
subsampling. No replacement after eligibility exclusion. A 25 km metadata
center separation is a proxy for incident identity, not national independence.

SAME-TEST COMPARISON
                    Brier (lower)   PR-AUC (higher)
V2                  0.036577        0.468616
Frozen V1           0.050076        0.402290
Smoothed persistence 0.038562        0.338580
Logistic baseline   0.036517        0.455237
V2 Brier error is 26.96% lower than V1. Paired geographic-cluster bootstrap
95% interval for V2 minus V1 Brier: -0.019764 to -0.007452. The PR-AUC
difference interval (-0.015478 to 0.135675) crosses zero; its point increase
is not statistically resolved. V2 and logistic are not clearly separated.
At the independently selected 0.20 threshold, weighted precision is 51.65%
and recall 59.64%. For previously unoccupied cells, recall is only 11.84%.
This is a material limitation for anticipating new spread. Scores are not
percent accuracy or a validated probability of a flame front arriving.

The predefined release rule requires lower Brier and no lower PR-AUC than
frozen V1 on the same fresh test. It passed without test-guided refitting.
Selection/model hashes and timestamps precede test access in execution.json.
Every held-out score matches the JavaScript scorer to within 5e-12.

DATA AND TIMING
Source: WildfireSpreadTS v1.0, Sebastian Gerard, Yu Zhao and Josephine Sullivan
(KTH), https://doi.org/10.5281/zenodo.8006177 . License CC-BY-4.0,
https://creativecommons.org/licenses/by/4.0/ . Preserve source attribution.
Original 375 m masks are aggregated to 1.5 km. No raw TIFFs in this bundle.
For issue date I after the actual I00Z GFS run is retrieved (at least 06Z):
  Target I+1 UTC day; fire masks I-1 and I-2; gridMET I-2;
  antecedent GFS I00Z forecast hours F01-F24 (issue day, not target day).
Retrospective finalized data do not prove operational availability.

LIVE TRANSFER AND MISSING DATA
NASA S-NPP detections, native gridMET, exact GFS via Open-Meteo and USGS
terrain supply live inputs; NWS alerts remain separate. Required missing or
mismatched inputs cause abstention. NASA-reported input-day satellite gaps
and an unavailable outage catalogue also cause abstention. No reported outage
does not establish local clear-sky coverage. Terrain sampling, forecast
provider/downscaling, resolution and preliminary analyses remain unvalidated
transfer differences. The prior-fire fetch now derives its range from the
active model splits, with bounded streaming and no silent truncation.
S-NPP cessation is scheduled for 2026-11-02 at 13Z. The app also abstains when
the target day crosses cessation. NOAA-20/21 need a separately validated fit.

Fuel structure, live/dead fuel moisture, suppression, spotting, new ignition
and fire-atmosphere feedback are not fully observed. Absence of satellite
detection is not confirmed absence of burning. The app inventories 29 variable
groups with primary sources; it does not claim all are implemented features.

REPRODUCE
Follow scripts/ml/v2/README.txt with the pinned Python requirements. The
frozen plan downloads 1,000 verified files (~3.62 GB compressed), trains,
selects before test access, then exports model, scores and evaluation.
Node scoring audit: node --experimental-strip-types scripts/ml/check_model.mjs ARTIFACT_DIRECTORY
Tests: node --experimental-strip-types --test tests/*.test.ts
Python protocol tests: python scripts/ml/test_v2.py
Bundle: python scripts/ml/package_release.py
The bundle contains explicit source files, fixtures, frozen protocols and
hash manifest. Raw data and credentials are excluded. Legacy V1 documentation
is preserved at scripts/ml/v2/legacy-v1-readme.txt. Do not tune on this test;
a future changed model needs new independent evaluation.
