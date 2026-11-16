**Do the NOAA-20 experiment first.** The immediate constraint is source continuity; deeper trees cannot restore the live app. V2 also has no demonstrated advantage over logistic regression, so retain logistic as a serious candidate. I reviewed the code and artifacts without modifying files.

The five highest-leverage improvements, ranked:

1. **Rebuild a matched NOAA-20 pipeline and baseline.** Follow [noaa20-next-experiment.txt:30](work/ember-atlas/scripts/ml/v2/noaa20-next-experiment.txt:30): rebuild prior, recent **and target** masks; match confidence filtering, UTC dates, grid alignment and live rasterization. Start with persistence, logistic and the existing GBT recipe to isolate sensor-transition effects. **Expected effect:** restores a path to operational predictions; accuracy improvement is unknown. **Risk:** WSTS retains S-NPP-based event selection, historical science products differ from NRT, and relabeling inspected fires does not create independence. NOAA-20’s archive begins April 2018, making it suitable for WSTS-era reconstruction. [NASA archive](https://firms.modaps.eosdis.nasa.gov/download/)

2. **Increase independent training support before model complexity.** The 250-event sample loses 121 events because the chosen window has no recent fire; only 43 training events remain. Sample more development incidents and additional issue days under a frozen, input-only eligibility rule. Retain target-zero outcomes. Keep every window from an incident complex together, and normalize weights across the entire incident so long fires do not dominate. **Expected effect:** better generalization and more spread examples. **Risk:** adjacent days provide correlated examples, not independent fires; random cell/day splits would substantially inflate results.

3. **Make new-cell performance an explicit objective.** Currently, overall Brier selects the model and overall F1 selects its threshold ([train_v2.py:148](work/ember-atlas/scripts/ml/train_v2.py:148)). The artifact implies, for unoccupied cells, `p = 0.5*p_tree + 0.007137`; reaching 0.20 requires `p_tree ≥ 0.3857`. First compare subgroup thresholds at a fixed false-alert budget. Then test regularized conditional models:
   `p(next detection) = R*p_persistence + (1−R)*p_new`, where `R` is recent occupancy. **Expected effect:** higher new-cell recall with an explicit precision tradeoff. **Risk:** fewer positives per head; begin with logistic interactions or shallow trees, and evaluate subgroup PR-AUC as well as recall. “New detection” can include reappearance after missed observations; it is not confirmed physical spread.

4. **Add directional interactions and forecast conditions for the target day.** Existing features contain displacement, lagged wind and terrain separately ([train.py:29](work/ember-atlas/scripts/ml/train.py:29)). Add downwind/crosswind displacement, upwind fire density, displacement projected onto terrain gradient, and recent-minus-prior front expansion. Add distance-decayed, prior-day FRP summaries. Rebuild valid forecast `u/v` and target-day conditions from the **issue-time run**: existing GFS features describe the issue day, and WSTS direction band 19 loses quadrants. **Expected effect:** improved spread ranking. **Risk:** future-run weather, same-day unavailable FRP, and observation gaps masquerading as front movement. Validate wind “from/to” conventions and live feature parity.

5. **Calibrate the final deployed score.** Currently the offset is fitted to tree probabilities and persistence is blended afterward ([train_v2.py:141](work/ember-atlas/scripts/ml/train_v2.py:141)). Calibration of a component does not ensure calibration of its mixture. **Expected effect:** better probability reliability and potentially Brier/log loss; a strictly monotonic final mapping preserves ranking. **Risk:** fitting the observed 2021 reliability curve would directly contaminate evaluation.

For calibration, my default would be **regularized Platt scaling on the final blend’s logit**, `sigmoid(a*logit(p)+b)`, with positive slope and shrinkage toward `(a,b)=(1,0)`:

- **Offset-only:** retain as the low-variance comparator; it cannot correct slope or shape errors.
- **Platt:** two parameters are a reasonable first increase in flexibility.
- **Beta:** test one constrained alternative, `sigmoid(a*log(p)−b*log(1−p)+c)`, with nonnegative `a,b` and identity shrinkage. It permits asymmetric corrections. [Original paper](https://proceedings.mlr.press/v54/kull17a.html)
- **Isotonic:** defer. There are 334 positives across only 17 positive-containing events; 10,599 correlated cells overstate support for a flexible staircase. [Calibration documentation](https://scikit-learn.org/stable/modules/calibration.html)

For each predefined blend, fit calibration on calibration events, then select on separate selection events. Use event weights, grouped validation, and cluster-bootstrap reliability intervals. Check occupied/unoccupied subgroups and year/region drift; calibration cannot guarantee correction of a changing deployment distribution.

For a **clean v3 evaluation**, freeze the protocol before opening new outcomes:

- **Strongest:** reserve a previously untouched later year, reconstruct NOAA-20 and covariates with issue-time availability, and begin prospective prediction logging.
- **Practical WSTS option:** reserve unused 2021 incidents using metadata only. Exclude all v1/v2 inspected or reserved incidents and related complexes—not merely the 27 eligible test fires. Audit footprints and dates beyond the existing 25 km center proxy. This supports a new incident-holdout claim, not temporal extrapolation.
- **Leave-one-year-out:** useful for development robustness, with nested calibration/selection and incident grouping. It cannot undo earlier adaptive exposure or become a fresh independent v3 test.
- **NOAA-20 relabeling:** use inspected incidents for development; reserve genuinely untouched incidents for testing.

Require same-target, same-cell comparisons against NOAA-20 logistic and persistence, paired incident-cluster uncertainty, new-cell metrics, and abstention coverage before release.