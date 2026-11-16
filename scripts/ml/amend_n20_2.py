#!/usr/bin/env python3
"""Pre-holdout amendment 2 (2026-11-03): candidate hierarchy.

Written after the amendment-1 selection showed the NOAA-20 refit (selection Brier
0.02929) did not beat the frozen S-NPP v2 model scored on NOAA-20 inputs
(0.02858). Selection-informed, so the choice is reported as such; the holdout is
still unopened. Requires that no holdout data exists yet.

  primary   = snppV2CrossSensor: frozen released v2 (model SHA in selection.json),
              scored unchanged on NOAA-20-derived inputs. Gate: holdout Brier
              strictly below NOAA-20 smoothed persistence and NOAA-20 logistic,
              PR-AUC >= NOAA-20 smoothed persistence.
  secondary = NOAA-20 refit ('model'), amendment-1 gate unchanged.
The first candidate in order that passes is the deployment candidate; passing is a
retrospective screen only (live NRT feed parity still required). Calibration is
reported descriptively; nothing is refit on the holdout.
Usage: python amend_n20_2.py --n20 ../../../ml-n20
"""
import argparse, json
from datetime import datetime, timezone
from pathlib import Path
from train_v2 import sha


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--n20', type=Path, required=True); a = ap.parse_args(); n20 = a.n20.resolve()
    if (n20 / 'amendment-2.json').exists(): raise SystemExit('Amendment 2 already frozen')
    if (n20 / 'holdout-data').exists(): raise SystemExit('Holdout data present; amendment must precede holdout access')
    a1 = json.loads((n20 / 'amendment-1.json').read_text()); sel = json.loads((n20 / 'artifacts/selection.json').read_text())
    here = Path(__file__).resolve().parent
    amendment = {
        'id': 'ember-day-ahead-n20-amendment-2', 'createdAt': datetime.now(timezone.utc).isoformat(), 'holdoutAccessed': False,
        'amendment1Sha256': sha(n20 / 'amendment-1.json'), 'selectionSha256': sha(n20 / 'artifacts/selection.json'),
        'reason': 'Selection-split evidence: S-NPP v2 cross-sensor Brier 0.02858 / PR-AUC 0.3103 vs NOAA-20 refit 0.02929 / 0.2868. Primary candidate chosen from selection, not holdout.',
        'candidates': [
            {'scorer': 'snppV2CrossSensor', 'role': 'primary', 'modelSha256': sel['snppV2ModelSha256'],
             'gate': {'brierStrictlyBelow': ['smoothedPersistence', 'logistic'], 'prAucAtLeast': ['smoothedPersistence']}},
            {'scorer': 'model', 'role': 'secondary', 'modelSha256': sel['modelSha256'],
             'gate': {k: a1['releaseGate'][k] for k in ('brierStrictlyBelow', 'prAucAtLeast')}},
        ],
        'codeSha256': {n: sha(here / n) for n in ('train_n20.py', 'experiment_v3_dev.py', 'train.py', 'train_v2.py')},
        'note': 'Supersedes amendment-1 codeSha256. All other amendment-1 rules (footprint separation, clusters, insufficient data, new-cell budget) unchanged.',
    }
    (n20 / 'amendment-2.json').write_text(json.dumps(amendment, indent=2))
    print(json.dumps({'amendment2Sha256': sha(n20 / 'amendment-2.json'), 'candidates': [c['scorer'] for c in amendment['candidates']]}, indent=2))


if __name__ == '__main__':
    main()
