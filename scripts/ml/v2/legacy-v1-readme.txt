EMBER ATLAS: REPRODUCIBLE FIRE-ACTIVITY PILOT
Release: 2026-10-23. Model: ember-day-ahead-v1.

This is a trained research model, not an official fire warning or a validated
operational spread model. It ranks the chance of a retained S-NPP satellite
active-fire detection in a 1.5 km cell near earlier detections. It does not
estimate flame-front arrival, containment, safe evacuation, or crew deployment.

The released model has 25 features and 120 histogram-gradient-boosted trees,
with validation-fitted Platt calibration. Feature families are two earlier
fire masks and neighborhood geometry, terrain, lagged weather, ERC/PDSI, and
antecedent issued GFS temperature, specific humidity and vector-mean wind.
See model.json for exact feature order and the fitted numerical parameters.

DATA AND TIMING
WildfireSpreadTS v1.0: https://doi.org/10.5281/zenodo.8006177
Dataset creators: Sebastian Gerard, Yu Zhao and Josephine Sullivan (KTH).
The source dataset is CC-BY-4.0: https://creativecommons.org/licenses/by/4.0/. See its creator metadata and documentation at
the DOI; preserve attribution when distributing derived products. This work
aggregates its 375 m masks into 1.5 km cells, derives different features and
uses a deliberately later target than the original next-day benchmark.
No TIFF pixels are included in this bundle. The fixed downloader retrieves
240 verified TIFFs (about 874 MB compressed) from 60 events through ZIP ranges.
It checks range responses, CRC32, sizes and SHA256; resume reuses verified files.

For issue date I, after the actual I00Z GFS run is available (at least 06Z):
  Target: I+1 00:00–24:00 UTC.
  Recent and prior fire masks: I−1 and I−2 UTC dates.
  Lagged gridMET weather: I−2, nominal day ending 07Z on I−1.
  GFS antecedent conditions: I00Z run, forecast hours F01–F24 inclusive.
All input dates precede the target. These are daily windows, not a rolling
24-hour prediction at any arbitrary page-open time. Retrospective finalized
analyses still do not prove that those exact values were available operationally.

Fires are selected randomly by event/year and four-day window before looking
at labels. Windows without recent detections are outside this conditional
model's domain. No target-positive filtering or negative-class downsampling
is used. Cells are inside CONUS, within 12 km of recent detections, and away
from truncated feature neighborhoods. Every event has equal total weight.
Training: 2018–2019; validation: 2020; untouched-year test: 2021.
A 25 km event-center embargo removes nearby training events. It is not a
complete national geographic holdout. See evaluation.json for exact event IDs.

RESULT AND LIMITS
After eligibility filtering and embargo: 17 training, 5 validation and 6 test
events. Validation has only 5 positive cells, making calibration and threshold
selection especially unstable. Test has 1,705 eligible cells, 65 positive.
PR-AUC: 0.3674 model vs 0.2256 persistence (higher is better).
Brier: 0.03376 model vs 0.03065 smoothed persistence (lower is better).
Ranking improves, probability error does not. At the validation-selected 0.05
threshold, event-weighted precision is 49.4% and recall 30.7%. These are not
national operational performance estimates. Bootstrap intervals resample whole
test fires; the PR-AUC 95% interval is approximately 0.151–0.625.
The final implementation corrected floating-point neighborhood-count artifacts
found during Python/JavaScript parity review. Candidate settings and splits
were unchanged; evaluation was recomputed after that bug correction. Test
results were not used to optimize hyperparameters.

No detection is the label, not proof that a cell is fire-free. The dataset lacks
a cloud/clear-observation mask. Important unmodeled processes include detailed
fuel structure, live and dead moisture classes, spotting, new human/lightning
ignitions, suppression actions and fire-atmosphere feedback. The application
research inventory addresses 29 variable groups and cites primary sources.
The original dataset's forecast rain band 17 has inconsistent accumulation
reductions and forecast direction band 19 loses quadrants; both are excluded.
Annual land cover and optical composites are excluded for availability/hindsight.

LIVE TRANSFER
Live inputs come from NASA S-NPP, native gridMET, an exact issued GFS run via
Open-Meteo, USGS 3DEP terrain and official NWS alerts. Model scores are not
established live probabilities. Differences in terrain product/vertical datum,
cell sampling, GFS processing/derived humidity, georeferencing and preliminary
analyses remain. Official alerts are displayed separately. Required missing,
stale, mismatched or unsupported inputs cause abstention; missing is not zero.
S-NPP delivery is scheduled to stop Nov 2, 2026 at 13Z. Inference stops at that
cutoff and never silently switches sensors. NOAA-20/21 require retraining.

REPRODUCE (Python 3.11 environment for pinned package wheels)
  python3 -m venv work/ml-env
  work/ml-env/bin/pip install -r scripts/ml/requirements.txt
  work/ml-env/bin/python scripts/ml/download-wfts-subset.py --output-dir work/wfts-data
  work/ml-env/bin/python scripts/ml/train.py --data work/wfts-data --out work/ml-model
  work/ml-env/bin/python scripts/ml/check_features.py --data work/wfts-data --model-dir work/ml-model

The trainer resolves public/data/us-states.json relative to its repository root.
It refuses an incomplete download unless --allow-incomplete is explicitly used
for local debugging. Never publish incomplete-debug fits as the released model.
Evaluation contains source hashes, event splits, metrics, reliability bins,
permutation sensitivity, and bootstrap intervals. The output .npz preserves
held-out feature vectors and predictions for auditing.

INFERENCE / VERIFICATION
lib/fire-predictor.ts is a dependency-free TypeScript inference implementation.
Run tests with a recent Node 22 release supporting --experimental-strip-types:
  node --experimental-strip-types --test tests/fire-predictor.test.ts
All 1,705 exported test predictions are checked against Python, with strict
feature-to-score checks including density counts, direction, missing values,
nearest-fire tie breaks and UTM projection. The live service has separate
network-mocked validation of missing data, source dates and abstention rules.

NEXT VALIDATION PRIORITIES
Expand event/year/geographic coverage with substantially more positive
calibration cases; reserve new unseen test fires before further model tuning.
Build prospective issue-time snapshots. Retrain for continuing NOAA VIIRS
sensors. Add independently audited forecast direction/rain and publication-safe
fuel data, then test each addition against persistence and current baselines.
Operational use additionally requires incident-agency validation and real fuel,
suppression and observation-coverage data.
