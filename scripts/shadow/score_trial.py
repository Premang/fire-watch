#!/usr/bin/env python3
"""Score the non-public NOAA-20 trial under ml-n20/shadow/protocol.json.

Default: PROGRESS ONLY (counts; no accuracy metrics), so nobody can peek and stop early.
--final: one-shot evaluation, refused until the stop date is reached and its labels have drained, and only
         if the evaluation files match their frozen hashes. Writes immutable final.json, then decision.json.
--decision: re-apply review flags to final.json (rerun after recording a review in STATUS.json).

Stop date D (label-free): the earliest issue day D >= start + minDays - 1 such that eligible window-days
with issueDate <= D reach minIncidentDays AND their dependence clusters (built over ALL eligible windows,
before any label exclusion) reach minClusters. If no such D by start + maxDays - 1, the trial ends there
and the result is 'inconclusive'. Runs after D are never used.
Estimand: equal weight per eligible window-day (not incident-balanced; persistent incidents weigh more).
Requires the pinned ML environment (numpy 1.26.4, scikit-learn 1.4.2) for the logistic baseline.
Usage: python score_trial.py [--final]
"""
import argparse, hashlib, json, math, os, pickle
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
TRIAL = Path(os.environ['EMBER_TRIAL_DIR']).resolve() if os.environ.get('EMBER_TRIAL_DIR') else HERE.parents[2] / 'ml-n20' / 'shadow'  # override for tests only
REGIONS = (('West', -180, -104), ('Central', -104, -90), ('East', -90, 0))


def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()


def load():
    path = TRIAL / 'protocol.json'
    if not path.exists():
        path = TRIAL / 'protocol.draft.json'; print('WARNING: no frozen protocol; reading the draft (progress only)')
    protocol = json.loads(path.read_text()); psha = sha(path)
    start = date.fromisoformat(protocol['startDate']); last = start + timedelta(days=protocol['stoppingRule']['maxDays'] - 1)
    days, invalid = [], []
    for d in sorted((TRIAL / 'archive').glob('*/run.json')) if (TRIAL / 'archive').exists() else []:
        run = json.loads(d.read_text()); issue = date.fromisoformat(run['issueDate'])
        why = ('outside trial dates' if not (start <= issue <= last) else 'protocol hash mismatch' if run.get('protocolSha256') != psha
               else 'draft/dry run' if run.get('protocolDraft') or run.get('dryRun') else 'fatal: ' + run['fatal'] if run.get('fatal')
               else 'invariant violations' if run.get('violations') else None)
        if why: invalid.append({'issueDate': run['issueDate'], 'reason': why}); continue
        lab = d.parent / 'labels.json'
        days.append({'run': run, 'labels': json.loads(lab.read_text()) if lab.exists() else None})
    status = json.loads((TRIAL / 'STATUS.json').read_text()) if (TRIAL / 'STATUS.json').exists() else {'state': 'not started', 'pauses': [], 'reviews': []}
    return protocol, start, last, days, invalid, status


def eligible_windows(days):
    out = []
    for d in days:
        labs = {(w['centre']['lat'], w['centre']['lon']): w for w in (d['labels'] or {}).get('windows', [])}
        for w in d['run']['windows']:
            o = w.get('outlook')
            if not o or o['status'] != 'experimental': continue
            lab = labs.get((w['centre']['lat'], w['centre']['lon']))
            out.append({'issueDate': d['run']['issueDate'], 'centre': w['centre'], 'outlook': o, 'labelStatus': (d['labels'] or {}).get('status'),
                        'labels': lab['labels'] if lab and lab.get('status') == 'labeled' else None})
    return out


def clusters(ws, km, days_apart):
    """Connected components over ALL given windows (a dependence proxy, not proven incident identity)."""
    def near(a, b):
        la, lo, lb, lob = a['centre']['lat'], a['centre']['lon'], b['centre']['lat'], b['centre']['lon']
        return (math.hypot((la - lb) * 111.2, (lo - lob) * 111.2 * math.cos(math.radians((la + lb) / 2))) < km
                and abs((date.fromisoformat(a['issueDate']) - date.fromisoformat(b['issueDate'])).days) <= days_apart)
    left = list(range(len(ws))); groups = []
    while left:
        g = [left.pop(0)]; i = 0
        while i < len(g):
            nb = [j for j in left if near(ws[g[i]], ws[j])]
            for j in nb: left.remove(j); g.append(j)
            i += 1
        groups.append(g)
    return groups


def stop_date(protocol, start, last, ws):
    rule = protocol['stoppingRule']; d = start + timedelta(days=rule['minDays'] - 1)
    while d <= last:
        sub = [w for w in ws if date.fromisoformat(w['issueDate']) <= d]
        if len(sub) >= rule['minIncidentDays'] and len(clusters(sub, rule['clusterKm'], rule['clusterDays'])) >= rule['minClusters']: return d, True
        d += timedelta(days=1)
    return last, False


def progress(protocol, start, last, days, invalid, status):
    rule = protocol['stoppingRule']; today = datetime.now(timezone.utc).date()
    ws = eligible_windows(days); D, met = stop_date(protocol, start, last, ws)
    horizon = min(today, D) if met else min(today, last)
    scheduled = max(0, (horizon - start).days + 1) if today >= start else 0
    counted = {d['run']['issueDate'] for d in days if date.fromisoformat(d['run']['issueDate']) <= horizon}
    issued = {w['issueDate'] for w in ws if date.fromisoformat(w['issueDate']) <= horizon}
    within = [w for w in ws if date.fromisoformat(w['issueDate']) <= horizon]
    drain = protocol['labels']['expireAfterDays'] + 1
    return {'state': status.get('state'), 'unresolvedReviews': unresolved(status), 'startDate': start.isoformat(), 'today': today.isoformat(),
            'scheduledDays': scheduled, 'completedDays': len(counted), 'completion': len(counted) / scheduled if scheduled else None,
            'issuedDays': len(issued), 'issuance': len(issued) / scheduled if scheduled else None, 'invalidRuns': invalid,
            'eligibleWindowDays': len(within), 'clusters': len(clusters(within, rule['clusterKm'], rule['clusterDays'])),
            'labeledWindowDays': sum(w['labels'] is not None for w in within),
            'stopDate': D.isoformat() if met else None, 'stopRuleMet': met, 'trialLastDay': last.isoformat(),
            'finalAllowedFrom': (D + timedelta(days=drain + 1)).isoformat()}


def unresolved(status):
    resolved = {r['resolves'] for r in status.get('reviews', [])}
    return [p['reason'] for p in status.get('pauses', []) if p['kind'] == 'review' and p['reason'] not in resolved]


def final(protocol, start, last, days, invalid, status):
    import numpy as np
    from sklearn.metrics import average_precision_score, brier_score_loss
    if protocol.get('draft'): raise SystemExit('Final evaluation requires the frozen protocol')
    if (TRIAL / 'final.json').exists(): raise SystemExit('Final evaluation already written; one-shot only (use --decision to re-apply reviews)')
    bad = [r for r in protocol['evaluationFiles'] if not (TRIAL / r).exists() or sha(TRIAL / r) != protocol['frozenFiles'][r]]
    if bad: raise SystemExit(f'Evaluation inputs differ from their frozen hashes: {bad}')
    p = progress(protocol, start, last, days, invalid, status); today = datetime.now(timezone.utc).date()
    ws_all = eligible_windows(days); D, met = stop_date(protocol, start, last, ws_all)
    if not met and today <= last: raise SystemExit('Stopping rule not met and the trial has not ended; final evaluation refused')
    if today < date.fromisoformat(p['finalAllowedFrom']): raise SystemExit(f"Labels still draining; final allowed from {p['finalAllowedFrom']}")
    def write(res):
        (TRIAL / 'final.json').write_text(json.dumps(res, indent=2)); print(json.dumps(res, indent=2)); decide(status)
    if not met: return write({'result': 'inconclusive', 'reason': 'trial ended without meeting the stopping rule', 'progress': p})
    if p['completion'] is None or p['completion'] < protocol['acceptance']['minCompletion']: return write({'result': 'inconclusive', 'reason': 'completion below minimum', 'progress': p})
    ws = [w for w in ws_all if date.fromisoformat(w['issueDate']) <= D]
    groups = clusters(ws, protocol['stoppingRule']['clusterKm'], protocol['stoppingRule']['clusterDays'])  # before label exclusions
    rates = np.asarray(json.loads((TRIAL / protocol['baselines']['smoothedPersistenceRates']).read_text()))
    with open(TRIAL / protocol['baselines']['logistic'], 'rb') as f: logistic = pickle.load(f)
    rows = {}
    for i, w in enumerate(ws):
        if w['labels'] is None: continue
        ids = [c['id'] for c in w['outlook']['cells']]
        x = np.array([w['outlook']['cellFeatures'][k]['features'] for k in ids], dtype=float); prev = np.array([c['previous'] for c in w['outlook']['cells']], dtype=int)
        rows[i] = {'y': np.array([w['labels'][k] for k in ids]), 'model': np.array([c['p'] for c in w['outlook']['cells']]),
                   'smoothedPersistence': rates[prev], 'logistic': logistic.predict_proba(x[:, :25])[:, 1], 'lon': w['centre']['lon']}
    if not rows or not any(r['y'].any() for r in rows.values()): return write({'result': 'inconclusive', 'reason': 'no labeled positives', 'progress': p})
    names = ('model', 'smoothedPersistence', 'logistic')
    def pooled(idx, key):
        idx = [i for i in idx if i in rows]
        y = np.concatenate([rows[i]['y'] for i in idx]); q = np.concatenate([rows[i][key] for i in idx])
        w = np.concatenate([np.full(len(rows[i]['y']), 1 / len(rows[i]['y'])) for i in idx]); w *= len(w) / w.sum()
        return y, q, w
    def metrics(idx):
        out = {}
        for k in names:
            y, q, w = pooled(idx, k)
            out[k] = {'brier': float(brier_score_loss(y, q, sample_weight=w)), 'prAuc': float(average_precision_score(y, q, sample_weight=w)) if y.any() else None,
                      'observedOverPredicted': float(np.sum(w * y) / max(1e-12, np.sum(w * q))), 'windowDays': len([i for i in idx if i in rows])}
        return out
    allidx = list(rows); m = metrics(allidx)
    rng = np.random.default_rng(protocol['seed']); deltas = {k: {'brier': [], 'prAuc': []} for k in names[1:]}; undefined = 0
    for _ in range(1000):
        idx = [i for j in rng.integers(0, len(groups), len(groups)) for i in groups[j] if i in rows]
        if not idx: continue
        y, pm, w = pooled(idx, 'model')
        for k in names[1:]:
            _, pk, _ = pooled(idx, k); deltas[k]['brier'].append(brier_score_loss(y, pm, sample_weight=w) - brier_score_loss(y, pk, sample_weight=w))
            if y.any(): deltas[k]['prAuc'].append(average_precision_score(y, pm, sample_weight=w) - average_precision_score(y, pk, sample_weight=w))
        if not y.any(): undefined += 1
    q95 = lambda v: [float(np.percentile(v, 2.5)), float(np.percentile(v, 97.5))] if v else None
    ci = {k: {'brierDelta95': q95(v['brier']), 'prAucDelta95': q95(v['prAuc'])} for k, v in deltas.items()}
    if any(c['prAucDelta95'] is None or c['brierDelta95'] is None for c in ci.values()): return write({'result': 'inconclusive', 'reason': 'undefined bootstrap intervals', 'progress': p})
    acc = protocol['acceptance']; ratio = m['model']['observedOverPredicted']
    checks = {'apLowerBoundAboveZeroVsSmoothedPersistence': ci['smoothedPersistence']['prAucDelta95'][0] > 0,
              'brierUpperBoundBelowZeroVsSmoothedPersistence': ci['smoothedPersistence']['brierDelta95'][1] < 0,
              'brierUpperBoundBelowZeroVsLogistic': ci['logistic']['brierDelta95'][1] < 0,
              'calibrationRatioWithinBounds': acc['observedOverPredicted'][0] <= ratio <= acc['observedOverPredicted'][1]}
    regional = {name: metrics([i for i in allidx if lo <= rows[i]['lon'] < hi]) for name, lo, hi in REGIONS if any(lo <= rows[i]['lon'] < hi for i in allidx)}
    result = 'accepted' if all(checks.values()) else 'failed'
    write({'result': result, 'checks': checks, 'metrics': m, 'pairedDeltas95': ci, 'undefinedApDraws': undefined, 'clusters': len(groups),
           'regionalReport': regional, 'progress': p, 'stopDate': D.isoformat(),
           'note': 'Statistical result only (immutable). The acceptance decision, which also applies review flags, is in decision.json.'})


def decide(status):
    """Re-apply review flags to the immutable statistical result; safe to rerun whenever reviews change."""
    if not (TRIAL / 'final.json').exists(): raise SystemExit('No final evaluation yet')
    res = json.loads((TRIAL / 'final.json').read_text()); open_ = unresolved(status)
    decision = 'blocked-pending-review' if res['result'] == 'accepted' and open_ else res['result']
    out = {'decision': decision, 'statisticalResult': res['result'], 'unresolvedReviews': open_, 'decidedAt': datetime.now(timezone.utc).isoformat(),
           'finalSha256': sha(TRIAL / 'final.json'), 'note': 'accepted = eligible for promotion review, not public release.'}
    (TRIAL / 'decision.json').write_text(json.dumps(out, indent=2)); print(json.dumps(out, indent=2))


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--final', action='store_true'); ap.add_argument('--decision', action='store_true'); a = ap.parse_args()
    args = load()
    if a.final: final(*args)
    elif a.decision: decide(args[-1])
    else: print(json.dumps(progress(*args), indent=2))
