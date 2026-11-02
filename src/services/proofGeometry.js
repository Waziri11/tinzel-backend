import { mergeProofText } from './proofOcrService.js';
import {createHash} from 'node:crypto';
export const GEOMETRY_VERSION=3;
function clipToPage(points) {
  let polygon = points;
  for (const [axis, boundary, sign] of [['x', 0, 1], ['x', 1, -1], ['y', 0, 1], ['y', 1, -1]]) {
    const input = polygon; polygon = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i], b = input[(i + 1) % input.length];
      const insideA = (a[axis] - boundary) * sign >= 0, insideB = (b[axis] - boundary) * sign >= 0;
      if (insideA) polygon.push(a);
      if (insideA !== insideB) {
        const t = (boundary - a[axis]) / (b[axis] - a[axis]);
        polygon.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
      }
    }
  }
  return polygon.map(p => ({ x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) }));
}
export function imageRegions(coordinates=[]){
  coordinates ||= [];
  const result=[],seen=new Set();
  for(let i=0;i+5<coordinates.length;i+=6){
    const [x0,y0,x1,y1,x2,y2]=Array.from(coordinates.slice(i,i+6));
    if(![x0,y0,x1,y1,x2,y2].every(Number.isFinite))continue;
    const quad=clipToPage([[x0,y0],[x2,y2],[x1+x2-x0,y1+y2-y0],[x1,y1]].map(([x,y])=>({x,y})));
    if(quad.length<3)continue;
    const xs=quad.map(p=>p.x),ys=quad.map(p=>p.y),x=Math.min(...xs),y=Math.min(...ys),width=Math.max(...xs)-x,height=Math.max(...ys)-y;
    if(width<.0001||height<.0001)continue;
    const key=JSON.stringify(quad.map(p=>[+p.x.toFixed(5),+p.y.toFixed(5)]));if(seen.has(key))continue;seen.add(key);
    result.push({id:createHash('sha256').update(key).digest('hex').slice(0,24),quad,rect:{x,y,width,height},pageImage:Math.abs(quad.reduce((area,p,i)=>{const next=quad[(i+1)%quad.length];return area+p.x*next.y-next.x*p.y;},0))/2>.9});
  }
  return result;
}
export function pageGeometry(page){return {geometryVersion:page.geometryVersion||0,width:page.width,height:page.height,ocrVersion:page.ocrVersion||0,text:mergeProofText(page.text||[],page.ocrText||[],page.width,page.height),imageRegions:page.imageRegions||[]};}
