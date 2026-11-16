#!/usr/bin/env python3
"""Execute the frozen v2 protocol. Test TIFFs are opened only after selection freezes.

Training, calibration and selection are distinct. All source TIFFs must have passed
the byte-range extractor's CRC/SHA checks. Published artifacts are never modified.
"""
import argparse, hashlib, json, math, os, sys, importlib.metadata
from pathlib import Path
from datetime import datetime, timezone
import numpy as np
from scipy.optimize import minimize_scalar
from scipy.special import expit, logit
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.metrics import average_precision_score, brier_score_loss
from pyproj import Transformer
from train import FEATURES, prepare, metrics, tree_export
from check_features import audit_data

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def save(p,value,compact=False):p.write_text(json.dumps(value,indent=None if compact else 2,separators=(',',':') if compact else None,allow_nan=False))
def export_predict(model,x):
    """Independent exported-tree inference, also used for frozen-v1 comparison."""
    score=np.full(len(x),model['base'],dtype=float)
    for tree in model['trees']:
        nodes=np.asarray(tree);at=np.zeros(len(x),dtype=int);done=np.zeros(len(x),dtype=bool)
        for _ in range(len(nodes)+1):
            leaf=nodes[at,6].astype(bool);new=leaf&~done;score[new]+=nodes[at[new],0];done|=leaf
            if done.all():break
            rows=np.flatnonzero(~done);n=nodes[at[rows]];v=x[rows,n[:,1].astype(int)]
            left=np.where(np.isfinite(v),v<=n[:,2],n[:,3].astype(bool));at[rows]=np.where(left,n[:,4],n[:,5]).astype(int)
        else:raise ValueError('Invalid exported tree cycle')
    p=expit(model['calibration']['slope']*logit(np.clip(expit(score),1e-6,1-1e-6))+model['calibration']['intercept'])
    if 'mixture' in model:
        mix=model['mixture'];baseline=np.asarray(mix['baselineRates'])[x[:,mix['baselineFeatureIndex']].astype(int)]
        p=mix['treeWeight']*p+(1-mix['treeWeight'])*baseline
    return p

def eligible(event,boundaries):
    p=prepare(event,boundaries)
    if 'skipped' in p:return p
    finite=np.isfinite(p['x']).all(axis=1);p['excludedMissingFeatureCells']=int((~finite).sum())
    # Match the deployed path: incomplete-feature cells are abstentions.
    for key in ('x','y','recent','lat','lon','row','col'):p[key]=p[key][finite]
    if not len(p['y']):return {'event':event['event'],'split':event['split'],'skipped':'No cells with complete 25-feature inputs','excludedMissingFeatureCells':p['excludedMissingFeatureCells']}
    return p

def arrays(events):
    if not events:raise ValueError('Frozen split has no eligible events; no replacements allowed')
    x=np.concatenate([p['x'] for p in events]);y=np.concatenate([p['y'] for p in events])
    w=np.concatenate([np.full(len(p['y']),1/len(p['y'])) for p in events]);w*=len(w)/w.sum()
    return x,y,w

def threshold(y,p,w):
    grid=np.unique(np.concatenate([np.arange(.001,.1,.001),np.arange(.1,.951,.025)]))
    def f1(t):
        z=p>=t;return 2*np.sum(w*y*z)/max(1e-12,np.sum(w*y)+np.sum(w*z))
    return float(max(grid,key=lambda t:(f1(t),t)))

def fit_offset(y,raw,w,allowed):
    if not allowed:return 0.
    z=logit(np.clip(raw,1e-6,1-1e-6))
    objective=lambda b:float(np.average(np.logaddexp(0,z+b)-y*(z+b),weights=w)+.005*b*b)
    result=minimize_scalar(objective,bounds=(-2,2),method='bounded',options={'xatol':1e-10})
    if not result.success:raise ValueError('Calibration minimization failed')
    return float(result.x)

def paired_bootstrap(events,clusters,y,predictions,w):
    starts=np.cumsum([0]+[len(e['y']) for e in events]);by_id={e['event']:np.arange(starts[i],starts[i+1]) for i,e in enumerate(events)}
    units=[np.concatenate([by_id[e] for e in c if e in by_id]) for c in clusters if any(e in by_id for e in c)]
    rng=np.random.default_rng(20261025);draws={k:{'brier':[],'prAuc':[]} for k in predictions};undefined=0
    for _ in range(1000):
        ix=np.concatenate([units[i] for i in rng.integers(0,len(units),len(units))]);yy=y[ix];ww=w[ix]
        if not yy.sum():undefined+=1
        for name,p in predictions.items():
            draws[name]['brier'].append(float(np.average((yy-p[ix])**2,weights=ww)))
            if yy.sum():draws[name]['prAuc'].append(float(average_precision_score(yy,p[ix],sample_weight=ww)))
    quant=lambda values:np.quantile(values,[.025,.975]).tolist() if len(values) else [None,None]
    intervals={'method':'1,000 paired bootstrap resamples of whole geographic test clusters; 25 km connected metadata centers. Every Brier draw retained; undefined AP draws omitted.',
        'bootstrapReplicates':1000,'geographicClusters':len(units),'undefinedPrAucDraws':undefined,
        'prAuc':quant(draws['model']['prAuc']),'brier':quant(draws['model']['brier'])}
    comparisons={}
    for name in ('previousVersion','smoothedPersistence','persistence','logistic'):
        db=np.asarray(draws['model']['brier'])-draws[name]['brier'];da=np.asarray(draws['model']['prAuc'])-draws[name]['prAuc']
        comparisons[name]={'brierDelta':float(np.average((y-predictions['model'])**2-(y-predictions[name])**2,weights=w)),
            'brierDelta95':quant(db),'prAucDelta':float(average_precision_score(y,predictions['model'],sample_weight=w)-average_precision_score(y,predictions[name],sample_weight=w)) if y.sum() else None,
            'prAucDelta95':quant(da),'deltaConvention':'new minus comparator; negative Brier and positive PR-AUC favor new model'}
    return intervals,comparisons

def make_replays(events,scores):
    result=[];offset=0
    for e in events:
        n=len(e['y']);p=scores[offset:offset+n];offset+=n;trans=Transformer.from_crs(e['epsg'],4326,always_xy=True);cells=[]
        for i in range(n):
            r,c=int(e['row'][i]),int(e['col'][i]);ox,oy=e['origin'];xy=[(ox+c*1500,oy-r*1500),(ox+(c+1)*1500,oy-r*1500),(ox+(c+1)*1500,oy-(r+1)*1500),(ox+c*1500,oy-(r+1)*1500)]
            ring=[list(trans.transform(*p)) for p in xy];ring.append(ring[0]);cells.append({'id':f'{r}-{c}','polygon':ring,'p':round(float(p[i]),5),'observed':int(e['y'][i]),'previous':int(e['recent'][i])})
        result.append({'id':e['event'],'issueDate':e['dates'][2],'targetDate':e['dates'][3],'recentFireDate':e['dates'][1],'center':e['center'],'cells':cells})
    return result

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--run',type=Path,required=True);parser.add_argument('--out',type=Path);a=parser.parse_args()
    run=a.run.resolve();out=(a.out or run/'artifacts').resolve();out.mkdir(parents=True,exist_ok=True)
    protocol=json.loads((run/'protocol.json').read_text());plan=json.loads((run/'plan.json').read_text())
    assert sha(run/'plan.json')==protocol['planSha256'],'Frozen plan changed'
    assert sha(run/'frozen-v1/model.json')==protocol['frozenV1Sha256'],'Frozen previous model changed'
    manifest=json.loads((run/'data/manifest.json').read_text());ready=json.loads((run/'data/ready-events.json').read_text())
    if not manifest['complete'] or not ready['complete']:raise SystemExit('Extraction incomplete: final fitting requires the entire frozen sample')
    if manifest['planSha256']!=protocol['planSha256']:raise ValueError('Extraction is not from the frozen plan')
    planned={(e['event'],e['split']):[f['name'] for f in e['files']] for e in plan['selectionDetails']}
    actual=[(e['event'],e['split']) for e in ready['events']]
    if len(actual)!=len(planned) or len(set(actual))!=len(actual) or set(actual)!=set(planned):raise ValueError('Extraction manifest must contain every planned event exactly once')
    for e in ready['events']:
        assert [f['name'] for f in e['files']]==planned[e['event'],e['split']]
        for f in e['files']:
            if sha(Path(f['path']))!=f['sha256']:raise ValueError('Downloaded file changed after verification')
    app=Path(__file__).resolve().parents[2];boundaries=json.loads((app/'public/data/us-states.json').read_text())
    source_audit=audit_data(run/'data')  # TIFF metadata only: no test labels read.
    save(out/'source-audit.json',source_audit)
    groups={s:[] for s in ('train','selection','calibration','test')};skipped=[]
    # Do not open test TIFF labels during fitting/calibration/selection.
    for e in ready['events']:
        if e['split']=='test':continue
        p=eligible(e,boundaries)
        if 'skipped' in p:skipped.append(p)
        else:groups[p['split']].append(p)
    dev={s:arrays(groups[s]) for s in ('train','selection','calibration')}
    xt,yt,wt=dev['train'];xs,ys,ws=dev['selection'];xc,yc,wc=dev['calibration']
    if len(np.unique(yt))<2 or not ys.sum():raise ValueError('Insufficient development outcome support; frozen experiment cannot proceed')
    positive_cal_events=sum(bool(e['y'].sum()) for e in groups['calibration'])
    offset_allowed=bool(yc.sum()>=50 and (1-yc).sum()>=50 and positive_cal_events>=5)
    rates=[float(np.average(yt[xt[:,0]==v],weights=wt[xt[:,0]==v])) if np.any(xt[:,0]==v) else float(np.average(yt,weights=wt)) for v in (0,1)]
    bs=np.asarray(rates)[xs[:,0].astype(int)]
    print('Development support',json.dumps({s:{'events':len(groups[s]),'cells':len(dev[s][1]),'positiveCells':int(dev[s][1].sum()),'positiveEvents':sum(bool(e['y'].sum()) for e in groups[s])} for s in dev}),flush=True)
    candidates=[];models={};offsets={};config=protocol['candidates']
    for leaves in config['maxLeafNodes']:
        model=HistGradientBoostingClassifier(max_iter=config['maxIter'],max_leaf_nodes=leaves,learning_rate=config['learningRate'],min_samples_leaf=config['minSamplesLeaf'],l2_regularization=config['l2Regularization'],early_stopping=False,random_state=config['randomState'])
        model.fit(xt,yt,sample_weight=wt);models[leaves]=model
        raw=model.predict_proba(xs)[:,1];offsets[leaves]=fit_offset(yc,model.predict_proba(xc)[:,1],wc,offset_allowed)
        for calibration in config['calibration']:
            if calibration=='offset' and not offset_allowed:continue
            offset=offsets[leaves] if calibration=='offset' else 0.
            calibrated=expit(logit(np.clip(raw,1e-6,1-1e-6))+offset)
            for weight in config['treeWeights']:
                p=weight*calibrated+(1-weight)*bs
                candidates.append({'leaves':leaves,'calibration':calibration,'offset':offset,'treeWeight':weight,'selectionBrier':float(brier_score_loss(ys,p,sample_weight=ws))})
        print('Fitted candidate trees',leaves,'calibration offset',offsets[leaves],flush=True)
    winner=min(candidates,key=lambda c:c['selectionBrier']);model=models[winner['leaves']]
    def predict(x):
        p=expit(logit(np.clip(model.predict_proba(x)[:,1],1e-6,1-1e-6))+winner['offset'])
        return winner['treeWeight']*p+(1-winner['treeWeight'])*np.asarray(rates)[x[:,0].astype(int)]
    logistic=make_pipeline(SimpleImputer(add_indicator=True),StandardScaler(),LogisticRegression(max_iter=1000,C=.1,random_state=42))
    logistic.fit(xt,yt,logisticregression__sample_weight=wt)
    previous=json.loads((run/'frozen-v1/model.json').read_text())
    selection_scores={'model':predict(xs),'previousVersion':export_predict(previous,xs),'smoothedPersistence':bs,'persistence':xs[:,0],'logistic':logistic.predict_proba(xs)[:,1]}
    thresholds={name:threshold(ys,p,ws) for name,p in selection_scores.items()}
    exported=tree_export(model)|{'schemaVersion':2,'id':'ember-day-ahead-v2','features':FEATURES,
        'calibration':{'slope':1.,'intercept':winner['offset']},'threshold':thresholds['model'],'baselineRates':rates,
        'mixture':{'treeWeight':winner['treeWeight'],'baselineFeatureIndex':0,'baselineRates':rates}}
    np.testing.assert_allclose(export_predict(exported,xs),selection_scores['model'],rtol=0,atol=2e-14)
    # Freeze deployable fit and threshold before preparing any held-out test label.
    save(out/'model.json',exported,compact=True)
    selection={'protocolSha256':sha(run/'protocol.json'),'planSha256':protocol['planSha256'],'modelSha256':sha(out/'model.json'),'winner':winner,'candidates':candidates,
        'calibration':{'method':'bounded regularized intercept only','enabled':offset_allowed,'positiveCells':int(yc.sum()),'positiveEvents':positive_cal_events,'events':len(groups['calibration']),'offsets':offsets},
        'thresholds':thresholds,'selectionMetrics':{k:metrics(ys,p,ws,thresholds[k]) for k,p in selection_scores.items()},
        'testLabelsOpened':False,'frozenAt':datetime.now(timezone.utc).isoformat(),'developmentSkips':skipped.copy()}
    save(out/'selection.json',selection)
    print('SELECTION FROZEN',json.dumps(winner),'modelSHA256',sha(out/'model.json'),flush=True)
    # Test path starts here. No fitting, calibration or threshold change below.
    test_opened_at=datetime.now(timezone.utc).isoformat()
    for e in ready['events']:
        if e['split']!='test':continue
        p=eligible(e,boundaries)
        if 'skipped' in p:skipped.append(p)
        else:groups['test'].append(p)
    xx,yx,wx=arrays(groups['test']);dev['test']=(xx,yx,wx)
    predictions={'model':predict(xx),'previousVersion':export_predict(previous,xx),'smoothedPersistence':np.asarray(rates)[xx[:,0].astype(int)],'persistence':xx[:,0],'logistic':logistic.predict_proba(xx)[:,1]}
    np.testing.assert_allclose(export_predict(exported,xx),predictions['model'],rtol=0,atol=2e-14)
    result={name:metrics(yx,p,wx,thresholds[name]) for name,p in predictions.items()}
    fresh=xx[:,0]==0;result['newActivity']=metrics(yx[fresh],predictions['model'][fresh],wx[fresh],thresholds['model'])
    intervals,comparisons=paired_bootstrap(groups['test'],protocol['testClusters'],yx,predictions,wx)
    reliability=[]
    edges=[0,.001,.005,.01,.025,.05,.1,.2,.4,.6,.8,1.000001]
    for lo,hi in zip(edges[:-1],edges[1:]):
        take=(predictions['model']>=lo)&(predictions['model']<hi)
        if take.any():reliability.append({'low':lo,'high':min(1,hi),'meanPredicted':float(np.average(predictions['model'][take],weights=wx[take])),'observedRate':float(np.average(yx[take],weights=wx[take])),'cells':int(take.sum()),'positiveCells':int(yx[take].sum())})
    passes=bool(result['model']['brier']<result['previousVersion']['brier'] and result['model']['prAuc'] is not None and result['previousVersion']['prAuc'] is not None and result['model']['prAuc']>=result['previousVersion']['prAuc'])
    old_report=json.loads((run/'frozen-v1/evaluation.json').read_text())
    model_type='Train-fitted smoothed persistence selected by independent selection Brier (tree weight zero)' if winner['treeWeight']==0 else 'Histogram gradient-boosted trees, separate calibration and persistence blend selected by independent selection Brier'
    report={'schemaVersion':2,'modelId':exported['id'],'modelSha256':sha(out/'model.json'),'modelType':model_type,
        'selectedLeaves':winner['leaves'],'trees':config['maxIter'],'featureNames':FEATURES,
        'source':{'title':'WildfireSpreadTS v1.0','url':'https://zenodo.org/records/8006177','license':'CC-BY-4.0','selectedEvents':len(ready['events']),'downloadManifestSha256':sha(run/'data/manifest.json')},
        'target':old_report['target'],'timing':old_report['timing'],'excludedBands':old_report['excludedBands'],
        'splits':{s:{'years':plan['splits'][s],'events':len(events),'cells':len(dev[s][1]),'positives':int(dev[s][1].sum()),'positiveEvents':sum(bool(e['y'].sum()) for e in events),'ids':[e['event'] for e in events],'excludedMissingFeatureCells':sum(e['excludedMissingFeatureCells'] for e in events)} for s,events in groups.items()},
        'weighting':protocol['weighting']+' Calibration fits score offsets; independent selection chooses architecture/offset/mixture and each comparator threshold. Only the fresh 2021 test estimates performance.',
        'spatialEmbargoKm':25,'spatialPolicy':protocol['spatialPolicy'],'skippedEvents':skipped,'test':result,'confidenceIntervals':intervals,'pairedComparisons':comparisons,'reliability':reliability,
        'previousVersion':{'id':previous['id'],'sha256':protocol['frozenV1Sha256'],'originalThreshold':previous['threshold'],'selectionThreshold':thresholds['previousVersion'],'comparison':'Frozen original parameters on exactly the same finite-feature new test cells, with identical event weights.'},
        'protocol':{'id':protocol['id'],'sha256':sha(run/'protocol.json'),'planSha256':protocol['planSha256'],'selectionSha256':sha(out/'selection.json'),'chosen':winner,'calibrationSupport':selection['calibration'],'releaseGate':protocol['releaseGate']},
        'releaseGate':{'passed':passes,'brierImproved':result['model']['brier']<result['previousVersion']['brier'],'rankingNotWorse':result['model']['prAuc'] is not None and result['previousVersion']['prAuc'] is not None and result['model']['prAuc']>=result['previousVersion']['prAuc'],'decision':'Eligible for default release after implementation checks' if passes else 'Retain v1 default; candidate is diagnostic only; no test-guided refit'},
        'limitations':['250 fixed selected events yielded fewer eligible examples; no replacement was made after seeing labels or input eligibility. One randomly chosen target day per event is not nationwide or prospective validation.',
            'Selection metrics are used for model choice and are optimistic. Calibration and selection are separate; neither replaces untouched test evidence.',
            '25 km metadata-center grouping is only a proxy for incident complexes and leaves longer-range weather/spatial dependence.',
            'Labels record retained S-NPP detections. Missing detections are not proof that a cell was observed clear or unburned. No satellite coverage mask is available.',
            'The frozen historical eligibility rule does not remove NASA-listed satellite outage dates. Live source-health abstention is stricter; primary historical scores include any such gaps and are not a coverage-qualified live evaluation.',
            'Finalized historical gridMET, WSTS rasterization and live provider differences mean historical skill does not establish live probability calibration.',
            'Fuel structure, live/dead moisture, suppression, spotting and ignition processes are not fully observed. This is not a flame front, official warning, evacuation or crew allocation product.',
            'S-NPP delivery cessation is scheduled for 2026-11-02 13:00 UTC. The model abstains without its matching source; another platform requires retraining.'],
        'events':[{k:e[k] for k in ('event','split','dates','center','sourceHashes','excludedMissingFeatureCells')} for events in groups.values() for e in events]}
    if not offset_allowed:report['limitations'].insert(1,'The frozen calibration support gate was not met; only identity calibration candidates were allowed.')
    gap_path=run/'source-gap-audit.json'
    if gap_path.exists():
        gap_audit=json.loads(gap_path.read_text())
        if gap_audit['planSha256']!=protocol['planSha256']:raise ValueError('Source-gap audit belongs to a different plan')
        secondary_path=run/'source-availability-secondary-plan.json';secondary=json.loads(secondary_path.read_text())
        if secondary['planSha256']!=protocol['planSha256'] or secondary['sourceGapAuditSha256']!=sha(gap_path):raise ValueError('Secondary source diagnostic differs from its frozen metadata plan')
        by_event={e['event']:e for e in gap_audit['events']}
        selection_mask=np.concatenate([np.full(len(e['y']),not by_event[e['event']]['inputGap']) for e in groups['test']])
        report['sourceAvailabilityDiagnostics']={
            'sourceUrl':gap_audit['sourceUrl'],'sourceHtmlSha256':gap_audit['sourceHtmlSha256'],'fetchedAt':gap_audit['fetchedAt'],'auditSha256':sha(gap_path),'secondaryPlanSha256':sha(secondary_path),
            'plannedSplitCounts':gap_audit['bySplit'],'eligibleTestInputGapEvents':[e['event'] for e in groups['test'] if by_event[e['event']]['inputGap']],
            'eligibleTestTargetGapEvents':[e['event'] for e in groups['test'] if by_event[e['event']]['targetGap']],
            'knownInputGapExcluded':{'events':sum(not by_event[e['event']]['inputGap'] for e in groups['test']),
                'cells':int(selection_mask.sum()),'positives':int(yx[selection_mask].sum()),
                'test':{name:metrics(yx[selection_mask],p[selection_mask],wx[selection_mask],thresholds[name]) for name,p in predictions.items()} if selection_mask.any() else {}},
            'scope':'Secondary descriptive diagnostic predeclared before test access. Excludes events with NASA-listed required-input-day outages; target-day gaps remain. Primary scores, selection and release gate are unchanged. The retrospective catalogue and unknown local cloud/overpass coverage do not prove operational availability.'}
        save(out/'source-gap-audit.json',gap_audit)
    save(out/'evaluation.json',report);save(out/'replays.json',make_replays(groups['test'],predictions['model']),compact=True)
    save(out/'parity.json',{'modelSha256':sha(out/'model.json'),'vectors':xx.tolist(),'probabilities':predictions['model'].tolist()},compact=True)
    np.savez_compressed(out/'heldout-predictions.npz',x=xx,y=yx,p=predictions['model'],weights=wx,previousVersion=predictions['previousVersion'],smoothedPersistence=predictions['smoothedPersistence'],persistence=predictions['persistence'],logistic=predictions['logistic'])
    # Development predictions permit reproducibility/audit without refitting on test.
    np.savez_compressed(out/'selection-predictions.npz',x=xs,y=ys,weights=ws,**selection_scores)
    save(out/'execution.json',{'python':sys.version,'packages':{name:importlib.metadata.version(name) for name in ('numpy','scipy','scikit-learn','tifffile','pyproj')},'protocolSha256':sha(run/'protocol.json'),'trainerSha256':sha(Path(__file__)),'featureBuilderSha256':sha(Path(__file__).with_name('train.py')),'selectedModelSha256':selection['modelSha256'],'finalModelSha256':sha(out/'model.json'),'testOpenedAfterSelection':True,'selectionFrozenAt':selection['frozenAt'],'testOpenedAt':test_opened_at})
    print(json.dumps({'splits':report['splits'],'test':result,'pairedComparisons':comparisons,'releaseGate':report['releaseGate'],'out':str(out)},indent=2),flush=True)

if __name__=='__main__':main()
