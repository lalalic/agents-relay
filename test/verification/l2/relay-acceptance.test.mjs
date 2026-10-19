import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {relayAcceptProviderEvents} from './relay-acceptance.mjs';

const source=(job,task,execution)=>`job/${job}/task/${task}/execution/${execution}`;
async function replay(role,data) {
 const work=mkdtempSync(join(tmpdir(),'relay-l2-acceptance-'));
 mkdirSync(join(work,'stores'));
 try {
  return await relayAcceptProviderEvents({work,jobId:'l2-case',taskId:'role-test',executionId:'generation-1',role,
   events:[{type:'task.started',source:{id:source('l2-case','role-test','generation-1')},data:{}},
     {type:'task.completed',source:{id:source('l2-case','role-test','generation-1')},data}]});
 }finally{rmSync(work,{recursive:true,force:true});}
}
test('real production Relay reviewer normalizer persists immutable approved SHA',async()=>{
 const result=await replay('reviewer',{verdict:'approved',head_sha:'l2-immutable-fixture',findings:[]});
 assert.equal(result.accepted,true);
 assert.equal(result.reviewOutcome,'approved');
 assert.equal(result.taskState,'SUCCEEDED');
});
test('isolated implementation completion is accepted by production Relay ingress',async()=>{
 const result=await replay('implementation',{artifact:'1+1=2',evidence:'direct arithmetic'});
 assert.equal(result.accepted,true);
 assert.deepEqual(result.progress.map(item=>item.state),['RUNNING','SUCCEEDED']);
});
test('wrong immutable reviewer SHA must not be certified as approved',async()=>{
 const result=await replay('reviewer',{verdict:'approved',head_sha:'wrong-immutable-sha',findings:[]});
 assert.notEqual(result.reviewOutcome,'approved');
 assert.equal(result.accepted,false);
});
