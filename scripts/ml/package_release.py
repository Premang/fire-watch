#!/usr/bin/env python3
"""Package the released fire model and its reproducible, credential-free sources.

Run from any directory. Only explicit source paths and authored ML scripts are
included; raw datasets, credentials, build outputs and caches are never swept in.
"""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

APP = Path(__file__).resolve().parents[2]
SOURCES = [
    'lib/fire-analysis.ts', 'lib/fire-outlook-types.ts', 'lib/fire-outlook.ts',
    'lib/fire-predictor-research.ts', 'lib/fire-predictor.ts', 'lib/geography.ts',
    'lib/prediction-inputs.ts', 'lib/prediction-terrain.ts',
    'lib/satellite-source-health.ts', 'lib/fire-prior-context.ts', 'public/data/us-states.json',
    'public/data/ml/model.json', 'public/data/ml/evaluation.json',
    'public/data/ml/replays.json', 'tests/fire-predictor.test.ts',
    'tests/fire-outlook.test.ts', 'tests/prediction-inputs.test.ts',
    'tests/prediction-terrain.test.ts', 'tests/satellite-source-health.test.ts', 'tests/fire-prior-context.test.ts',
    'tests/fixtures/fire-features.json', 'tests/fixtures/fire-model-parity.json',
    'app/api/prediction/route.ts',
]


def package(destination):
    paths = {APP / name for name in SOURCES}
    for path in (APP / 'scripts/ml').rglob('*'):
        if path.is_file() and path.suffix in {'.py', '.mjs', '.json', '.txt'} and '__pycache__' not in path.parts:
            paths.add(path)
    for path in paths:
        if not path.is_file() or path.is_symlink():
            raise ValueError(f'Missing or symlinked release source: {path}')
    entries = {str(path.relative_to(APP)): path.read_bytes() for path in sorted(paths)}
    report = json.loads(entries['public/data/ml/evaluation.json'])
    model_hash = hashlib.sha256(entries['public/data/ml/model.json']).hexdigest()
    if model_hash != report['modelSha256']:
        raise ValueError('Published model and evaluation hashes do not match')
    parity = json.loads(entries['tests/fixtures/fire-model-parity.json'])
    if parity['modelSha256'] != model_hash or len(parity['probabilities']) != report['test']['model']['cells']:
        raise ValueError('Released parity fixture does not cover the current model/test')
    manifest = {
        'modelId': report['modelId'], 'modelSha256': model_hash,
        'sourceDataset': report['source'],
        'files': {name: hashlib.sha256(data).hexdigest() for name, data in entries.items()},
        'notes': 'No raw TIFF data is included. Run the documented downloader to reproduce. '
                 'This bundle is a research implementation, not a standalone deployed service.',
    }
    entries['BUNDLE-MANIFEST.json'] = json.dumps(manifest, indent=2).encode()
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix('.zip.tmp')
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for name, data in sorted(entries.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            bundle.writestr(info, data, compresslevel=9)
    with zipfile.ZipFile(temporary) as bundle:
        if bundle.testzip() is not None:
            raise ValueError('Bundle integrity check failed')
        for name, data in entries.items():
            if bundle.read(name) != data:
                raise ValueError(f'Bundle content mismatch: {name}')
    temporary.replace(destination)
    return {'archive': str(destination), 'files': len(entries), 'bytes': destination.stat().st_size,
            'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(), 'modelId': report['modelId']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=APP / 'public/data/ml/reproducible-model.zip')
    args = parser.parse_args()
    print(json.dumps(package(args.output.resolve()), indent=2))
