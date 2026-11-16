import { parseFirmsCsv, type FirePoint } from "@/lib/fire-analysis";
import { stateForPoint } from "@/lib/geography";
type LivePoint = FirePoint & {state:string};
type Feed={name:string;url:string;status:string;count:number;lastModified:string|null;error?:string};
let cache:{at:number;data:{points:LivePoint[];feeds:Feed[];fetchedAt:string;latestObservation:string|null}}|null=null;
const origin="https://firms.modaps.eosdis.nasa.gov";
export async function GET(){
 if(cache&&Date.now()-cache.at<300000)return Response.json(cache.data,{headers:{"Cache-Control":"private, max-age=60"}});
 const configs=[{folder:"modis-c6.1",prefix:"MODIS_C6_1",name:"MODIS Terra / Aqua",sensor:"MODIS" as const},{folder:"noaa-20-viirs-c2",prefix:"J1_VIIRS_C2",name:"VIIRS NOAA-20",sensor:"VIIRS" as const},{folder:"noaa-21-viirs-c2",prefix:"J2_VIIRS_C2",name:"VIIRS NOAA-21",sensor:"VIIRS" as const}];
 const results=await Promise.all(configs.flatMap(c=>["USA_contiguous_and_Hawaii","Alaska"].map(async region=>{
  const url=`${origin}/data/active_fire/${c.folder}/csv/${c.prefix}_${region}_24h.csv`;
  try{const res=await fetch(url,{signal:AbortSignal.timeout(18000)});if(!res.ok)throw new Error(`Source returned ${res.status}`);const body=await res.text();if(!body.toLowerCase().includes("latitude")||!body.toLowerCase().includes("longitude"))throw new Error("Unexpected source format");const parsed=parseFirmsCsv(body,c.sensor).map(p=>({...p,platform:c.name,id:`${c.prefix}-${p.id}`}));const points=parsed.map(p=>({...p,state:stateForPoint(p.lon,p.lat)})).filter(p=>p.state!==null) as LivePoint[];return {points,feed:{name:`${c.name} · ${region==="Alaska"?"Alaska":"CONUS + Hawaii"}`,url,status:"available",count:points.length,lastModified:res.headers.get("last-modified")} as Feed};}
  catch(error){return {points:[] as LivePoint[],feed:{name:`${c.name} · ${region}`,url,status:"unavailable",count:0,lastModified:null,error:error instanceof Error?error.message:"Source unavailable"} as Feed};}
 })));
 const feeds=results.map(r=>r.feed);if(feeds.every(f=>f.status!=="available"))return Response.json({error:"NASA FIRMS feeds could not be reached. Please retry shortly.",feeds,fetchedAt:new Date().toISOString()},{status:503});
 const points=results.flatMap(r=>r.points);const latestObservation=points.reduce<string|null>((d,p)=>!d||p.acquiredAt>d?p.acquiredAt:d,null);const data={points,feeds,fetchedAt:new Date().toISOString(),latestObservation};cache={at:Date.now(),data};return Response.json(data,{headers:{"Cache-Control":"private, max-age=60"}});
}
