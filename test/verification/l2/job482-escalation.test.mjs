import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('contradictory Job482 evidence uses one durable escalation across restart and exact recovery',async()=>{
 const {verifyJob482EscalationLoop}=await import('./job482-escalation.mjs');
 const work=mkdtempSync(join(tmpdir(),'relay-job482-escalation-'));
 mkdirSync(join(work,'stores'));
 try {
  const result=await verifyJob482EscalationLoop({work,originalExecutionId:'original-exec',recoveryExecutionId:'recovery-exec',
    recommendation:{path:'escalation_gate',requiredAction:'Authorize the Neo app',resolutionCondition:'Browser Workspace reports connected=true and permissions=true',context:'Authoritative capture reports connected=false and permissions=false despite a stale connected=true summary'}});
  assert.equal(result.accepted,true);
  assert.equal(result.duplicate,true);
  assert.deepEqual(result.states,{original:'QUEUED',recovery:'QUEUED'});
  assert.equal(result.recoveryExecution.original,null);
  assert.ok(result.recoveryExecution.recovery);
 } finally { rmSync(work,{recursive:true,force:true}); }
});
