#!/usr/bin/env python3
"""Fit and validate MODIS/VIIRS harmonization factors (design: Astra review 13).

Reference unit: Suomi NPP VIIRS-equivalent 5 km cell-days (the longest VIIRS record).
Bridges (separate, documented pairs; platforms are never pooled):
  aqua_to_snpp    q = S-NPP per Aqua cell-day     train 2012-2017, tune 2018-2019, test 2020-2021, drift stress 2022-2025
  noaa20_to_snpp  q = S-NPP per NOAA-20            train 2018-2021, tune 2022, test 2023-2025
  terra_to_aqua   q = Aqua per Terra               train 2003-2009, tune 2010-2011, test 2012-2013 (pre-drift)
Estimator per 320 km block (64x64 cells) x calendar month, pooled over training years incl. zero months:
  q_block = (sum REF + lam * q_parent) / (sum SRC + lam); parents: 1,280 km super-block -> 15-deg latitude band
  -> global calendar month -> all months. lam chosen on tuning years by normalized absolute error (NAE).
Spatial transfer: 5-fold leave-region-out cross-validation over 1,280 km regions (held-out regions excluded from every level).
Only MATCHED days (both platforms delivering data globally: occupied cells >= 50% of centred 31-day median) enter
fitting and evaluation. Test metrics at 40 km, 320 km and 1,280 km aggregation scales feed the app's uncertainty band.
Usage: python harmonize.py GLOBAL_FIRMS_DIR OUT_DIR
"""
import json, math, os, sys
from pathlib import Path
import numpy as np
import pandas as pd

root, out = Path(sys.argv[1]), Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
plat = root / 'plat'
PAIRS = {
    'aqua_to_snpp': {'src': 'aqua', 'ref': 'snpp', 'train': range(2012, 2018), 'tune': range(2018, 2020), 'test': range(2020, 2022), 'stress': range(2022, 2026),
                     'backcast': (range(2014, 2020), range(2012, 2014))},
    'noaa20_to_snpp': {'src': 'noaa20', 'ref': 'snpp', 'train': range(2018, 2022), 'tune': range(2022, 2023), 'test': range(2023, 2026), 'stress': range(0)},
    'terra_to_aqua': {'src': 'terra', 'ref': 'aqua', 'train': range(2003, 2010), 'tune': range(2010, 2012), 'test': range(2012, 2014), 'stress': range(0),
                      'backcast': (range(2005, 2012), range(2003, 2005))},
}
# 'backcast' (train years, test years): the Aqua and Terra factors are applied to years BEFORE their overlap
# (2002-2011 and 2000-2002), so we also refit on later years and score earlier ones.
LAMS = [0, 5, 20, 50, 100, 200, 500, 1000, 2000]
E = 8            # evaluation cell = 8 x 8 grid cells (40 km)
B, SB = 64, 4    # fitting block = 64 cells (320 km); super-block = 4 x 4 blocks (1,280 km)
SCALES = {'40km': 1, '320km': B // E, '1280km': B * SB // E}  # in units of 40 km cells


def popcount32(a):
    a = a.astype(np.uint32)
    a = a - ((a >> 1) & 0x55555555); a = (a & 0x33333333) + ((a >> 2) & 0x33333333)
    return (((a + (a >> 4)) & 0x0F0F0F0F) * 0x01010101 >> 24).astype(np.int64)


def availability(daily):
    avail = {}
    for p, v in daily.items():
        s = pd.Series(v, dtype=float); s.index = pd.to_datetime(s.index); s = s.sort_index()
        full = pd.date_range(s.index.min(), s.index.max(), freq='D'); s = s.reindex(full, fill_value=0.0)
        med = s.replace(0, np.nan).rolling(31, center=True, min_periods=7).median()
        avail[p] = s[(s >= 0.5 * med) & (s > 0)].index
    return avail


def month_masks(days_a, days_b):
    masks = {}
    for d in days_a.intersection(days_b):
        m = (d.year - 2000) * 12 + d.month - 1
        masks[m] = masks.get(m, 0) | (1 << (d.day - 1))
    return masks


def sums40(p, years, mmask):
    """Matched cell-days per (ex, ey, m) at the 40 km evaluation scale."""
    frames = []
    for y in years:
        f = plat / f'q_{p}_{y}.parquet'
        if not f.exists(): continue
        d = pd.read_parquet(f, columns=['cx', 'cy', 'm', 'days'])
        mm = d['m'].map(mmask).fillna(0).astype(np.uint32).to_numpy()
        frames.append(pd.DataFrame({'ex': np.floor_divide(d['cx'].to_numpy(), E), 'ey': np.floor_divide(d['cy'].to_numpy(), E), 'm': d['m'].to_numpy(), 'cd': popcount32(d['days'].to_numpy() & mm)}))
    if not frames: return pd.DataFrame(columns=['ex', 'ey', 'm', 'cd'])
    return pd.concat(frames).groupby(['ex', 'ey', 'm'], as_index=False)['cd'].sum()


def band_of(by):
    y = (np.asarray(by) * B + B / 2) * 5.0; s = np.clip(y * math.cos(math.pi / 6) / 6371.0, -1, 1)
    return np.floor(np.degrees(np.arcsin(s)) / 15).astype(int)


def joined(src, ref):
    j = pd.merge(src.rename(columns={'cd': 's'}), ref.rename(columns={'cd': 'r'}), on=['ex', 'ey', 'm'], how='outer').fillna(0)
    j['bx'] = np.floor_divide(j['ex'], B // E); j['by'] = np.floor_divide(j['ey'], B // E); j['cal'] = j['m'] % 12
    return j


def fit(src, ref, lam):
    j = joined(src, ref); L = max(lam, 1)
    q_all = float(j['r'].sum() / max(1.0, j['s'].sum()))
    g = j.groupby('cal')[['s', 'r']].sum().reindex(range(12), fill_value=0)
    qg = ((g['r'] + L * q_all) / (g['s'] + L)).to_dict()
    j['band'] = band_of(j['by'].to_numpy()); j['sbx'] = np.floor_divide(j['bx'], SB); j['sby'] = np.floor_divide(j['by'], SB)
    def shrink(df, parent):
        return (df['r'] + lam * parent) / (df['s'] + lam) if lam else (df['r'] / df['s'].replace(0, np.nan)).fillna(parent)
    bd = j.groupby(['band', 'cal'])[['s', 'r']].sum().reset_index(); bd['q'] = shrink(bd, bd['cal'].map(qg))
    qb = {(a, c): q for a, c, q in bd[['band', 'cal', 'q']].itertuples(index=False)}
    # One factor per super-block x month (Astra 15a: keying by band as well let super-blocks that straddle a band edge
    # overwrite each other). Its parent is the latitude band of the super-block's centre (global month if that band is empty).
    sb = j.groupby(['sbx', 'sby', 'cal'])[['s', 'r']].sum().reset_index()
    sb['band'] = band_of(sb['sby'].to_numpy() * SB + (SB - 1) / 2)
    sb['q'] = shrink(sb, pd.Series([qb.get((a, c), qg[c]) for a, c in zip(sb['band'], sb['cal'])], index=sb.index))
    qs = {(a, b, c): q for a, b, c, q in sb[['sbx', 'sby', 'cal', 'q']].itertuples(index=False)}
    bl = j.groupby(['bx', 'by', 'sbx', 'sby', 'cal'])[['s', 'r']].sum().reset_index(); bl['q'] = shrink(bl, pd.Series([qs[(a, b, c)] for a, b, c in zip(bl['sbx'], bl['sby'], bl['cal'])], index=bl.index))
    return {'all': q_all, 'global': qg, 'band': qb, 'super': qs, 'block': {(a, b, c): q for a, b, c, q in bl[['bx', 'by', 'cal', 'q']].itertuples(index=False)}}


def lookup(model, bx, by, cal, exclude_local=False):
    if not exclude_local:
        k = (bx, by, cal)
        if k in model['block']: return model['block'][k]
        sk = (bx // SB, by // SB, cal)
        if sk in model['super']: return model['super'][sk]
    bk = (int(band_of(np.array([by]))[0]), cal)
    return model['band'].get(bk, model['global'].get(cal, model['all']))


def climatology(src, ref):
    """Training-year baseline per 320 km block x calendar month: the mean (for the rank test) and the per-year values
    (for the app-style class test; block-months with no activity in a training year count as zeros)."""
    j = joined(src, ref); years = max(1, j['m'].floordiv(12).nunique())
    c = j.groupby(['bx', 'by', 'cal'])[['s', 'r']].sum() / years
    t = j.groupby(['bx', 'by', 'm', 'cal'])[['s', 'r']].sum().reset_index()
    mean = c.rename(columns={'s': 'clim_s', 'r': 'clim_r'}).reset_index()
    mean.attrs['dist'], mean.attrs['years'] = t, years
    return mean


def pct_vs_training(k, col, t, tcol, n_years):
    """Mid-rank percentile of k[col] among the training-year values t[tcol] of the same block and calendar month."""
    kk = k[['bx', 'by', 'cal']].copy(); kk['v'] = k[col].to_numpy(); kk['i'] = np.arange(len(k))
    mm = kk.merge(t[['bx', 'by', 'cal', tcol]], on=['bx', 'by', 'cal'], how='left')
    lt = (mm[tcol] < mm['v']).groupby(mm['i']).sum().reindex(range(len(k)), fill_value=0).to_numpy()
    eq = (mm[tcol] == mm['v']).groupby(mm['i']).sum().reindex(range(len(k)), fill_value=0).to_numpy()
    present = mm[tcol].notna().groupby(mm['i']).sum().reindex(range(len(k)), fill_value=0).to_numpy()
    zeros = np.maximum(0, n_years - present); v = kk['v'].to_numpy()
    lt = lt + np.where(v > 0, zeros, 0); eq = eq + np.where(v == 0, zeros, 0)
    return 100.0 * (lt + eq / 2.0) / max(1, n_years)


def metrics(df, label):
    res = {'label': label, 'units': int(len(df)), 'refCellDays': float(df['r'].sum())}
    for name in ('raw', 'pred_global', 'pred'):
        e = df[name] - df['r']; res[name] = {'bias': float(e.sum() / max(1, df['r'].sum())), 'nae': float(e.abs().sum() / max(1, df['r'].sum())), 'mae': float(e.abs().mean())}
    return res


def score(j, label, clim=None):
    """Metrics for a joined frame that already carries q (local factor) and qg (one global factor per calendar month)."""
    j = j.copy(); j['pred'] = j['s'] * j['q']; j['pred_global'] = j['s'] * j['qg']; j['raw'] = j['s']
    res = {'label': label, 'scales': {}}
    for name, f in SCALES.items():
        g = j.assign(ux=np.floor_divide(j['ex'], f), uy=np.floor_divide(j['ey'], f)).groupby(['ux', 'uy', 'm'])[['r', 'pred', 'pred_global', 'raw']].sum().reset_index()
        res['scales'][name] = metrics(g, name)
    g = j.groupby('m')[['r', 'pred', 'pred_global', 'raw']].sum().reset_index(); res['scales']['global'] = metrics(g, 'global')
    res['globalMonthly'] = [{'month': f'{2000 + int(m) // 12}-{int(m) % 12 + 1:02d}', 'reference': float(r), 'harmonized': float(p), 'raw': float(w)}
                            for m, r, p, w in g[['m', 'r', 'pred', 'raw']].itertuples(index=False)]
    if clim is not None:
        k = j.groupby(['bx', 'by', 'm', 'cal'])[['r', 'pred', 'raw']].sum().reset_index().merge(clim, on=['bx', 'by', 'cal'], how='inner')
        k = k[(k.groupby(['bx', 'by'])['r'].transform('sum') >= 50) & (k['clim_r'] > 0)].copy()
        if len(k) > 20:
            # Anomaly = month / same-calendar-month climatology of the training years. The reference record's own anomaly is the target.
            #   harmonized: bridged source vs the reference climatology (what the app does across a sensor switch)
            #   naive: raw source counts vs the reference climatology (splicing without harmonization)
            #   raw: source vs its OWN climatology (only possible while one sensor covers the whole baseline)
            k['a_r'] = (k['r'] + 1) / (k['clim_r'] + 1); k['a_pred'] = (k['pred'] + 1) / (k['clim_r'] + 1)
            k['a_naive'] = (k['raw'] + 1) / (k['clim_r'] + 1); k['a_raw'] = (k['raw'] + 1) / (k['clim_s'] + 1)
            res['anomalySpearman320km'] = {n: float(k['a_r'].rank().corr(k[f'a_{c}'].rank())) for n, c in (('harmonized', 'pred'), ('naiveSplice', 'naive'), ('raw', 'raw'))}
            # App-style test: classify each test month as below (<=30th pct) / typical / above (>=70th pct) of the SAME block
            # and calendar month in the training years, as the calendar's "vs usual" colours do. The reference record's own
            # class is the target. A naive splice compares raw source counts with the reference baseline.
            t, ny = clim.attrs.get('dist'), clim.attrs.get('years', 0)
            if t is not None and ny >= 3:
                cls = lambda pc: np.where(pc >= 70, 2, np.where(pc <= 30, 0, 1))
                c_r = cls(pct_vs_training(k, 'r', t, 'r', ny))
                agree = {'harmonized': cls(pct_vs_training(k, 'pred', t, 'r', ny)), 'naiveSplice': cls(pct_vs_training(k, 'raw', t, 'r', ny)), 'raw': cls(pct_vs_training(k, 'raw', t, 's', ny))}
                res['anomalyClassAgreement320km'] = {n: float((c == c_r).mean()) for n, c in agree.items()}
                # Empirical chance level: agreement expected if each method kept its own class frequencies but matched at random.
                fr = np.bincount(c_r, minlength=3) / max(1, len(c_r))
                res['anomalyClassChance320km'] = {n: float((fr * (np.bincount(c, minlength=3) / max(1, len(c)))).sum()) for n, c in agree.items()}
                res['anomalyClassFrequencies320km'] = {'reference': fr.round(4).tolist(), **{n: (np.bincount(c, minlength=3) / max(1, len(c))).round(4).tolist() for n, c in agree.items()}}
                res['aboveNormalRecall320km'] = {n: float(((c == 2) & (c_r == 2)).sum() / max(1, (c_r == 2).sum())) for n, c in agree.items()}
                res['anomalyClassTest'] = {'units': int(len(k)), 'trainingYears': int(ny), 'classes': 'below <=30th percentile, typical, above >=70th percentile of the same 320 km block and calendar month in the training years',
                                           'scope': '320 km regions with >= 50 reference cell-days in the test years and a non-zero training baseline (low-activity regions excluded)'}
            top_r = k['a_r'] >= k['a_r'].quantile(0.9)
            for name in ('pred', 'naive', 'raw'):
                top_p = k[f'a_{name}'] >= k[f'a_{name}'].quantile(0.9)
                res[f'topDecileAnomaly320km_{name}'] = {'precision': float((top_r & top_p).sum() / max(1, top_p.sum())), 'recall': float((top_r & top_p).sum() / max(1, top_r.sum()))}
    return res, j


def evaluate(model, src, ref, label, clim=None, local=True):
    """local=False withholds the region's own block and super-block factors (fallback-factor test; parent levels still saw the region)."""
    j = joined(src, ref)
    if j.empty: return None
    j['q'] = [lookup(model, a, b, c, not local) for a, b, c in zip(j['bx'], j['by'], j['cal'])]
    j['qg'] = j['cal'].map(model['global']).fillna(model['all'])
    return score(j, label, clim)


K_FOLDS = 5


def region_fold(ex, ey):
    """Spatial fold of each 40 km unit's 1,280 km region. Neighbouring regions fall in different folds."""
    sbx = np.floor_divide(np.floor_divide(np.asarray(ex), B // E), SB); sby = np.floor_divide(np.floor_divide(np.asarray(ey), B // E), SB)
    return np.mod(7 * sbx + 3 * sby, K_FOLDS)


def spatial_cv(S_train, R_train, S_test, R_test, lam, clim):
    """Leave-region-out cross-validation: each fold's 1,280 km regions are removed from the TRAINING data at every level
    (block, super-block, latitude band, global), the factors are refitted, and the held-out regions are scored on TEST years.
    Nothing the held-out regions recorded enters the factors applied to them."""
    jt = joined(S_test, R_test)
    if jt.empty: return None
    ft, fs, fr = region_fold(jt['ex'], jt['ey']), region_fold(S_train['ex'], S_train['ey']), region_fold(R_train['ex'], R_train['ey'])
    parts = []
    for k in range(K_FOLDS):
        part = jt[ft == k].copy()
        if part.empty: continue
        mk = fit(S_train[fs != k], R_train[fr != k], lam)
        part['q'] = [lookup(mk, a, b, c) for a, b, c in zip(part['bx'], part['by'], part['cal'])]
        part['qg'] = part['cal'].map(mk['global']).fillna(mk['all'])
        parts.append(part)
    return score(pd.concat(parts, ignore_index=True), 'test-spatial-cv', clim)


def switch_test(model, src, ref):
    """Artificial sensor switch inside overlap years: harmonized source before the midpoint, reference after.
    A good bridge leaves no step: compare the mean log ratio (stitched/ref) before vs after at 320 km blocks."""
    j = joined(src, ref)
    if j.empty: return None
    j['q'] = [lookup(model, a, b, c) for a, b, c in zip(j['bx'], j['by'], j['cal'])]
    mid = (j['m'].min() + j['m'].max()) // 2
    j['stitched'] = np.where(j['m'] < mid, j['s'] * j['q'], j['r']); j['raw_stitched'] = np.where(j['m'] < mid, j['s'], j['r'])
    g = j.groupby(['bx', 'by', 'm'])[['r', 'stitched', 'raw_stitched']].sum().reset_index(); g = g[g['r'] >= 20]
    before = g['m'] < mid
    step = lambda col: float(np.log((g.loc[before, col].sum() + 1) / (g.loc[before, 'r'].sum() + 1)))
    return {'switchMonth': f'{2000 + mid // 12}-{mid % 12 + 1:02d}', 'logStepHarmonized': step('stitched'), 'logStepRaw': step('raw_stitched'), 'blocks': int(g[['bx', 'by']].drop_duplicates().shape[0])}


def main():
    daily = json.loads((plat / 'daily_q.json').read_text()); avail = availability(daily)
    report = {'reference': 'Suomi NPP VIIRS-equivalent 5 km cell-days', 'filter': 'MODIS confidence >= 30; VIIRS nominal/high; FIRMS type 0 (presumed vegetation fire)',
              'availabilityRule': 'platform-day available if global occupied 5 km cells >= 50% of its centred 31-day median', 'pairs': {}}
    factors = {}
    only = [x for x in os.environ.get('HARMONIZE_PAIRS', '').split(',') if x]
    for name, cfg in PAIRS.items():
        if only and name not in only: continue
        src_p, ref_p = cfg['src'], cfg['ref']
        if src_p not in avail or ref_p not in avail: report['pairs'][name] = {'status': 'insufficient data'}; continue
        mm = month_masks(avail[src_p], avail[ref_p])
        S = {k: sums40(src_p, cfg[k], mm) for k in ('train', 'tune', 'test', 'stress')}
        R = {k: sums40(ref_p, cfg[k], mm) for k in ('train', 'tune', 'test', 'stress')}
        if S['train'].empty or R['train'].empty or S['test'].empty: report['pairs'][name] = {'status': 'insufficient data'}; continue
        clim = climatology(S['train'], R['train']); tune = []
        for lam in LAMS:
            ev = evaluate(fit(S['train'], R['train'], lam), S['tune'], R['tune'], 'tune')
            if ev: tune.append((ev[0]['scales']['320km']['pred']['nae'], lam))
        lam = min(tune)[1] if tune else 100
        model = fit(S['train'], R['train'], lam)
        r = {'lambdaNote': 'shrinkage strength (one number) tuned once on all regions using the tuning years; the leave-region-out and backcast checks keep it fixed, so they are conditional on that choice',
             'lambda': lam, 'tuning': [{'lambda': l, 'nae320km': v} for v, l in sorted(tune, key=lambda t: t[1])], 'matchedDays': len(avail[src_p].intersection(avail[ref_p])),
             'years': {k: [cfg[k].start, cfg[k].stop - 1] if len(cfg[k]) else None for k in ('train', 'tune', 'test', 'stress')},
             'globalQByCalendarMonth': {int(k): float(v) for k, v in model['global'].items()}, 'qAllMonths': model['all']}
        for split in ('test', 'stress'):
            ev = evaluate(model, S[split], R[split], split, clim=clim)
            if ev: r[split] = ev[0]
        ev = spatial_cv(S['train'], R['train'], S['test'], R['test'], lam, clim)
        if ev: r['testSpatialCV'] = {**ev[0], 'design': f'{K_FOLDS}-fold leave-region-out: 1,280 km regions are removed from the training years at every factor level, the factors are refitted, and the held-out regions are scored on the test years'}
        ev = evaluate(model, S['test'], R['test'], 'test-fallback-factors', clim=clim, local=False)
        if ev: r['testFallbackFactors'] = {**ev[0], 'design': 'local 320 km and 1,280 km factors withheld; latitude-band and global factors (fitted on all regions) applied'}
        r['switchTest'] = switch_test(model, S['test'], R['test'])
        if 'backcast' in cfg:
            btr, bte = cfg['backcast']
            Sb, Rb = sums40(src_p, btr, mm), sums40(ref_p, btr, mm)
            Sbt, Rbt = sums40(src_p, bte, mm), sums40(ref_p, bte, mm)
            if not Sb.empty and not Sbt.empty:
                ev = evaluate(fit(Sb, Rb, lam), Sbt, Rbt, 'backcast', clim=climatology(Sb, Rb))
                if ev: r['backcast'] = {**ev[0], 'design': f'factors refitted on {btr.start}-{btr.stop - 1} and scored on the EARLIER years {bte.start}-{bte.stop - 1}, as they are used before the overlap period', 'years': [bte.start, bte.stop - 1]}
        final = fit(pd.concat([S['train'], S['tune']]).groupby(['ex', 'ey', 'm'], as_index=False)['cd'].sum(),
                    pd.concat([R['train'], R['tune']]).groupby(['ex', 'ey', 'm'], as_index=False)['cd'].sum(), lam)
        factors[name] = {'lambda': lam, 'all': final['all'], 'global': {int(k): float(v) for k, v in final['global'].items()},
                         'band': {f'{a}:{c}': float(v) for (a, c), v in final['band'].items()},
                         'super': {f'{a}:{b}:{c}': float(v) for (a, b, c), v in final['super'].items()},
                         'block': {f'{a}:{b}:{c}': round(float(v), 4) for (a, b, c), v in final['block'].items()}}
        report['pairs'][name] = r
        t = r.get('test', {}).get('scales', {}); cv = r.get('testSpatialCV', {}).get('scales', {})
        print(name, 'lam', lam, 'matchedDays', r['matchedDays'], {s: (round(v['raw']['nae'], 3), round(v['pred']['nae'], 3), round(v['pred']['bias'], 3)) for s, v in t.items()},
              'classAgree', r.get('test', {}).get('anomalyClassAgreement320km'), 'spatialCV', {s: round(v['pred']['nae'], 3) for s, v in cv.items()}, 'backcast', {s: round(v['pred']['nae'], 3) for s, v in r.get('backcast', {}).get('scales', {}).items()}, 'spearman', r.get('test', {}).get('anomalySpearman320km'), 'switch', r['switchTest'], flush=True)
    (out / 'harmonization-report.json').write_text(json.dumps(report, indent=1))
    (out / 'harmonization-factors.json').write_text(json.dumps(factors, separators=(',', ':')))
    (out / 'availability.json').write_text(json.dumps({p: [d.strftime('%Y-%m-%d') for d in v] for p, v in avail.items()}, separators=(',', ':')))


if __name__ == '__main__':
    main()
