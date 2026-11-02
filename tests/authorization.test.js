import {test} from 'node:test';
import assert from 'node:assert/strict';
import {permits} from '../src/services/authorizationService.js';
test('permissions deny unknown actions, inactive accounts and unassigned resource access',()=>{
 const order={assignedDesigner:'designer'};
 for(const role of ['admin','manager','designer','client','printer','unknown']) {
  const user={_id:role,role,isActive:true};
  assert.equal(permits(user,'unknown',order),false);
  assert.equal(permits({...user,isActive:false},'proof.view',order),false);
  assert.equal(permits(user,'magazine.download_original',order),['admin','manager'].includes(role));
  assert.equal(permits(user,'proof.view',order),['admin','manager','designer'].includes(role));
  assert.equal(permits(user,'draft.upload',order),['admin','designer'].includes(role));
  assert.equal(permits(user,'settings.manage'),role==='admin');
 }
 assert.equal(permits({_id:'other',role:'designer'},'photo.read',order),false);
 assert.equal(permits({_id:'admin',role:'admin'},'proof.view'),false);
});
