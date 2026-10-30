import {createHash} from 'node:crypto';
export const GEOMETRY_VERSION=2;
const clamp=n=>Math.max(0,Math.min(1,n));
export function imageRegions(coordinates=[]){
  coordinates ||= [];
  const result=[],seen=new Set();
  for(let i=0;i+5<coordinates.length;i+=6){
    const [x0,y0,x1,y1,x2,y2]=Array.from(coordinates.slice(i,i+6));
    if(![x0,y0,x1,y1,x2,y2].every(Number.isFinite))continue;
    const quad=[[x0,y0],[x2,y2],[x1+x2-x0,y1+y2-y0],[x1,y1]].map(([x,y])=>({x:clamp(x),y:clamp(y)}));
    const xs=quad.map(p=>p.x),ys=quad.map(p=>p.y),x=Math.min(...xs),y=Math.min(...ys),width=Math.max(...xs)-x,height=Math.max(...ys)-y;
    if(width<.0001||height<.0001)continue;
    const key=JSON.stringify(quad.map(p=>[+p.x.toFixed(5),+p.y.toFixed(5)]));if(seen.has(key))continue;seen.add(key);
    result.push({id:createHash('sha256').update(key).digest('hex').slice(0,24),quad,rect:{x,y,width,height},pageImage:width*height>.9});
  }
  return result;
}
export function pageGeometry(page){return {geometryVersion:page.geometryVersion||0,width:page.width,height:page.height,text:page.text||[],imageRegions:page.imageRegions||[]};}
