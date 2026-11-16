#!/usr/bin/env python3
"""Freeze the non-public NOAA-20 trial protocol (ml-n20/shadow/protocol.json).

Must run before the first counted trial run; refuses to overwrite a frozen protocol or to freeze
after counted runs exist. --draft writes protocol.draft.json (used only by --dry-run runs).
Acceptance, stopping and rollback rules follow Astra reviews 5 and 7.
Usage: python freeze_shadow.py --start-date 2026-11-04 [--draft]
"""
import argparse, hashlib, json
from datetime import date, datetime, timezone
from pathlib import Path

APP = Path(__file__).resolve().parents[2]
TRIAL = APP.parent / 'ml-n20' / 'shadow'
NODE = '/opt/homebrew/Cellar/node/25.9.0_3/bin/node'
NODE_VERSION = 'v25.9.0'
FROZEN = [  # relative to ml-n20/shadow
    '../../ember-atlas/lib/fire-outlook.ts', '../../ember-atlas/lib/fire-outlook-types.ts', '../../ember-atlas/lib/fire-predictor.ts',
    '../../ember-atlas/lib/satellite-source-health.ts', '../../ember-atlas/lib/prediction-inputs.ts', '../../ember-atlas/lib/prediction-terrain.ts',
    '../../ember-atlas/lib/fire-prior-context.ts', '../../ember-atlas/lib/fire-analysis.ts', '../../ember-atlas/lib/geography.ts',
    '../../ember-atlas/public/data/ml/model.json', '../../ember-atlas/public/data/us-states.json',
    '../../ember-atlas/scripts/shadow/shadow-lib.ts', '../../ember-atlas/scripts/shadow/run-daily.mts', '../../ember-atlas/scripts/shadow/score_trial.py',
    '../geometry/CONTRACT.md', '../geometry/logistic-axes-sensitivity.json', '../artifacts/baseline-rates.json', '../artifacts/logistic.pkl',
    'com.emberatlas.noaa20-trial.plist',
]


# Files the labeling path depends on: labeling may continue during a halt only if these are intact.
LABEL_PATH = ['../../ember-atlas/scripts/shadow/shadow-lib.ts', '../../ember-atlas/scripts/shadow/run-daily.mts', '../../ember-atlas/lib/fire-predictor.ts',
              '../../ember-atlas/lib/fire-outlook.ts', '../../ember-atlas/lib/satellite-source-health.ts', '../../ember-atlas/lib/fire-outlook-types.ts',
              '../../ember-atlas/lib/geography.ts', '../../ember-atlas/public/data/us-states.json', '../../ember-atlas/public/data/ml/model.json',
              '../../ember-atlas/lib/fire-analysis.ts', '../../ember-atlas/lib/prediction-inputs.ts', '../../ember-atlas/lib/prediction-terrain.ts', '../../ember-atlas/lib/fire-prior-context.ts']
# Files the final evaluation depends on: verified against frozen hashes before any metric is computed.
EVALUATION = ['../../ember-atlas/scripts/shadow/score_trial.py', '../artifacts/baseline-rates.json', '../artifacts/logistic.pkl']


def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--start-date', required=True); ap.add_argument('--draft', action='store_true'); a = ap.parse_args()
    start = date.fromisoformat(a.start_date)
    TRIAL.mkdir(parents=True, exist_ok=True)
    out = TRIAL / ('protocol.draft.json' if a.draft else 'protocol.json')
    if not a.draft:
        if out.exists(): raise SystemExit('Trial protocol already frozen; refusing to change it')
        if (TRIAL / 'archive').exists() and any((TRIAL / 'archive').iterdir()): raise SystemExit('Counted runs exist; protocol must precede them')
    missing = [r for r in FROZEN if not (TRIAL / r).exists()]
    if missing: raise SystemExit(f'Missing frozen files: {missing}')
    model = json.loads((TRIAL / '../../ember-atlas/public/data/ml/model.json').read_text())
    protocol = {
        'id': 'ember-noaa20-shadow-1', 'createdAt': datetime.now(timezone.utc).isoformat(), 'draft': a.draft, 'seed': 20261104,
        'startDate': start.isoformat(), 'visibility': 'NON-PUBLIC. Runs locally; nothing is deployed or served to users.',
        'model': {'id': model['id'], 'sha256': sha(TRIAL / '../../ember-atlas/public/data/ml/model.json'),
                  'basis': 'Frozen S-NPP-trained v2; passed one-shot retrospective NOAA-20 holdout (ml-n20/artifacts/evaluation.json).'},
        'frozenFiles': {r: sha(TRIAL / r) for r in FROZEN},
        'labelPathFiles': LABEL_PATH,
        'evaluationFiles': EVALUATION,
        'runtime': {'node': NODE, 'nodeVersion': NODE_VERSION, 'note': 'Counted runs refuse any other Node version; the plist calls this exact binary.'},
        'schedule': {'attemptsLocal': ['08:00', '11:00', '14:00'], 'timezone': 'America/Los_Angeles', 'windowStartUtcHour': 6, 'windowEndUtcHour': 23,
                     'finalAttemptUtcHour': 21, 'maxAttempts': 3,
                     'rule': 'At most three attempts per UTC issue day (16/19/22 UTC in PST, 15/18/21 UTC in PDT), serialized by a lock. An attempt before 21 UTC whose first gridMET-retrieving window shows daily gridMET not yet covering the required lagged day is archived under attempts/ as uncounted (outputs, requests and any violations kept) and stops. The first attempt with gridMET ready, the third attempt, or any attempt at or after 21 UTC writes the one counted run.json for that day (atomic). The rule depends only on input availability, never on outcomes. A day without a counted, non-fatal run counts against completion; waking after 23 UTC loses that day.'},
        'cohort': {'source': 'NOAA-20 NRT 7-day CONUS feed, fetched at run time and archived', 'binDeg': 0.25, 'minDetections': 2, 'minSeparationKm': 30, 'maxWindows': 12,
                   'rule': "Yesterday's (I-1) nominal/high detections in CONUS (not AK/HI); densest 0.25-degree bins first; centre = mean detection; greedy 30 km separation; no outcome information. Each window is retried once on a thrown error."},
        'labels': {'source': 'NOAA-20 NRT 7-day feed snapshot fetched and archived by EVERY invocation (counted, deferred, already-counted or halted)',
                   'matureAfterDays': 2, 'expireAfterDays': 6,
                   'rule': 'Labeling starts when the target UTC day is >= 2 days old. If the feed lacks target-day rows the label is retried on later invocations; after 6 days it is recorded as expired. If the NOAA-20 outage catalogue reports an outage overlapping the target day the window-day is recorded as outage and excluded; if the catalogue is unavailable the label is retried. Otherwise a cell is positive if >= 1 nominal/high detection centre on the target day falls in it (point-centre, archived grid). Feed presence and no listed outage establish availability, not complete observation coverage.',
                   'primary': 'Raw NRT labels (no fire-type field available).',
                   'secondary': 'Sensitivity against standard-product type-0 labels once FIRMS publishes them; reported, not part of the gate.'},
        'baselines': {'smoothedPersistenceRates': '../artifacts/baseline-rates.json', 'logistic': '../artifacts/logistic.pkl',
                      'logisticTransferConvention': 'The NOAA-20 logistic was fit on zone-10-axis features and scores the archived true-north-aligned live features unchanged (a declared distribution shift, not leakage); its development sensitivity is recorded in geometry/logistic-axes-sensitivity.json.'},
        'estimand': 'Equal weight per eligible window-day (experimental output of one cohort window on one issue day). Not incident-balanced: persistent or multi-window incidents weigh more.',
        'stoppingRule': {'minDays': 60, 'minIncidentDays': 200, 'minClusters': 30, 'maxDays': 180, 'clusterKm': 50, 'clusterDays': 30,
                         'rule': 'Stop date D (label-free) = earliest issue day D >= start+59 at which valid eligible window-days with issueDate <= D number >= 200 AND their clusters number >= 30. Clusters are connected components of ALL eligible windows (centres < 50 km and issue dates <= 30 days apart), built before any label exclusion; they are dependence proxies, not proven independent incidents. Runs after D are not used. Final evaluation is allowed from D + 8 days (label drain). If no D by start+179 the result is inconclusive; nothing can pass after day 180. Progress counts only before then; no interim accuracy metrics.'},
        'validRun': 'A counted run is valid if its protocol SHA-256 matches, it is not a draft/dry run, its issue date is within [start, start+179], it has no fatal error and no invariant violations. Invalid runs are listed and excluded.',
        'acceptance': {'minCompletion': 0.95, 'observedOverPredicted': [0.8, 1.25],
                       'rule': 'Over labeled valid window-days up to D, equal weights; paired cluster bootstrap (1000) 95% intervals, model minus comparator: AP lower bound > 0 vs smoothed persistence; Brier upper bound < 0 vs smoothed persistence AND vs logistic; weighted observed/predicted positives within [0.8, 1.25]; completion (valid counted days / scheduled days) >= 95%. Issuance (days with >= 1 eligible window) reported separately. Bootstrap draws without positives are omitted for AP and kept for Brier; no labeled positives or undefined intervals -> inconclusive. Evaluation files are hash-verified first. final.json (statistical result and metrics) is written once and never changes; decision.json applies review flags (accepted becomes blocked-pending-review while any review flag is unresolved) and is recomputed whenever reviews change. Regional results (West < -104, Central -104 to -90, East > -90 centre longitude) are reported, not gated; a border subgroup is not computed (no border geometry). Accepted = eligible for promotion review, not automatic release.'},
        'rollback': {'halt': 'Any contract invariant violation (sensor, URL, platform, confidence vocabulary, dates, model id, provenance, grid/features, abstention invariants), a feed contract failure, or a frozen file changing: the halt is persisted first; no further counted runs; labeling of existing runs continues if every labelPathFiles entry is intact, otherwise nothing runs until the files are restored.',
                     'review': 'Any 3 consecutive counted days with eligible windows whose new-cell alert fraction (p >= 0.07 among previously unoccupied scored cells) exceeds 5%, reconstructed over the whole archive on every invocation: collection continues; the acceptance decision is blocked until STATUS.json records a review resolving that flag.',
                     'never': 'Never fall back to S-NPP. No tuning or code change during the trial; a change ends this trial and requires a new protocol.'},
        'operations': {'archiveBudget': 'About 2 MB per invocation (feed snapshot ~0.7 MB plus requests and outputs); up to 3 invocations/day -> roughly 1 GB over 180 days.',
                       'access': 'launchd runs node under the user account; macOS privacy controls may block access to ~/Documents until node is granted access. Verified once after install.',
                       'network': 'Feed fetched with 3 tries (20 s apart); each window retried once (15 s); failures are logged per request.'},
        'limitations': ['Lattice/scale reprojection, zone-straddling windows and the 0.02 PR-AUC blocking-phase sensitivity remain unvalidated (geometry/CONTRACT.md).',
                        'Raw NRT labels include static industrial heat sources; the model was evaluated on type-0 labels.',
                        'Cohort favours dense detection clusters; agricultural and prescribed burns are included as the live product would see them.',
                        'Eastern-US skill is unknown before this trial.',
                        'Runs depend on this Mac being on and awake inside the issue window.'],
    }
    out.write_text(json.dumps(protocol, indent=2))
    print(json.dumps({'written': str(out), 'sha256': sha(out), 'startDate': protocol['startDate'], 'frozenFiles': len(FROZEN)}, indent=2))


if __name__ == '__main__':
    main()
