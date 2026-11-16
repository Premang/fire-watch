#!/usr/bin/env python3
"""Freeze metadata-only event/window allocation before reading any v2 TIFF labels."""
import argparse, hashlib, json, math, random, re, shutil
from datetime import date, timedelta, datetime, timezone
from pathlib import Path

SEED = 20261024
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--research',type=Path,required=True);parser.add_argument('--out',type=Path,required=True)
    a=parser.parse_args();a.out.mkdir(parents=True,exist_ok=True)
    if (a.out/'protocol.json').exists(): raise SystemExit('Already frozen; refusing to change the existing protocol')
    app=Path(__file__).resolve().parents[2]
    index=json.loads((a.research/'wfts-data/archive-index.json').read_text())['entries'];meta={}
    for year in range(2018,2022):
        text=(a.research/f'wfts-events-{year}.yml').read_text()
        for m in re.finditer(r'(fire_\d+):\n  latitude: ([\d.-]+)\n  longitude: ([\d.-]+)',text):
            meta[f'{year}/{m[1]}']=(float(m[2]),float(m[3]))
    files={}
    for name,v in index.items():
        if v['bytes']<=12_000_000 and v['compressedBytes']<=12_000_000:
            files.setdefault('/'.join(name.split('/')[:2]),[]).append(name)
    windows={}
    for event,names in sorted(files.items()):
        if event not in meta:continue
        lat,lon=meta[event]
        if not (24<=lat<=50 and -125<=lon<=-66):continue
        dates=sorted(date.fromisoformat(Path(n).stem) for n in names);available=set(dates)
        starts=[d for d in dates if all(d+timedelta(days=i) in available for i in range(4))]
        if starts:windows[event]=starts
    def distance(e,f):
        lat,lon=meta[e];lat2,lon2=meta[f]
        return math.hypot((lat-lat2)*111.2,(lon-lon2)*111.2*math.cos(math.radians((lat+lat2)/2)))
    def near(e,f):return distance(e,f)<25
    def components(events):
        left=sorted(events);groups=[]
        while left:
            group=[left.pop(0)];i=0
            while i<len(group):
                neighbors=[e for e in left if near(e,group[i])]
                for e in neighbors:left.remove(e);group.append(e)
                i+=1
            groups.append(sorted(group))
        return groups
    old=json.loads((a.research/'wfts-subset-plan.json').read_text())
    old_test=[e['event'] for e in old['selectionDetails'] if e['event'].startswith('2021/')]
    rng=random.Random(SEED)
    fresh=[e for e in windows if e.startswith('2021/') and all(not near(e,o) for o in old_test)]
    rng.shuffle(fresh);test=fresh[:50]
    if len(test)!=50:raise ValueError('Insufficient fresh geographically separated test candidates')
    development=[e for e in windows if not e.startswith('2021/') and all(not near(e,t) for t in test)]
    groups20=components([e for e in development if e.startswith('2020/')]);rng.shuffle(groups20)
    def take_groups(groups,n):
        picked=[];remaining=[]
        for group in groups:
            if len(picked)+len(group)<=n:picked.extend(group)
            else:remaining.append(group)
        if len(picked)!=n:raise ValueError('Metadata grouping could not achieve predeclared count')
        return picked,remaining
    selection,remaining=take_groups(groups20,50);calibration,_=take_groups(remaining,50)
    train_candidates=[e for e in development if e[:4] in ('2018','2019') and all(not near(e,v) for v in selection+calibration)]
    rng.shuffle(train_candidates);train=train_candidates[:100]
    if len(train)!=100:raise ValueError('Insufficient geographically separated train candidates')
    splits={'train':train,'selection':selection,'calibration':calibration,'test':test}
    for k,events in splits.items():
        for other,others in splits.items():
            if k<other:assert all(not near(e,f) for e in events for f in others)
    details=[]
    for split,events in splits.items():
        for e in sorted(events):
            local=random.Random(hashlib.sha256(f'{SEED}:{e}'.encode()).hexdigest())
            d=local.choice(windows[e]);names=[f'{e}/{d+timedelta(days=i)}.tif' for i in range(4)]
            entries=[{'name':name,**index[name]} for name in names]
            details.append({'event':e,'split':split,'metadataCenter':list(meta[e]),'files':entries,'compressedBytes':sum(v['compressedBytes'] for v in entries)})
    plan={'schemaVersion':2,'seed':SEED,'events':len(details),'files':len(details)*4,'compressedBytes':sum(e['compressedBytes'] for e in details),
        'selection':'Metadata-only fixed random events and uniformly random four-consecutive-day window per event. No input or target fire labels used; no replacement after eligibility filtering.',
        'splits':{'train':[2018,2019],'selection':[2020],'calibration':[2020],'test':[2021]},'selectionDetails':details}
    (a.out/'plan.json').write_text(json.dumps(plan,indent=2))
    frozen=a.out/'frozen-v1';frozen.mkdir()
    for name in ('model.json','evaluation.json'):shutil.copy2(app/'public/data/ml'/name,frozen/name)
    protocol={'id':'ember-day-ahead-v2-frozen-20261024','createdAt':datetime.now(timezone.utc).isoformat(),'seed':SEED,'planSha256':digest(a.out/'plan.json'),
        'metadataHashes':{f'wfts-events-{year}.yml':digest(a.research/f'wfts-events-{year}.yml') for year in range(2018,2022)},
        'sourceIndexSha256':digest(a.research/'wfts-data/archive-index.json'),'frozenV1Sha256':digest(frozen/'model.json'),
        'splitCounts':{k:len(v) for k,v in splits.items()},'excludedOriginal2021Events':old_test,'spatialEmbargoKm':25,
        'spatialPolicy':'Metadata centers at least 25 km apart between every split; fresh test also at least 25 km from all 10 original selected 2021 incidents. Connected 2020 geographic components kept in one split. Geographic proximity is only a proxy for incident-complex identity.',
        'testClusters':components(test),'eligibility':'Same 1.5 km cells within 12 km of recent fire, three-cell raster border excluded, CONUS. Additionally require all 25 features finite to match live deployment. Skip no-input-fire/non-CONUS events without replacement. Never filter on target labels.',
        'features':'Unchanged 25 v1 features and strict day-ahead timing. GFS forecasts describe issue day, not target day. Integer convolution densities and circular wind aggregation retained.',
        'candidates':{'maxLeafNodes':[7,15,31],'maxIter':120,'learningRate':0.06,'minSamplesLeaf':40,'l2Regularization':5,'earlyStopping':False,'randomState':42,
            'calibration':['identity','offset'],'calibrationFit':'Calibration split only; minimize event-weighted binary log loss + 0.005 * offset^2, offset bounded [-2,2]. Identity slope 1. Offset only available with at least 50 positive cells across at least 5 positive-containing calibration events and at least 50 negative cells.',
            'treeWeights':[0,0.25,0.5,0.75,1],'blend':'Convex average of calibrated tree score and train-fitted two-rate smoothed persistence. No prevalence rebalancing.',
            'selection':'Lowest event-weighted selection Brier across fixed candidates; deterministic tie order: fewer leaves, identity before offset, lower tree weight. Calibration is fit before selection; neither is an independent performance estimate.'},
        'baselines':['Frozen v1 on exactly the same new test cells','Train-fitted smoothed persistence','Hard persistence','Train-fitted imputed, standardized logistic regression C=0.1'],
        'thresholds':'Each model/baseline separately maximizes selection F1 on fixed grid 0.001..0.099 by .001, 0.1..0.95 by .025; ties choose larger threshold. Frozen v1 keeps original .05 as additional historical threshold; its comparison table uses independently selected threshold. Thresholds do not affect Brier/AP release gate.',
        'weighting':'Each eligible event equal total weight. No negative downsampling. No model refit on selection/calibration after selection.',
        'uncertainty':'1000 seeded paired bootstrap resamples of whole test geographic clusters (25 km connected metadata centers). Preserve all Brier draws; omit and report AP draws with no positives.',
        'releaseGate':'Default v2 only if new-test event-weighted Brier strictly lower than frozen v1 AND PR-AUC at least v1. Point estimates are only a release gate; no confident improvement claim unless paired interval supports it. If failed, retain v1; no test-guided changes or refit.',
        'testAccess':'Prepare/evaluate test labels only after selected model, calibration, mixture and all thresholds are frozen in selection.json. Test is one-shot; no replacement or tuning after test.',
        'limitations':['2020/2021 are historical datasets, not prospective live validation.','Metadata separation does not prove distinct incident complexes; limited regional coverage persists.','Finalized analysis data and satellite missingness limit operational claims.']}
    (a.out/'protocol.json').write_text(json.dumps(protocol,indent=2))
    data=a.out/'data';data.mkdir();shutil.copy2(a.research/'wfts-data/archive-index.json',data/'archive-index.json')
    reused=0
    for e in details:
        for f in e['files']:
            source=a.research/'wfts-data'/f['name'];dest=data/f['name']
            if source.exists():dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,dest);reused+=1
    print(json.dumps({'protocol':str(a.out/'protocol.json'),'planSha256':protocol['planSha256'],'splitCounts':protocol['splitCounts'],'compressedBytes':plan['compressedBytes'],'reusedFiles':reused,'trainCandidateCount':len(train_candidates),'freshTestCandidateCount':len(fresh)},indent=2))
if __name__=='__main__':main()
