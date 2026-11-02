import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getJwtSecret} from '../src/middlewares/auth.middleware.js';
import {getMediaSigningSecret} from '../src/services/mediaSignService.js';
test('production requires independent strong signing keys without database fallback',()=>{
 const keys=['NODE_ENV','JWT_SECRET','MEDIA_SIGNING_SECRET','MONGODB_URI'];
 const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try{
 process.env.NODE_ENV='production';delete process.env.JWT_SECRET;delete process.env.MEDIA_SIGNING_SECRET;
 process.env.MONGODB_URI='mongodb://example.test/test';
 assert.throws(getJwtSecret,/required/);assert.throws(getMediaSigningSecret,/required/);
 process.env.JWT_SECRET='a'.repeat(48);process.env.MEDIA_SIGNING_SECRET=process.env.JWT_SECRET;
 assert.throws(getMediaSigningSecret,/separate/);
 process.env.MEDIA_SIGNING_SECRET='b'.repeat(48);
 assert.notEqual(getJwtSecret(),getMediaSigningSecret());
 }finally{for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}}
});
