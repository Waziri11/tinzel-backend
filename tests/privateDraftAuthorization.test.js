import {test} from 'node:test';
import assert from 'node:assert/strict';
import {privateDraftStorage} from '../src/services/privateDraftStorage.js';
test('the actual SDK signs an exact-path write-only client token with size, type and expiry constraints',async()=>{
 const previous=process.env.DRAFT_BLOB_READ_WRITE_TOKEN;process.env.DRAFT_BLOB_READ_WRITE_TOKEN='vercel_blob_rw_fixture_signing-secret-for-offline-test';
 try{
  const session={blobPath:'tinzel/drafts/order/session.pdf',size:500*1024*1024,expiresAt:new Date(Date.now()+86400000)};
  const result=await privateDraftStorage.authorize(session),sealed=Buffer.from(result.token.slice('vercel_blob_client_fixture_'.length),'base64').toString(),payload=JSON.parse(Buffer.from(sealed.slice(sealed.indexOf('.')+1),'base64').toString());
  assert.equal(payload.pathname,session.blobPath);assert.equal(payload.maximumSizeInBytes,session.size);assert.deepEqual(payload.allowedContentTypes,['application/pdf']);assert.equal(payload.allowOverwrite,false);assert.equal(payload.addRandomSuffix,false);assert.ok(payload.validUntil<=Date.now()+3600000);assert.doesNotMatch(result.token,/signing-secret/);
 }finally{if(previous===undefined)delete process.env.DRAFT_BLOB_READ_WRITE_TOKEN;else process.env.DRAFT_BLOB_READ_WRITE_TOKEN=previous;}
});
