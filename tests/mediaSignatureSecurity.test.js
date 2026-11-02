import {test} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {getJwtSecret} from '../src/middlewares/auth.middleware.js';
import {signMediaPath,verifySignedMediaRequest} from '../src/services/mediaSignService.js';
const path='/api/public/photos/example';
const request=(headers={},query={},originalUrl=path)=>({headers,query,originalUrl});
test('read capabilities reject upload credentials, bearer identities and anonymous requests',()=>{
  assert.equal(verifySignedMediaRequest(request({'x-upload-token':'forged'})).valid,false);
  for(const role of ['client','designer','manager','admin']) {
    const token=jwt.sign({role},getJwtSecret());
    assert.equal(verifySignedMediaRequest(request({authorization:`Bearer ${token}`})).valid,false);
  }
  assert.equal(verifySignedMediaRequest(request()).valid,false);
});
test('signed capabilities require exact path, signature and unexpired numeric expiry',()=>{
  const url=new URL(signMediaPath(path),'https://example.test');
  const query=Object.fromEntries(url.searchParams);
  assert.equal(verifySignedMediaRequest(request({},query)).valid,true);
  assert.equal(verifySignedMediaRequest(request({},query,path+'-other')).valid,false);
  assert.equal(verifySignedMediaRequest(request({},{...query,sig:'0'.repeat(64)})).valid,false);
  assert.equal(verifySignedMediaRequest(request({},{...query,exp:query.exp+'junk'})).valid,false);
  const expired=new URL(signMediaPath(path,-10),'https://example.test');
  assert.equal(verifySignedMediaRequest(request({},Object.fromEntries(expired.searchParams))).valid,false);
});
