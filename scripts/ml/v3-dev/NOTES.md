# V3 development experiment — 2026-11-03

Development-only. The inspected 2021 test split was **never prepared or opened**.
All numbers are on the v2 **selection** split (31 events, 853 positives, 387 new-cell
positives) and are optimistic model-choice evidence, not a release evaluation.
Released v2 (`ember-day-ahead-v2`) is **unchanged**.

## Setup
- Reproduced v2 byte-identically first (model.json SHA-256 `e0a867bf…c9dcb1`, ~72 s)
  with numpy 1.26.4 / scikit-learn 1.4.2. Note: pinned `imagecodecs==2023.1.23`
  does not build on Python 3.12; a current binary imagecodecs (TIFF decoding only)
  was used.
- Script: `../experiment_v3_dev.py --run <ml-v2> --out <dir>`.
- Reviewed with Astra (gpt-6-astra via Codex, read-only): `astra-review-1.md`
  (plan), `astra-review-2.md` (code review of the experiment).

## Candidates tried
- Directional features: downwind / crosswind displacement from nearest recent fire,
  upslope displacement, upwind recent-fire density, 7x7 front expansion.
- Platt calibration of the **final blend** (vs. offset on the tree component only).
- GBT leaves 7/15/31, a regularized GBT, logistic; tree weights 0.5/0.75/1.0.
- Thresholds chosen on calibration, not selection.

## Result (after fixing feature bugs found in Astra review 2)
| Candidate | Sel. Brier | Sel. PR-AUC | New-cell PR-AUC |
|---|---|---|---|
| **v2 recipe** (L15, w=0.5, offset) | **0.02858** | **0.3186** | 0.1048 |
| base L7, w=0.5 | 0.02869 | 0.2996 | 0.1089 |
| directional L7, w=0.5 | 0.02860 | 0.3059 | 0.1075 |
| logistic | 0.02988 | 0.2738 | 0.0974 |

Paired event-bootstrap 95% intervals for every challenger vs v2 span zero.
Directional features vs the same L7 trees: PR-AUC delta [-0.011, +0.020].
**No candidate beats v2. Do not release a v3 from this.**

An initial run showed an apparent gain (PR-AUC 0.329, new-cell 0.116); it came from
feature bugs — out-of-grid upwind samples counted as zero, duplicated nearest-neighbour
ray samples, arbitrary "upslope" on flat cells, and wind bearings not rotated from
geographic into the UTM 10N grid (convergence reaches ~10–15° in the interior West).
Kept as `results-initial-buggy-features.json` for the record.

Platt-on-final-blend leaves selection Brier essentially unchanged; it cannot correct
the 2021 mid-bin under-prediction, which is plausibly year-level shift but not
established (see `astra-review-2.md` §3).

## What would actually move the model (agreed with Astra)
1. **NOAA-20 rebuild** (S-NPP ceased 2026-11-02; live app now abstains everywhere).
   Rebuild prior/recent/target masks from NOAA-20 points per
   `../v2/noaa20-next-experiment.txt`; refit base-L15, base-L7, directional-L7 and
   persistence; recalibrate on NOAA-20 data. Freeze an untouched holdout first.
2. **More training support**: only 43 training events. Add independent incidents and
   extra issue days (chosen without looking at targets), equal weight per incident.
3. **New-cell objective**: predeclare new-cell recall at a fixed alert budget
   instead of global F1.
