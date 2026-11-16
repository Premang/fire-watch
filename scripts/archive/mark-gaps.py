"""Mark absent national source dates as unknown and recompute monthly totals."""
import pathlib, json, concurrent.futures, datetime
from paths import parse_paths

def scan(m):
 dates=set()
 with (B / 'archive' / f"{m['sensor']}_{m['year']}.csv").open() as f:
  next(f)
  for line in f: dates.add(line.split(',',6)[5])
 expected=set();d=datetime.date(m['year'],1,1)
 while d.year==m['year']:expected.add(d.isoformat());d+=datetime.timedelta(days=1)
 if m['sensor']=='viirs-snpp' and m['year']==2012:expected={d for d in expected if d>='2012-01-20'}
 return ('MODIS' if m['sensor']=='modis' else 'VIIRS',sorted(expected-dates))

def main():
 global B, O
 args = parse_paths("Mark gaps in cached FIRMS source dates and rebuild monthly availability fields.")
 B, O = args.cache_dir, args.output_dir
 manifest = json.loads((B / 'archive-manifest.json').read_text())
 gaps={'MODIS':[],'VIIRS':[]}
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
  for s,ds in ex.map(scan,[m for m in manifest if m['ok']]):gaps[s]+=ds
 for s in gaps:gaps[s].sort()
 print('SOURCE DAYS ABSENT',gaps,flush=True)
 for file in (O/'history').glob('*.json'):
  reg=json.loads(file.read_text());monthly={}
  for row in reg['daily']:
   for sensor in ['MODIS','VIIRS']:
    k=sensor.lower()
    if row['date'] in gaps[sensor]:row[k]=None;row[k+'Raw']=None
   m=monthly.setdefault(row['date'][:7],{'date':row['date'][:7],'modis':None,'viirs':None,'modisRaw':None,'viirsRaw':None,'modisObservedDays':0,'viirsObservedDays':0,'totalDays':0,'partialSensors':[]});m['totalDays']+=1
   for sensor in ['modis','viirs']:
    if row[sensor] is not None:
     m[sensor+'ObservedDays']+=1
     for k in [sensor,sensor+'Raw']:m[k]=(m[k] or 0)+row[k]
  for m in monthly.values():
   m['partialSensors']=[s.upper() for s in ['modis','viirs'] if 0<m[s+'ObservedDays']<m['totalDays']]
  reg['monthly']=list(monthly.values());file.write_text(json.dumps(reg,separators=(',',':')))
 for filename in ['history.json','history-index.json']:
  x=json.loads((O/filename).read_text());x['meta']['missingObservationDatesBySensor']=gaps;x['meta']['missingObservationDefinition']='No records of any fire type in the entire US source file on these dates. These days are null for every region; observation availability is unknown, and instrument outages cannot be established from this file alone.';x['meta']['caveats'] = list(dict.fromkeys(x['meta']['caveats'] + ['Monthly observedDays means dates with any US archive record for that sensor, not verified clear-sky coverage in the selected region. Exclude partial months from sensor-calibration fits or match available days explicitly.']))
  if filename=='history.json':x['regions']={reg:json.loads((O/'history'/f'{reg}.json').read_text()) for reg in ['US','CA']}
  (O/filename).write_text(json.dumps(x,separators=(',',':')))
 print('PATCHED',flush=True)

if __name__ == '__main__':
 main()
