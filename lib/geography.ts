import boundaries from "@/public/data/us-states.json";
export type Boundary = {type:string;properties:{name:string;code:string;fips:string};geometry:{type:string;coordinates:unknown}};
export const states = (boundaries.features as Boundary[]).sort((a,b)=>a.properties.name.localeCompare(b.properties.name));
type Ring = number[][];
function inRing(lon:number,lat:number,ring:Ring){let inside=false; for(let i=0,j=ring.length-1;i<ring.length;j=i++){const [x,y]=ring[i];const [xj,yj]=ring[j];if(((y>lat)!==(yj>lat))&&(lon<(xj-x)*(lat-y)/(yj-y)+x))inside=!inside;}return inside;}
export function containsPoint(feature:Boundary,lon:number,lat:number){const polygons=feature.geometry.type==="Polygon"?[feature.geometry.coordinates as Ring[]]:feature.geometry.coordinates as Ring[][];return polygons.some(p=>inRing(lon,lat,p[0])&&!p.slice(1).some(h=>inRing(lon,lat,h)));}
export function stateBounds(feature:Boundary){const all=(feature.geometry.coordinates as number[][][][]).flat(feature.geometry.type==="Polygon"?1:2) as unknown as number[][];return {west:Math.min(...all.map(p=>p[0])),south:Math.min(...all.map(p=>p[1])),east:Math.max(...all.map(p=>p[0])),north:Math.max(...all.map(p=>p[1]))};}
const boxes=states.map(feature=>({feature,b:stateBounds(feature)}));
export function stateForPoint(lon:number,lat:number){return boxes.find(({feature,b})=>lon>=b.west&&lon<=b.east&&lat>=b.south&&lat<=b.north&&containsPoint(feature,lon,lat))?.feature.properties.code??null;}
export const conusBounds={west:-125,south:24,east:-66,north:50};
