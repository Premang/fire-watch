// Pure logic for the non-public NOAA-20 trial ("shadow") run. Frozen by ml-n20/shadow/protocol.json.
// Nothing here reads labels when choosing what to forecast.
import {toUtm} from '../../lib/fire-predictor';
import {pointCell} from '../../lib/fire-outlook';
import type {FireOutlook} from '../../lib/fire-outlook-types';

export const NOAA20_FEED='https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_USA_contiguous_and_Hawaii_7d.csv';
export const NOAA20_OUTAGES='https://modaps.modaps.eosdis.nasa.gov/services/production/outages_noaa_20.html';
export const COHORT={binDeg:.25,minDetections:2,minSeparationKm:30,maxWindows:12} as const;
export const NEW_CELL_ALERT={threshold:.07,maxFraction:.05,consecutiveDays:3} as const; // v2 new-cell threshold from ml-n20 selection
const PLATFORMS=new Set(['N20','1']),KEEP=new Set(['n','nominal','h','high']),DROP=new Set(['l','low']);

export type Detection={lat:number;lon:number;date:string};
export function validDay(d:unknown):d is string{return typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(`${d}T00:00:00Z`))&&new Date(`${d}T00:00:00Z`).toISOString().slice(0,10)===d;}
export const FEATURE_COUNT=25;
/** Parse the FIRMS NOAA-20 CSV with the live contract: wrong platform or unknown confidence throws. */
export function parseNoaa20(csv:string):{kept:Detection[];days:Record<string,number>}{
  const lines=csv.trim().split(/\r?\n/),h=lines[0].split(','),ix=(k:string)=>{const i=h.indexOf(k);if(i<0)throw new Error(`NOAA-20 feed lacks ${k}`);return i;};
  const [la,lo,d,s,c]=[ix('latitude'),ix('longitude'),ix('acq_date'),ix('satellite'),ix('confidence')];
  const kept:Detection[]=[],days:Record<string,number>={};
  for(const line of lines.slice(1)){if(!line.trim())continue;const v=line.split(',');
    if(!PLATFORMS.has(v[s]?.trim()))throw new Error(`Unexpected platform ${v[s]}`);
    const conf=v[c]?.trim().toLowerCase();if(!KEEP.has(conf)&&!DROP.has(conf))throw new Error(`Unsupported confidence ${conf}`);
    const date=v[d];if(!validDay(date))continue;
    const latText=v[la]?.trim()??'',lonText=v[lo]?.trim()??'',lat=Number(latText),lon=Number(lonText);
    // Blank coordinates must not become 0; out-of-range rows are not observations.
    if(!latText||!lonText||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)continue;
    days[date]=(days[date]??0)+1;if(DROP.has(conf))continue;
    kept.push({lat,lon,date});
  }
  return {kept,days};
}
const km=(a:{lat:number;lon:number},b:{lat:number;lon:number})=>Math.hypot((a.lat-b.lat)*111.2,(a.lon-b.lon)*111.2*Math.cos((a.lat+b.lat)*Math.PI/360));

/** Predeclared cohort: yesterday's (I-1) kept detections in CONUS, binned at 0.25 deg; bins with
 * >= minDetections, densest first (ties: south then west), centre = mean detection position,
 * greedily kept when >= minSeparationKm from every kept centre, at most maxWindows. */
export function selectCohort(detections:Detection[],recentDate:string,inConus:(lon:number,lat:number)=>boolean){
  const bins=new Map<string,Detection[]>();
  for(const p of detections){if(p.date!==recentDate||!inConus(p.lon,p.lat))continue;const k=`${Math.floor(p.lat/COHORT.binDeg)}/${Math.floor(p.lon/COHORT.binDeg)}`;(bins.get(k)??bins.set(k,[]).get(k)!).push(p);}
  const cand=[...bins.values()].filter(b=>b.length>=COHORT.minDetections).map(b=>({lat:b.reduce((s,p)=>s+p.lat,0)/b.length,lon:b.reduce((s,p)=>s+p.lon,0)/b.length,detections:b.length}))
    .sort((a,b)=>b.detections-a.detections||a.lat-b.lat||a.lon-b.lon);
  const picked:typeof cand=[];
  for(const c of cand){if(picked.length>=COHORT.maxWindows)break;if(picked.every(p=>km(p,c)>=COHORT.minSeparationKm))picked.push(c);}
  return picked.map(c=>({lat:+c.lat.toFixed(5),lon:+c.lon.toFixed(5),detections:c.detections}));
}

/** Label a scored window: a cell is positive if >= 1 kept NOAA-20 detection centre on the target UTC day
 * falls in it (same point-centre rule as the forecast masks). Unknown if the feed has no target-day rows. */
export const LABELS={matureAfterDays:2,expireAfterDays:6} as const;
/** Label state for a target day given the labeling day: 'pending' before maturity, 'retry' when the feed
 * lacks the target day before expiry, 'expired' after. Feed presence is not proof of complete coverage. */
export function labelState(targetDate:string,today:string,feedHasTarget:boolean):'pending'|'ready'|'retry'|'expired'{
  const age=(Date.parse(`${today}T00:00:00Z`)-Date.parse(`${targetDate}T00:00:00Z`))/86400000;
  if(age<LABELS.matureAfterDays)return 'pending';
  if(feedHasTarget)return age>LABELS.expireAfterDays?'expired':'ready';
  return age>=LABELS.expireAfterDays?'expired':'retry';
}
export function labelWindow(feed:{kept:Detection[];days:Record<string,number>},out:Pick<FireOutlook,'targetDate'|'grid'|'cellFeatures'>){
  if(!out.grid||!out.cellFeatures)throw new Error('Run was not archived with grid/features');
  if(!feed.days[out.targetDate])return {status:'unlabelable' as const,labels:{} as Record<string,0|1>};
  const {zone,left,top}=out.grid,hits=new Set<string>();
  for(const p of feed.kept){if(p.date!==out.targetDate)continue;const v=toUtm(p.lat,p.lon,zone),[r,c]=pointCell(v.x,v.y,left,top);hits.add(`${r}-${c}`);}
  const labels:Record<string,0|1>={};for(const id of Object.keys(out.cellFeatures))labels[id]=hits.has(id)?1:0;
  return {status:'labeled' as const,labels};
}

/** Contract invariants for every archived run; any violation pauses the trial. */
export function invariants(out:FireOutlook,issueDate:string,modelId:string,fetched:string[]):string[]{
  const v:string[]=[];
  if(!validDay(out.issueDate)||!validDay(out.targetDate))v.push('invalid issue/target date');
  // Contract failures inside the outlook must not pass as ordinary abstentions.
  if(out.reasons.some(r=>/Unexpected platform|Unsupported NOAA-20 confidence|Unexpected NOAA-20 schema/.test(r)))v.push('feed contract failure');
  if(out.issueDate!==issueDate)v.push('issue date mismatch');
  if(Date.parse(out.targetDate)-Date.parse(out.issueDate)!==86400000)v.push('target is not issue+1');
  if(out.modelId!==modelId)v.push('model id mismatch');
  if(fetched.some(u=>/suomi|SUOMI|outages_suomi_npp/.test(u)))v.push('S-NPP source fetched');
  const inDomain=!out.reasons.some(r=>r.includes('contiguous United States only'));
  if(out.fireSource?(out.fireSource.url!==NOAA20_FEED||out.fireSource.sensor!=='VIIRS NOAA-20'):inDomain&&!out.reasons.some(r=>r.startsWith('Satellite history:')))v.push('fire source provenance missing or not the NOAA-20 feed');
  if(out.satelliteHealth?out.satelliteHealth.sourceUrl!==NOAA20_OUTAGES:inDomain&&!out.reasons.some(r=>r.includes('source health could not be checked')))v.push('health provenance missing or not the NOAA-20 catalogue');
  if(inDomain&&(!out.grid||!out.cellFeatures))v.push('grid/features not archived');
  if(out.status==='experimental'){
    if(out.reasons.length)v.push('experimental output carries abstention reasons');
    if(!out.cells.length)v.push('experimental output without cells');
    for(const c of out.cells){const f=out.cellFeatures?.[c.id]?.features;if(!f||f.length!==FEATURE_COUNT||f.some(x=>typeof x!=='number'||!Number.isFinite(x))||!(c.p>=0&&c.p<=1)||(c.previous!==0&&c.previous!==1)){v.push(`cell ${c.id} has incomplete features or invalid score`);break;}}
  }else if(out.cells.length)v.push('abstained output carries cells');
  return v;
}

/** Fraction of previously unoccupied scored cells alerted at the frozen new-cell threshold. */
export function newCellAlertFraction(outs:FireOutlook[]):number|null{
  let n=0,a=0;for(const o of outs)if(o.status==='experimental')for(const c of o.cells)if(c.previous===0){n++;if(c.p>=NEW_CELL_ALERT.threshold)a++;}
  return n?a/n:null;
}

export const GRIDMET_DAILY=['pr','tmmn','tmmx','sph','vs','th','erc'] as const;
/** 'unretrieved' (a request failed: not evidence of publication lag), 'stale' (all retrieved, some older
 * than the required lagged day: publication lag) or 'ready'. */
export function gridmetReadiness(o:Pick<FireOutlook,'inputs'|'weatherDate'>):'ready'|'stale'|'unretrieved'{
  const grids=o.inputs?.gridmet?.grids;if(!grids||GRIDMET_DAILY.some(c=>!grids[c]))return 'unretrieved';
  return GRIDMET_DAILY.every(c=>grids[c]!.date===o.weatherDate)?'ready':'stale';
}
/** Every run of consecutive counted eligible days whose new-cell alert fraction exceeds the threshold for
 * the required length (all historical runs, so a crash between archiving and flagging cannot hide one). */
export function reviewTriggers(days:{date:string;fraction:number}[]):string[][]{
  const out:string[][]=[],k=NEW_CELL_ALERT.consecutiveDays;
  for(let i=0;i+k<=days.length;i++){const w=days.slice(i,i+k);if(w.every(d=>d.fraction>NEW_CELL_ALERT.maxFraction))out.push(w.map(d=>d.date));}
  return out;
}

/** Halt reasons implied by archived records (counted runs and deferred attempts). Rebuilt on every
 * invocation so a crash between publishing a violation-bearing record and persisting the halt cannot
 * let counted collection resume. */
export function haltsFromRecords(records:{name:string;violations?:unknown}[]):string[]{
  return records.filter(r=>Array.isArray(r.violations)&&r.violations.length).map(r=>`contract invariant violations in ${r.name}: ${(r.violations as string[]).slice(0,3).join('; ')}`);
}
