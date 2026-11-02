import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clientCanReadVersion} from '../src/services/proofAccessService.js';
test('clients keep current release during internal review and lose older releases after approval',()=>{
 const order={draftVersions:[{versionNumber:1,managerReview:{status:'approved'}},{versionNumber:2,managerReview:{status:'pending'}}]};
 assert.equal(clientCanReadVersion(order,1),true);
 assert.equal(clientCanReadVersion(order,2),false);
 order.draftVersions[1].managerReview.status='approved';
 assert.equal(clientCanReadVersion(order,1),false);
 assert.equal(clientCanReadVersion(order,2),true);
 assert.equal(clientCanReadVersion(order,0),false);
 assert.equal(clientCanReadVersion({},1),false);
});
