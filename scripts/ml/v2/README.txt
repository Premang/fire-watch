V2 frozen experiment
====================
These files preserve the metadata-only selection plan, candidate protocol and
previous fitted model. The plan was frozen before inspecting this experiment's
target labels. It selects 250 events / 1,000 daily TIFFs (~3.62 GB compressed).

From the app root, prepare a fresh run directory without replacing a prior run:
  mkdir -p ../ml-v2-reproduction/frozen-v1
  cp scripts/ml/v2/plan.json scripts/ml/v2/protocol.json ../ml-v2-reproduction/
  cp scripts/ml/v2/frozen-v1-model.json ../ml-v2-reproduction/frozen-v1/model.json
  cp scripts/ml/v2/frozen-v1-evaluation.json ../ml-v2-reproduction/frozen-v1/evaluation.json
  cp scripts/ml/v2/source-gap-audit.json scripts/ml/v2/source-availability-secondary-plan.json ../ml-v2-reproduction/

Install scripts/ml/requirements.txt in a Python environment. Retrieve the exact
frozen public ZIP members with CRC32 and SHA256 verification:
  python scripts/ml/download-wfts-subset.py --plan ../ml-v2-reproduction/plan.json --output-dir ../ml-v2-reproduction/data --workers 4
  python scripts/ml/train_v2.py --run ../ml-v2-reproduction
  node --experimental-strip-types scripts/ml/check_model.mjs ../ml-v2-reproduction/artifacts

No published app files are changed by these commands. The downloader resumes
verified files. The trainer refuses incomplete extraction or altered plans.
It writes model.json and selection.json before opening test labels, then writes
evaluation/replay/parity files. Re-running is a reproducibility check, not a new
independent test. Do not adjust candidates based on these test outcomes.

Scores combine calibrated tree output and train-fitted two-rate persistence;
mixture follows calibration. Identity calibration is an explicit candidate.
Selection chooses the candidate; the separate calibration split fits only a
bounded regularized offset. Exact candidate choices and the release gate are
in protocol.json. Geographically clustered paired bootstrap comparisons and
the frozen-v1 scores use identical test cells and event weights.

Historical detection skill does not establish live probability calibration,
flame arrival, ignition risk, an official warning or a safe deployment decision.
The source remains S-NPP-specific, with explicit live source-health abstention.
