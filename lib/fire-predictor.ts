export type FittedFireModel = { id:string; features:string[]; base:number; trees:number[][][]; calibration:{slope:number;intercept:number}; threshold:number; mixture?:{treeWeight:number;baselineFeatureIndex:number;baselineRates:[number,number]} };
export type OutlookCell = {id:string;polygon:number[][];p:number;previous:number;observed?:number};
export type OutlookReplay = {id:string;issueDate:string;targetDate:string;recentFireDate:string;center:number[];cells:OutlookCell[]};
const finite=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x);
export function predictFire(model:FittedFireModel, features:(number|null)[]):number {
  if(features.length!==model.features.length)throw new Error('Feature schema mismatch');
  let score=model.base;
  for(const tree of model.trees){let i=0;for(let guard=0;guard<=tree.length;guard++){
    const n=tree[i];if(!n)throw new Error('Invalid fitted tree');
    if(n[6]){score+=n[0];break;}
    const v=features[n[1]];i=!finite(v)?(n[3]?n[4]:n[5]):v<=n[2]?n[4]:n[5];
    if(guard===tree.length)throw new Error('Invalid fitted tree cycle');
  }}
  const raw=Math.max(1e-6,Math.min(1-1e-6,1/(1+Math.exp(-score))));
  const calibrated=1/(1+Math.exp(-(model.calibration.slope*Math.log(raw/(1-raw))+model.calibration.intercept)));
  if(!model.mixture)return calibrated;
  const {treeWeight,baselineFeatureIndex,baselineRates}=model.mixture;
  const previous=features[baselineFeatureIndex];
  if(!finite(treeWeight)||treeWeight<0||treeWeight>1||!Number.isInteger(baselineFeatureIndex)||baselineFeatureIndex<0||baselineFeatureIndex>=features.length||!Array.isArray(baselineRates)||baselineRates.length!==2||baselineRates.some(v=>!finite(v)||v<0||v>1)||(previous!==0&&previous!==1))throw new Error('Invalid fitted persistence mixture');
  return treeWeight*calibrated+(1-treeWeight)*baselineRates[previous];
}

export type WeatherCell={precip:number|null;tmin:number|null;tmax:number|null;q:number|null;wind:number|null;direction:number|null;erc:number|null;pdsi:number|null};
export type AntecedentCell={temperatureC:number|null;q:number|null;vectorWind:number|null};
export function makeFireFeatures(row:number,col:number,size:number,recent:boolean[],prior:boolean[],elevation:(number|null)[],weather:WeatherCell,gfs:AntecedentCell):(number|null)[]{
  const at=row*size+col;
  function nearest(mask:boolean[]){let distance=Infinity,r=0,c=0;for(let j=0;j<mask.length;j++)if(mask[j]){const rr=Math.floor(j/size),cc=j%size,d=(rr-row)**2+(cc-col)**2;if(d<distance){distance=d;r=rr;c=cc;}}return {distance:Math.min(150,Math.sqrt(distance)*1.5),r,c};}
  const near=nearest(recent),old=nearest(prior);
  function density(width:number){let count=0;const radius=(width-1)/2;for(let r=row-radius;r<=row+radius;r++)for(let c=col-radius;c<=col+radius;c++)if(r>=0&&r<size&&c>=0&&c<size&&recent[r*size+c])count++;return count/(width*width);}
  const e=elevation[at],west=elevation[row*size+Math.max(0,col-1)],east=elevation[row*size+Math.min(size-1,col+1)],north=elevation[Math.max(0,row-1)*size+col],south=elevation[Math.min(size-1,row+1)*size+col];
  const dx=finite(west)&&finite(east)?(east-west)/((col===0||col===size-1)?1500:3000):null;
  const dy=finite(north)&&finite(south)?(south-north)/((row===0||row===size-1)?1500:3000):null;
  const aspect=dx===null||dy===null?null:Math.atan2(-dx,dy),nearElev=elevation[near.r*size+near.c];
  const angle=weather.direction===null?null:weather.direction*Math.PI/180;
  return [+recent[at],+prior[at],near.distance,old.distance,density(3),density(7),(col-near.c)*1.5,(near.r-row)*1.5,e,
    dx===null||dy===null?null:Math.atan(Math.hypot(dx,dy))*180/Math.PI,aspect===null?null:Math.sin(aspect),aspect===null?null:Math.cos(aspect),
    finite(e)&&finite(nearElev)?e-nearElev:null,weather.precip,weather.tmin===null?null:weather.tmin-273.15,weather.tmax===null?null:weather.tmax-273.15,weather.q,weather.wind,angle===null?null:Math.sin(angle),angle===null?null:Math.cos(angle),weather.erc,weather.pdsi,gfs.temperatureC,gfs.q,gfs.vectorWind];
}

// WGS84 UTM series, suitable for a small grid within a single CONUS zone.
const A=6378137,E=.0066943799901413165,K=.9996,EP=E/(1-E),RAD=Math.PI/180;
export function toUtm(lat:number,lon:number,zone=Math.floor((lon+180)/6)+1){
 const p=lat*RAD,l=lon*RAD,l0=((zone-1)*6-177)*RAD,n=A/Math.sqrt(1-E*Math.sin(p)**2),t=Math.tan(p)**2,c=EP*Math.cos(p)**2,a=Math.cos(p)*(l-l0);
 const m=A*((1-E/4-3*E**2/64-5*E**3/256)*p-(3*E/8+3*E**2/32+45*E**3/1024)*Math.sin(2*p)+(15*E**2/256+45*E**3/1024)*Math.sin(4*p)-(35*E**3/3072)*Math.sin(6*p));
 return {zone,x:K*n*(a+(1-t+c)*a**3/6+(5-18*t+t*t+72*c-58*EP)*a**5/120)+500000,y:K*(m+n*Math.tan(p)*(a*a/2+(5-t+9*c+4*c*c)*a**4/24+(61-58*t+t*t+600*c-330*EP)*a**6/720))};
}
export function fromUtm(x:number,y:number,zone:number):[number,number]{
 const e1=(1-Math.sqrt(1-E))/(1+Math.sqrt(1-E)),mu=y/K/(A*(1-E/4-3*E**2/64-5*E**3/256));
 const p=mu+(3*e1/2-27*e1**3/32)*Math.sin(2*mu)+(21*e1*e1/16-55*e1**4/32)*Math.sin(4*mu)+(151*e1**3/96)*Math.sin(6*mu)+(1097*e1**4/512)*Math.sin(8*mu);
 const n=A/Math.sqrt(1-E*Math.sin(p)**2),r=A*(1-E)/(1-E*Math.sin(p)**2)**1.5,t=Math.tan(p)**2,c=EP*Math.cos(p)**2,d=(x-500000)/(n*K);
 const lat=p-n*Math.tan(p)/r*(d*d/2-(5+3*t+10*c-4*c*c-9*EP)*d**4/24+(61+90*t+298*c+45*t*t-252*EP-3*c*c)*d**6/720);
 const lon=((zone-1)*6-177)*RAD+(d-(1+2*t+c)*d**3/6+(5-2*c+28*t-3*c*c+8*EP+24*t*t)*d**5/120)/Math.cos(p);
 return [lon/RAD,lat/RAD];
}
/** Grid bearing (radians) of true north at lon/lat in UTM zone `zone`: closed-form
 * transverse-Mercator convergence, -atan(tan(lon-lon0)*sin(lat)). Checked against pyproj
 * across CONUS in tests/fixtures/zone10-axes.json (exact on the sphere; ellipsoid error is tiny). */
export function northOffset(zone:number,lon:number,lat:number):number{const l0=(zone-1)*6-177;return -Math.atan(Math.tan((lon-l0)*RAD)*Math.sin(lat*RAD));}
/** Re-express a local-zone grid (east, north) vector in true-north (geographic) axes, the frame
 * of the wind features and, to within the 0-13 deg zone-10 convergence of the western training
 * events, of the training displacement/aspect features. Zone-10 axes are NOT used: in the East
 * they are rotated up to ~45 deg from true north, a frame no training example had. */
export function toGeographicAxes(east:number,north:number,lon:number,lat:number,zone:number):[number,number]{
 const t=-northOffset(zone,lon,lat),c=Math.cos(t),s=Math.sin(t);return [east*c+north*s,north*c-east*s];
}
/** Geometry contract (ml-n20/geometry/CONTRACT.md) applied to one feature vector in place:
 * displacement (6,7) and downslope aspect (10,11) to true-north axes. Exactly flat cells keep the
 * training placeholder aspect (atan2(-0,0) -> sin 0, cos 1), which has no direction to rotate. */
export function alignFeatureAxes(f:(number|null)[],lon:number,lat:number,zone:number):(number|null)[]{
 const [e,n,sa,ca,slope]=[f[6],f[7],f[10],f[11],f[9]];
 if(finite(e)&&finite(n))[f[6],f[7]]=toGeographicAxes(e,n,lon,lat,zone);
 if(finite(sa)&&finite(ca)&&finite(slope)&&slope!==0)[f[10],f[11]]=toGeographicAxes(sa,ca,lon,lat,zone);
 return f;
}
export function outlookDates(issueDate:string){const at=Date.parse(`${issueDate}T00:00:00Z`);if(!Number.isFinite(at)||new Date(at).toISOString().slice(0,10)!==issueDate)throw new Error('Invalid issue date');const day=(d:number)=>new Date(at+d*86400000).toISOString().slice(0,10);return {issueDate,targetDate:day(1),recentFireDate:day(-1),priorFireDate:day(-2),weatherDate:day(-2)};}
