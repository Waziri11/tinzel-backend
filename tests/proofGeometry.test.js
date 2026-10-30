import test from 'node:test';
import assert from 'node:assert/strict';
import {imageRegions} from '../src/services/proofGeometry.js';
test('image geometry clips to page coordinates, preserves rotated quads and deduplicates placements',()=>{
 const input=new Float32Array([.1,.2,.1,.5,.6,.2,.1,.2,.1,.5,.6,.2,.2,.2,.1,.5,.5,.3,-.1,-.1,-.1,.4,.4,-.1]);
 const found=imageRegions(input);assert.equal(found.length,3);assert.deepEqual(imageRegions(input),found);assert.notEqual(found[0].id,found[1].id);assert.notEqual(found[1].quad[0].x,found[1].quad[3].x);
 for(const r of found)for(const p of r.quad)assert.ok(p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1);
 assert.deepEqual(imageRegions(null),[]);assert.deepEqual(imageRegions([NaN,0,0,1,1,0]),[]);
});
