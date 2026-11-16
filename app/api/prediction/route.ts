import {createFireOutlook} from '@/lib/fire-outlook';
import {createFireOutlook as createWithOlderDrought} from '@/lib/fire-outlook-website';
import type {FireOutlook} from '@/lib/fire-outlook-types';
import {parsePredictionLocation} from '@/lib/prediction-inputs';
const cache=new Map<string,{at:number;data:FireOutlook}>();
const pending=new Map<string,Promise<FireOutlook>>();
export async function GET(request:Request){
 const point=parsePredictionLocation(new URL(request.url).searchParams);if(!point)return Response.json({error:'Provide valid U.S. latitude and longitude.'},{status:400});
 const now=new Date(),key=`${now.toISOString().slice(0,10)}/${now.getUTCHours()<6?'pre06':'post06'}/${point.lat.toFixed(4)},${point.lon.toFixed(4)}`,previous=cache.get(key);
 if(previous&&Date.now()-previous.at<10*60000)return Response.json(previous.data,{headers:{'Cache-Control':'private,max-age=60'}});
 try{let task=pending.get(key);if(!task){if(pending.size>=4)return Response.json({error:'Several outlooks are being calculated. Try again shortly.'},{status:429});task=outlookForWebsite(point.lat,point.lon);pending.set(key,task);}
   const data=await task;if(cache.size>=12)cache.delete(cache.keys().next().value!);cache.set(key,{at:Date.now(),data});return Response.json(data,{headers:{'Cache-Control':'private,max-age=60'}});
 }catch(error){return Response.json({error:error instanceof Error?error.message:'Outlook unavailable.'},{status:503});}
 finally{pending.delete(key);}
}

const PDSI_REASON='gridMET pdsi does not cover the required lagged date.';
/** Website only: when the strict (trial) outlook abstains solely because the drought index is more than five days old,
 *  rerun with the generated copy that accepts up to 15 days, and say so. The trial never uses this route. */
const NOT_YET=[/GFS run is not eligible until/,/current-day00Z GFS run is unavailable/,/^gridMET \w+ does not cover the required lagged date\.$/,/GFS F01–F24 has incomplete/];
/** Website only: early in the UTC day, today's weather run and dryness grids are not published yet, so the strict outlook
 *  abstains. Serve the outlook as issued late yesterday (target day = today, UTC) instead, clearly labelled. */
async function outlookForWebsite(lat:number,lon:number):Promise<FireOutlook>{
 const today=await outlookForDay(lat,lon);
 if(today.status!=='abstained'||!today.reasons.length||!today.reasons.every(r=>NOT_YET.some(p=>p.test(r))))return today;
 const now=Date.now(),midnight=Date.UTC(new Date(now).getUTCFullYear(),new Date(now).getUTCMonth(),new Date(now).getUTCDate());
 const earliest=new Date(Math.max(now,midnight+6*3600000)).toISOString();
 try{
   const earlier=await outlookForDay(lat,lon,midnight-3600000);
   if(earlier.status==='abstained')return {...today,catchUp:{used:false,earliestNextUpdate:earliest}} as FireOutlook;
   // Official alerts must be current, not as of yesterday.
   const inputs=earlier.inputs&&today.inputs?{...earlier.inputs,officialAlerts:today.inputs.officialAlerts}:earlier.inputs;
   return {...earlier,inputs,fetchedAt:today.fetchedAt,warnings:[`Catch-up outlook: today's weather data are not published yet, so this was built from the ${earlier.issueDate} inputs for target day ${earlier.targetDate} (UTC). This fallback path has not been evaluated separately.`,...earlier.warnings],catchUp:{used:true,earliestNextUpdate:earliest}} as FireOutlook;
 }catch{return {...today,catchUp:{used:false,earliestNextUpdate:earliest}} as FireOutlook;}
}
async function outlookForDay(lat:number,lon:number,asOf?:number):Promise<FireOutlook>{
 const options=asOf===undefined?{}:{now:asOf};
 const strict=await createFireOutlook(lat,lon,options);
 if(strict.status!=='abstained'||strict.reasons.length!==1||strict.reasons[0]!==PDSI_REASON)return strict;
 const relaxed=await createWithOlderDrought(lat,lon,options),pdsi=relaxed.inputs?.gridmet.grids.pdsi;
 if(!pdsi)return strict;
 const ageDays=Math.round((Date.parse(relaxed.weatherDate)-Date.parse(pdsi.date))/86400000);
 return {...relaxed,warnings:[`Website-only relaxation: the drought index (PDSI) is dated ${pdsi.date}, ${ageDays} days before the weather day; the evaluated rule allows five. Scores with older drought data have not been evaluated.`,...relaxed.warnings],olderDrought:{pdsiDate:pdsi.date,ageDays}} as FireOutlook;
}
