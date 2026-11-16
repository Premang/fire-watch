"""Build state histories and a replay from cached FIRMS observations."""
import json, csv, math, collections, datetime, pathlib, concurrent.futures
from paths import parse_paths


def initialize(cache_dir, output_dir):
    # Each multiprocessing worker initializes its own spatial index (spawn-safe).
    global BASE, OUT, G, FEATS, CODES, NAMES, TREE, COS30, np, shapely
    import numpy as np
    import shapely
    from shapely.geometry import shape
    from shapely.strtree import STRtree
    BASE, OUT = pathlib.Path(cache_dir), pathlib.Path(output_dir)
    G = json.loads((OUT / "us-states.json").read_text())
    FEATS = G["features"]
    CODES = [feature["properties"]["code"] for feature in FEATS]
    NAMES = {feature["properties"]["code"]: feature["properties"]["name"] for feature in FEATS}
    TREE = STRtree([shape(feature["geometry"]) for feature in FEATS])
    COS30 = math.cos(math.pi / 6)

def process(job):
 s,y=job;path=BASE/'archive'/f'{s}_{y}.csv';sensor='MODIS' if s=='modis' else 'VIIRS';daily=collections.defaultdict(lambda:[0,set()]);replay=[];alln=0;kept=0;dates=[];versions=collections.Counter();platforms=collections.Counter()
 def chunk(rows):
  nonlocal kept
  pts=shapely.points(np.array([[float(r['longitude']),float(r['latitude'])] for r in rows]));pairs=TREE.query(pts,predicate='intersects');matches={int(i):CODES[int(j)] for i,j in zip(*pairs)}
  for i,r in enumerate(rows):
   state=matches.get(i)
   if not state:continue
   kept+=1;lat=float(r['latitude']);lon=float(r['longitude']);date=r['acq_date'];cell=(math.floor(6371*math.radians(lon)*COS30/5),math.floor(6371*math.sin(math.radians(lat))/COS30/5))
   for reg in ['US',state]:
    v=daily[(reg,date)];v[0]+=1;v[1].add(cell)
   if y==2021 and '2021-07-13'<=date<='2021-08-31' and 39.7<=lat<=40.7 and -121.7<=lon<=-120.5:
    hm=r['acq_time'].zfill(4);at=f'{date}T{hm[:2]}:{hm[2:]}:00Z';platform=r['satellite'];platform={'N':'Suomi NPP'}.get(platform,platform)
    replay.append({'id':f'{sensor}-{at}-{lat}-{lon}','lat':lat,'lon':lon,'acquiredAt':at,'sensor':sensor,'platform':platform,'frp':float(r.get('frp') or 0),'confidence':r['confidence'],'daynight':r['daynight']})
 rows=[]
 with path.open() as f:
  for r in csv.DictReader(f):
   alln+=1;dates.append(r['acq_date']) if alln==1 else None
   versions[r['version']]+=1;platforms[r['satellite']]+=1;last=r['acq_date']
   if r.get('type')!='0':continue
   rows.append(r)
   if len(rows)>=25000:chunk(rows);rows=[]
 if rows:chunk(rows)
 result={'sensor':sensor,'year':y,'source':f'https://firms.modaps.eosdis.nasa.gov/data/country/{s}/{y}/{s}_{y}_United_States.csv','totalSourceRows':alln,'vegetationRowsInStates':kept,'firstSourceDetectionDate':dates[0] if dates else None,'lastSourceDetectionDate':last if alln else None,'versions':dict(versions),'platforms':dict(platforms),'daily':[[reg,date,v[0],len(v[1])] for (reg,date),v in daily.items()],'replay':replay}
 (BASE/f'aggregate-{s}-{y}.json').write_text(json.dumps(result,separators=(',',':')));print(f'AGG {sensor} {y} {alln} -> {kept}',flush=True);return str(BASE/f'aggregate-{s}-{y}.json')
def main():
 args = parse_paths("Aggregate cached MODIS/VIIRS observations into 5 km cell-day histories.")
 initialize(args.cache_dir, args.output_dir)
 (OUT / 'history').mkdir(parents=True, exist_ok=True)
 manifest=json.loads((BASE/'archive-manifest.json').read_text());jobs=[(r['sensor'],r['year']) for r in manifest if r['ok']]
 with concurrent.futures.ProcessPoolExecutor(max_workers=4, initializer=initialize, initargs=(str(BASE), str(OUT))) as ex: files=list(ex.map(process,jobs))
 regs={r:{} for r in ['US']+CODES};sources=[];replay=[];available={'MODIS':set(),'VIIRS':set()}
 for file in files:
  a=json.loads(pathlib.Path(file).read_text());sensor=a['sensor'];available[sensor].add(a['year']);replay+=a.pop('replay')
  for reg,date,raw,cell in a.pop('daily'):
   row=regs[reg].setdefault(date,{});row[sensor.lower()]=cell;row[sensor.lower()+'Raw']=raw
  sources.append(a)
 dates=[];date=datetime.date(2001,1,1)
 while date<=datetime.date(2025,12,31):dates.append(date.isoformat());date+=datetime.timedelta(days=1)
 meta={'title':'United States active burning observation archive','retrievedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'availableThrough':'2025-12-31','dataKind':'observed satellite active-fire detections','measurement':'Daily unique 5 km equal-area grid cells containing a vegetation-fire detection, separately for each sensor. Monthly values sum daily occupied cells (cell-days), not area burned.','grid':{'name':'Spherical cylindrical equal-area, standard parallel 30 degrees','radiusKm':6371,'cellKm':5,'formula':'x=6371*lonRadians*cos(30deg); y=6371*sin(latRadians)/cos(30deg); cell=floor(x/5),floor(y/5)'},'filter':'FIRMS archived science data, type=0 (presumed vegetation fire); all confidence classes retained; within 2025 Census state/DC boundaries. MODIS Terra/Aqua deduplicated together per cell/day. VIIRS uses only Suomi NPP to avoid constellation-size changes.','caveats':['Raw MODIS and VIIRS counts remain sensor-dependent and are not scientifically calibrated by this dataset.','Zero means no retained detections in the supplied archive, not proof of no burning or complete clear-sky observation.','Clouds, swath geometry, confidence, revisit frequency and instrument outages affect detection.','Hotspots include wildfire and agricultural or prescribed burns; satellite type=0 does not separate them.','VIIRS Suomi NPP begins 2012-01-20; prior days are null.','MODIS Terra-only in 2001; Aqua joins during 2002.','First and last source detection dates describe detections, not independently verified observation coverage.'],'sources':sources,'boundarySource':G.get('source'),'modisYears':sorted(available['MODIS']),'viirsYears':sorted(available['VIIRS'])}
 index={'meta':meta,'regions':[]};outregs={}
 for reg,seen in regs.items():
  daily=[];monthly={}
  for d in dates:
   year=int(d[:4]);row={'date':d}
   for sensor in ['MODIS','VIIRS']:
    k=sensor.lower();ok=year in available[sensor] and not(sensor=='VIIRS' and d<'2012-01-20');row[k]=seen.get(d,{}).get(k,0) if ok else None;row[k+'Raw']=seen.get(d,{}).get(k+'Raw',0) if ok else None
   daily.append(row);m=monthly.setdefault(d[:7],{'date':d[:7],'modis':None,'viirs':None,'modisRaw':None,'viirsRaw':None})
   for k in ['modis','viirs','modisRaw','viirsRaw']:
    if row[k] is not None:m[k]=(m[k] or 0)+row[k]
  region={'code':reg,'name':'United States' if reg=='US' else NAMES[reg],'years':list(range(2001,2026)),'monthly':list(monthly.values()),'daily':daily}
  (OUT/'history'/f'{reg}.json').write_text(json.dumps(region,separators=(',',':')))
  index['regions'].append({'code':reg,'name':region['name'],'path':f'/data/history/{reg}.json'})
  if reg in ['US','CA']:outregs[reg]=region
 (OUT/'history.json').write_text(json.dumps({'meta':meta,'regions':outregs},separators=(',',':')))
 (OUT/'history-index.json').write_text(json.dumps(index,separators=(',',':')))
 replay.sort(key=lambda x:x['acquiredAt'])
 rmeta={'title':'Dixie Fire region · July–August 2021','start':'2021-07-13T00:00:00Z','end':'2021-08-31T23:59:59Z','bounds':[-121.7,39.7,-120.5,40.7],'note':'Actual archived vegetation-fire detections in a bounding box around the Dixie Fire region; detections have not been individually attributed to the incident. Points are thermal detections, not fire perimeters.','provenance':[s for s in sources if s['year']==2021]}
 (OUT/'dixie-replay.json').write_text(json.dumps({'meta':rmeta,'points':replay},separators=(',',':')))
 print('DONE',len(sources),'sources',len(regs),'regions',len(replay),'replay points',flush=True)
if __name__=='__main__':main()
