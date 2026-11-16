#!/usr/bin/env python3
"""Reproducible pilot: WSTS 4-day windows -> day-ahead 1.5 km detection outlook.

Install numpy scipy scikit-learn tifffile imagecodecs pyproj; run with --data
pointing to the verified range-extraction manifest. Never selects on target fire.
"""
import argparse, hashlib, json, warnings
from pathlib import Path
import numpy as np
import tifffile
from pyproj import Transformer
from scipy.ndimage import distance_transform_edt, convolve
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss, precision_score, recall_score

FEATURES = ['fire_recent','fire_prior','distance_recent_km','distance_prior_km','density_3','density_7','nearest_east_km','nearest_north_km','elevation_m','slope_deg','aspect_sin','aspect_cos','elevation_above_fire_m','lag_precip_mm','lag_tmin_c','lag_tmax_c','lag_specific_humidity','lag_wind_ms','lag_wind_sin','lag_wind_cos','lag_erc','lag_pdsi','antecedent_gfs_temp_c','antecedent_gfs_specific_humidity','antecedent_gfs_vector_wind_ms']

def block(a, mode='mean'):
    h,w=a.shape[:2]; a=a[:h//4*4,:w//4*4]
    b=a.reshape(h//4,4,w//4,4,*a.shape[2:])
    with warnings.catch_warnings():
        warnings.simplefilter('ignore',RuntimeWarning)
        return np.nanmax(b,axis=(1,3)) if mode=='max' else np.nanmean(b,axis=(1,3))

def features(recent, prior, elev, weather, forecast):
    # Explicit row-major tie-break matches the deployed feature builder.
    rows,cols=np.indices(recent.shape); squared=np.full(recent.shape,np.inf)
    nearest=np.zeros((2,*recent.shape),dtype=int)
    for r,c in zip(*np.nonzero(recent)):
        d=(rows-r)**2+(cols-c)**2; better=d<squared
        squared[better]=d[better];nearest[0,better]=r;nearest[1,better]=c
    distance=np.sqrt(squared)
    older = distance_transform_edt(~prior) if prior.any() else np.full(recent.shape, 100.)
    gy,gx=np.gradient(elev,1500.)
    slope=np.degrees(np.arctan(np.hypot(gx,gy)))
    # Downslope compass aspect: raster y increases southward.
    aspect=np.arctan2(-gx,gy)
    return np.stack([recent,prior,np.minimum(distance*1.5,150),np.minimum(older*1.5,150),
        convolve(recent.astype(np.int32),np.ones((3,3),dtype=np.int32),mode='constant')/9,convolve(recent.astype(np.int32),np.ones((7,7),dtype=np.int32),mode='constant')/49,
        (cols-nearest[1])*1.5,(nearest[0]-rows)*1.5,elev,slope,np.sin(aspect),np.cos(aspect),elev-elev[tuple(nearest)],
        weather[...,5],weather[...,8]-273.15,weather[...,9]-273.15,weather[...,11],weather[...,6],
        np.sin(np.radians(weather[...,7])),np.cos(np.radians(weather[...,7])),weather[...,10],weather[...,15],
        forecast[...,20],forecast[...,21],forecast[...,18]],axis=-1)

def inside_ring(lon,lat,ring):
    inside=np.zeros(lon.shape,dtype=bool)
    for (x,y),(xx,yy) in zip(ring,ring[-1:]+ring[:-1]):
        if yy!=y: inside ^= ((y>lat)!=(yy>lat)) & (lon < (xx-x)*(lat-y)/(yy-y)+x)
    return inside

def us_mask(lon,lat,boundaries):
    keep=np.zeros(lon.shape,dtype=bool)
    for f in boundaries['features']:
        if f['properties']['code'] in ('AK','HI'): continue
        geom=f['geometry']; polys=[geom['coordinates']] if geom['type']=='Polygon' else geom['coordinates']
        for poly in polys:
            ring=np.asarray(poly[0]); bounds=(ring[:,0].min(),ring[:,0].max(),ring[:,1].min(),ring[:,1].max())
            if lon.max()<bounds[0] or lon.min()>bounds[1] or lat.max()<bounds[2] or lat.min()>bounds[3]: continue
            yes=inside_ring(lon,lat,poly[0])
            for hole in poly[1:]: yes &= ~inside_ring(lon,lat,hole)
            keep |= yes
    return keep

def prepare(event,boundaries):
    paths=[Path(f['path']) for f in event['files']]
    assert len(paths)==4
    dates=[p.stem for p in paths]
    assert all((np.datetime64(dates[i+1])-np.datetime64(dates[i]))/np.timedelta64(1,'D')==1 for i in range(3))
    with tifffile.TiffFile(paths[0]) as f: raw=f.asarray(); geo=f.geotiff_metadata
    if raw.shape[-1]!=23: raw=np.moveaxis(raw,0,-1)
    old=block(np.isfinite(raw[...,22]).astype(float),'max').astype(bool)
    weather=block(raw); elev=weather[...,14]
    weather[...,7]=np.degrees(np.arctan2(block(np.sin(np.radians(raw[...,7]))),block(np.cos(np.radians(raw[...,7])))))%360
    current=tifffile.imread(paths[1]); current=current if current.shape[-1]==23 else np.moveaxis(current,0,-1)
    recent=block(np.isfinite(current[...,22]).astype(float),'max').astype(bool)
    future=tifffile.imread(paths[2]); future=future if future.shape[-1]==23 else np.moveaxis(future,0,-1)
    forecast=block(future)
    target=tifffile.imread(paths[3]); target=target if target.shape[-1]==23 else np.moveaxis(target,0,-1)
    labels=block(np.isfinite(target[...,22]).astype(float),'max').astype(bool)
    if not recent.any(): return {'skipped':'No recent detections; outside model domain','event':event['event'],'split':event['split']}
    x=features(recent,old,elev,weather,forecast)
    h,w=recent.shape; rows,cols=np.indices((h,w)); origin=geo['ModelTiepoint'][3:5]
    transformer=Transformer.from_crs(int(geo['ProjectedCSTypeGeoKey']),4326,always_xy=True)
    lon,lat=transformer.transform(origin[0]+(cols+.5)*1500,origin[1]-(rows+.5)*1500)
    valid=us_mask(lon,lat,boundaries) & np.isfinite(elev) & (x[...,2]<=12)
    # Three-cell boundary excludes truncated 7x7 fire neighborhoods.
    valid[:3]=False; valid[-3:]=False; valid[:,:3]=False; valid[:,-3:]=False
    if valid.sum()<1: return {'skipped':'No eligible CONUS cells','event':event['event'],'split':event['split']}
    return {'event':event['event'],'split':event['split'],'dates':dates,'x':x[valid], 'y':labels[valid].astype(int),'recent':recent[valid].astype(int),
        'lat':lat[valid],'lon':lon[valid],'row':rows[valid],'col':cols[valid], 'shape':[h,w], 'origin':origin,'epsg':int(geo['ProjectedCSTypeGeoKey']),
        'center':[float(np.mean(lat[valid])),float(np.mean(lon[valid]))],'sourceHashes':[f['sha256'] for f in event['files']]}

def metrics(y,p,w,threshold):
    z=p>=threshold
    return {'prAuc':float(average_precision_score(y,p,sample_weight=w)) if y.sum() else None,
        'brier':float(brier_score_loss(y,p,sample_weight=w)), 'logLoss':float(log_loss(y,np.clip(p,1e-7,1-1e-7),sample_weight=w,labels=[0,1])),
        'precision':float(precision_score(y,z,sample_weight=w,zero_division=0)), 'recall':float(recall_score(y,z,sample_weight=w,zero_division=0)),
        'positiveRate':float(np.average(y,weights=w)), 'predictedPositiveRate':float(np.average(z,weights=w)),
        'threshold':float(threshold),'cells':len(y),'positives':int(y.sum())}

def tree_export(model):
    trees=[]
    for step in model._predictors:
        tree=[]
        for n in step[0].nodes:
            tree.append([float(n['value']),int(n['feature_idx']),float(n['num_threshold']),int(n['missing_go_to_left']),int(n['left']),int(n['right']),int(n['is_leaf'])])
        trees.append(tree)
    return {'base':float(model._baseline_prediction[0,0]),'trees':trees}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--data',type=Path,required=True);parser.add_argument('--out',type=Path,required=True);parser.add_argument('--allow-incomplete',action='store_true')
    args=parser.parse_args();args.out.mkdir(parents=True,exist_ok=True)
    app=Path(__file__).resolve().parents[2]; manifest=json.loads((args.data/'ready-events.json').read_text())
    if not manifest['complete'] and not args.allow_incomplete: raise SystemExit('Extraction incomplete; no final training performed')
    boundaries=json.loads((app/'public/data/us-states.json').read_text())
    prepared=[prepare(e,boundaries) for e in manifest['events']]
    skipped=[p for p in prepared if 'skipped'in p]; prepared=[p for p in prepared if 'skipped'not in p]
    groups={name:[p for p in prepared if p['split']==name] for name in ['train','validation','test']}
    # Remove nearby training events using coordinates only; no target labels are inspected.
    embargo=[]
    for train in list(groups['train']):
        a,b=train['center']
        if any(np.hypot((a-p['center'][0])*111.2,(b-p['center'][1])*111.2*np.cos(np.radians(a)))<25 for p in groups['validation']+groups['test']):
            groups['train'].remove(train);embargo.append(train['event'])
    print('Eligible events', {k:len(v) for k,v in groups.items()},'skipped',len(skipped),'embargo',len(embargo),flush=True)
    arrays={}
    for k,events in groups.items():
        x=np.concatenate([p['x'] for p in events]); y=np.concatenate([p['y'] for p in events])
        w=np.concatenate([np.full(len(p['y']),1/len(p['y'])) for p in events]);w*=len(w)/w.sum()
        arrays[k]=(x,y,w)
    xt,yt,wt=arrays['train'];xv,yv,wv=arrays['validation'];xx,yx,wx=arrays['test']
    # Fixed candidates, selected on validation Brier. Test labels never select a model.
    candidates=[]
    for leaves in [7,15,31]:
        model=HistGradientBoostingClassifier(max_iter=120,max_leaf_nodes=leaves,learning_rate=.06,min_samples_leaf=40,l2_regularization=5,early_stopping=False,random_state=42)
        model.fit(xt,yt,sample_weight=wt);p=model.predict_proba(xv)[:,1];score=brier_score_loss(yv,p,sample_weight=wv)
        candidates.append((score,leaves,model));print('Candidate',leaves,score,flush=True)
    _,leaves,model=min(candidates,key=lambda x:x[0]); rawv=model.predict_proba(xv)[:,1]
    # Calibration is a separate, reported validation fit; no claim of unbiased validation metrics.
    calibrator=LogisticRegression(C=1,random_state=42)
    logit=lambda p:np.log(np.clip(p,1e-6,1-1e-6)/(1-np.clip(p,1e-6,1-1e-6)))
    calibrator.fit(logit(rawv)[:,None],yv,sample_weight=wv)
    predict=lambda x:calibrator.predict_proba(logit(model.predict_proba(x)[:,1])[:,None])[:,1]
    pv=predict(xv); pt=predict(xx)
    thresholds=np.linspace(.05,.95,37)
    threshold=max(thresholds,key=lambda t: 2*np.sum(wv*yv*(pv>=t))/max(1e-9,np.sum(wv*yv)+np.sum(wv*(pv>=t))))
    baseline_rates=[float(np.average(yt[xt[:,0]==v],weights=wt[xt[:,0]==v])) if np.any(xt[:,0]==v) else float(np.average(yt,weights=wt)) for v in [0,1]]
    logistic=make_pipeline(SimpleImputer(add_indicator=True),StandardScaler(),LogisticRegression(max_iter=600,C=.1,random_state=42))
    logistic.fit(xt,yt,logisticregression__sample_weight=wt)
    baseline=np.array(baseline_rates)[xx[:,0].astype(int)]
    result={'model':metrics(yx,pt,wx,threshold),'smoothedPersistence':metrics(yx,baseline,wx,threshold),'persistence':metrics(yx,xx[:,0],wx,.5),'logistic':metrics(yx,logistic.predict_proba(xx)[:,1],wx,threshold)}
    new=xx[:,0]==0; result['newActivity']=metrics(yx[new],pt[new],wx[new],threshold)
    # Cluster bootstrap: resample entire test fires, preserving spatial dependence.
    rng=np.random.default_rng(542);counts=[len(p['y']) for p in groups['test']];starts=np.cumsum([0]+counts);boot=[]
    for _ in range(400):
        indexes=np.concatenate([np.arange(starts[i],starts[i+1]) for i in rng.integers(0,len(counts),len(counts))])
        if yx[indexes].sum():boot.append([average_precision_score(yx[indexes],pt[indexes],sample_weight=wx[indexes]),brier_score_loss(yx[indexes],pt[indexes],sample_weight=wx[indexes])])
    ci=np.quantile(boot,[.025,.975],axis=0).T.tolist()
    reliability=[]
    for lo in np.arange(0,1,.1):
        at=(pt>=lo)&(pt<lo+.1+1e-9)
        if at.any():reliability.append({'low':float(lo),'meanPredicted':float(np.average(pt[at],weights=wx[at])),'observedRate':float(np.average(yx[at],weights=wx[at])),'cells':int(at.sum())})
    model_data=tree_export(model)|{'schemaVersion':1,'id':'ember-day-ahead-v1','features':FEATURES,'calibration':{'slope':float(calibrator.coef_[0,0]),'intercept':float(calibrator.intercept_[0])},'threshold':float(threshold),'baselineRates':baseline_rates}
    model_json=json.dumps(model_data,separators=(',',':'),allow_nan=False);(args.out/'model.json').write_text(model_json)
    # Joint permutation by scientific family; descriptive held-out sensitivity, never causal.
    importance=[]
    for name,indices in [('Recent fire pattern',list(range(8))),('Terrain',list(range(8,13))),('Antecedent weather',list(range(13,20))),('Fuel dryness / drought',[20,21]),('Issued GFS conditions',[22,23,24])]:
        shuffled=xx.copy();order=rng.permutation(len(xx));shuffled[:,indices]=xx[order][:,indices]
        importance.append({'group':name,'brierIncrease':float(brier_score_loss(yx,predict(shuffled),sample_weight=wx)-result['model']['brier'])})
    report={'schemaVersion':1,'modelId':model_data['id'],'modelSha256':hashlib.sha256(model_json.encode()).hexdigest(),'modelType':'Histogram gradient-boosted trees + validation Platt calibration','selectedLeaves':leaves,'trees':120,'featureNames':FEATURES,
        'source':{'title':'WildfireSpreadTS v1.0','url':'https://zenodo.org/records/8006177','license':'CC-BY-4.0','selectedEvents':len(manifest['events']),'downloadManifestSha256':hashlib.sha256((args.data/'manifest.json').read_bytes()).hexdigest()},
        'target':'At least one retained S-NPP VIIRS active-fire detection in a 1.5 km cell during the next UTC day, within 12 km of prior detections.',
        'timing':{'issue':'I, after the I00Z GFS run is available; live path requires at least06Z','target':'I+1 00:00–24:00 UTC','recentFire':'I−1 UTC day','priorFire':'I−2 UTC day','gridmet':'I−2 nominal day (ends07Z I−1)','gfs':'I00Z, F01–F24, antecedent forecast conditions'},
        'splits':{k:{'years':{'train':[2018,2019],'validation':[2020],'test':[2021]}[k],'events':len(v),'cells':len(arrays[k][1]),'positives':int(arrays[k][1].sum()),'ids':[p['event'] for p in v]} for k,v in groups.items()},
        'weighting':'Every event has equal total weight; all eligible cells retained, no negative downsampling. Validation both selects tree complexity and fits calibration/threshold; only test is held out.',
        'spatialEmbargoKm':25,'embargoedTrainEvents':embargo,'skippedEvents':skipped,'test':result,'confidenceIntervals':{'method':'400 bootstrap resamples of whole test fires, 95% percentile intervals','prAuc':ci[0],'brier':ci[1]},'reliability':reliability,'permutationSensitivity':importance,
        'limitations':['Small 60-event sample, only one target day per event; not nationwide validation.','Label absence means no retained satellite detection, not known absence of burning; cloud validity is unavailable.','Historical finalized gridMET and retrospectively compiled fire masks do not prove operational data availability or calibration.','Live terrain product, GFS provider/lead aggregation, publication latency and changing satellite operations introduce transfer error.','Fuel structure, live/dead fuel moisture, suppression, spotting, human and lightning ignition processes are not modeled completely.','Not an official warning, perimeter, flame arrival time, crew allocation, or evacuation product.'],
        'excludedBands':{'17':'Inconsistent GFS rain accumulation reductions','19':'Wind-direction quadrant loss','0–4':'Optical/composite availability and missingness','12–13':'Terrain gradients recomputed at1.5km','16':'Same-year annual cover risks hindsight'},
        'events':[{k:p[k] for k in ['event','split','dates','center','sourceHashes']} for p in prepared]}
    report['limitations'].insert(1,f'Only {int(yv.sum())} positive cells across {len(groups["validation"])} validation fires supported both model selection and calibration/threshold fitting. Those choices are especially unstable; inspect independent-test baseline comparisons.')
    (args.out/'evaluation.json').write_text(json.dumps(report,indent=2,allow_nan=False))
    # Every untouched test event is browseable; default order is event ID, not model success.
    offset=0;replays=[]
    for event in groups['test']:
        n=len(event['y']);prob=pt[offset:offset+n];offset+=n
        corners=Transformer.from_crs(event['epsg'],4326,always_xy=True)
        cells=[]
        for i in range(n):
            r,c=int(event['row'][i]),int(event['col'][i]);ox,oy=event['origin'];xy=[(ox+c*1500,oy-r*1500),(ox+(c+1)*1500,oy-r*1500),(ox+(c+1)*1500,oy-(r+1)*1500),(ox+c*1500,oy-(r+1)*1500)]
            coords=[list(corners.transform(*p)) for p in xy];coords.append(coords[0]);cells.append({'id':f'{r}-{c}','polygon':coords,'p':round(float(prob[i]),5),'observed':int(event['y'][i]),'previous':int(event['recent'][i])})
        replays.append({'id':event['event'],'issueDate':event['dates'][2],'targetDate':event['dates'][3],'recentFireDate':event['dates'][1],'center':event['center'],'cells':cells})
    (args.out/'replays.json').write_text(json.dumps(replays,separators=(',',':')))
    chosen=np.arange(len(xx))
    parity={'vectors':np.where(np.isfinite(xx[chosen]),xx[chosen],None).tolist(),'probabilities':pt[chosen].tolist()}
    (args.out/'parity.json').write_text(json.dumps(parity,separators=(',',':')))
    np.savez_compressed(args.out/'heldout-predictions.npz',x=xx,y=yx,p=pt,weights=wx)
    print(json.dumps({'test':result,'confidenceIntervals':report['confidenceIntervals'],'output':str(args.out)},indent=2),flush=True)

if __name__=='__main__':main()
