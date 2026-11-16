Reviewed read-only; synthetic feature checks ran entirely in memory. No files changed or 2021 labels opened.

1. **The signs are correct under the stated conventions.** In [extended_features](work/ember-atlas/scripts/ml/experiment_v3_dev.py:41), displacement is cell-minus-fire; negating its wind-FROM projection correctly gives downwind distance. Crosswind magnitude and the negative downslope-aspect projection also pass cardinal-direction/ramp checks. Upwind sampling correctly moves toward the wind source.

   Fix these details:

   - **Boundary:** the ray reaches four cells, but `prepare()` excludes only three border cells. Out-of-bounds samples silently count as zero: an all-fire northward ray at row 3 returns **0.75**, versus 1.0 at row 4. Use a shared four-cell exclusion for every comparator.
   - **Rounding:** at 45°, offsets are `(-1,1), (-1,1), (-2,2), (-3,3)`. One burning cell contributes 0.5. This is nearest-neighbor ray sampling, not four-distinct-cell density; use bilinear sampling or explicitly deduplicate.
   - **Flat terrain:** aspect is arbitrary when slope is zero, producing nonzero “upslope.” Zero the feature there. Elsewhere it measures local slope alignment, not necessarily actual elevation gain from the fire.
   - **Coordinate frame:** displacement/aspect use UTM grid axes, while geographic wind bearings require rotation into that frame before projection/sampling. Account for [grid convergence](https://docs.wasp.dk/windkit/latest/auto_examples/grid_convergence.html).

   The comparison is fair **development evidence**, with shared cells/weights and calibration-only thresholds. Compare ext-L7 against base-L7 to isolate feature effects. Bootstrap incident/geographic clusters rather than individual events; selection includes nearby event groups. Fixed-prediction bootstrap intervals do not account for [winner-selection optimism](https://scikit-learn.org/stable/auto_examples/model_selection/plot_nested_cross_validation_iris.html). Also, unchanged new-cell AP after monotone Platt calibration is expected.

2. **Choose (c): fix these issues, retain ext-L7 as a provisional challenger, and start the NOAA-20 rebuild with a small frozen comparison set.** Include base-L15, base-L7, ext-L7, and persistence; refit each using NOAA-20 inputs/targets and calibration. Do not carry S-NPP calibration across.

   Expand development data during that rebuild: prioritize independent incidents and season/region coverage, then additional issue days. Select days without inspecting target outcomes; keep entire incident complexes in one split and give each incident equal total weight across its days. Freeze an untouched holdout before inspecting its outcomes. For new-cell usefulness, predeclare recall at a fixed alert budget or precision requirement; global F1 thresholds can favor occupied-cell persistence.

3. **Year-level shift is plausible, not established.** Near-zero aggregate Brier change does not establish unchanged mid-bin reliability, and 2020-fitted Platt cannot identify a 2021-specific correction. Sparse bins, incident composition, observation missingness, blend shrinkage, and calibration misspecification are competing explanations.

   Use pre-2021 rolling-year, incident-separated development predictions to examine calibration intercept/slope, reliability with cluster uncertainty, and occupied/new-cell strata. Recalibrate on representative NOAA-20 development data. Keep the inspected 2021 result descriptive; demonstrate any correction on the new untouched holdout.