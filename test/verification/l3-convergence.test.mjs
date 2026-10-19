import test from 'node:test';
import assert from 'node:assert/strict';
import {runReplay} from './l3-replay.mjs';

/** External model launches are simulated by mock.claim, but task/recovery/event
 * transitions, job completion and restart go through production Graph,
 * Reconciler and real isolated SQLite state. */
function recoveredStage(id, initial) {
  const first=initial?'exec-a':`${id}-attempt-1`;
  const recovery=`troubleshooter-${id}-attempt-1`;
  const next=`${id}-attempt-2`;
  return [
    ...(!initial ? [{type:'reconcile'}, {type:'mock.claim',taskId:id,executionId:first}, {type:'task.started',taskId:id,executionId:first}] : []),
    {type:'task.failed',taskId:id,executionId:first,data:{reason:'injected_failure',phase:id}},
    {type:'mock.claim',taskId:`troubleshoot-${id}`,executionId:recovery},
    {type:'task.started',taskId:`troubleshoot-${id}`,executionId:recovery},
    {type:'task.recover',taskId:id,recoveryTaskId:`troubleshoot-${id}`},
    {type:'task.completed',taskId:`troubleshoot-${id}`,executionId:recovery},
    {type:'restart'},
    {type:'mock.claim',taskId:id,executionId:next},
    {type:'task.started',taskId:id,executionId:next},
    {type:'task.completed',taskId:id,executionId:next},
    {type:'task.completed',taskId:id,executionId:first,expectIgnored:true},
  ];
}

test('three consecutive stage faults each recover via real Troubleshooter and Graph; merge retry eventually COMPLETES objective',async()=>{
 const stages=['planning-work','implementation-work','review-prep'];
 const tasks=stages.map((id,i)=>({id,state:i===0?'RUNNING':'DRAFT',dependencies:i?[stages[i-1]]:[]}));
 // The initial execution ID in the replay fixture is exec-a.
 const steps=[...recoveredStage(stages[0],true),...recoveredStage(stages[1],false),...recoveredStage(stages[2],false),
   {type:'mock.clock.advance',millis:5000},
   {type:'restart'},
   {type:'reconcile'}];
 const expectedTasks=Object.fromEntries([...stages.map(id=>[id,'SUCCEEDED']),...stages.map(id=>[`troubleshoot-${id}`,'SUCCEEDED'])]);
 const result=await runReplay({id:'multi-failure-objective-converges',autoMerge:true,headSha:'head-final',mergeOutcomes:['failed','succeeded'],tasks,steps,
   expected:{jobState:'COMPLETED',tasks:expectedTasks,localMergeStatus:'succeeded'}});
 assert.equal(result.outcome,'PASS',result.errors.join('; '));
 assert.equal(result.actual.jobState,'COMPLETED');
 assert.equal(result.trace.at(-1).jobState,'COMPLETED','only Graph reconciliation completes after verified delivery');
 assert.equal(result.externalGitAttempts,2);
 assert.ok(result.actionTraces.length >= 6, 'Graph-authorized external launches should be audited');
 assert.ok(result.actionTraces.every(x=>x.outcome==='Verified'), 'All confirmed task.started effects verified against authoritative SQLite');
 assert.deepEqual(result.observedEvents.filter(x=>x.event.startsWith('job.merge.')).map(x=>x.event),['job.merge.failed','job.merge.succeeded']);
 for(const id of stages){
   const failed=result.trace.find(x=>x.event==='task.failed'&&x.after.some(t=>t.id===id&&t.state==='FAILED'));
   const resolution=result.trace.find(x=>x.event==='task.recover'&&x.after.some(t=>t.id===id&&t.state==='QUEUED'));
   assert.ok(failed && resolution && resolution.index>failed.index,`missing causal recovery for ${id}`);
 }
 assert.equal(result.trace.filter(x=>x.event==='task.completed'&&!x.progress).length,3,'three stale old-generation terminals were ignored');
});

test('unresolved failed stages and fabricated merge receipt never complete the objective',async()=>{
 const result=await runReplay({id:'multi-failure-impossible-objective',autoMerge:true,tasks:[{id:'a'},{id:'b',dependencies:['a']}],
   steps:[{type:'task.failed',taskId:'a'}, {type:'restart'}, {type:'job.merge.succeeded',mergedCommitSha:'not-proof'}, {type:'reconcile'}],
   expected:{jobState:'ACTIVE',tasks:{a:'FAILED',b:'DRAFT'}}});
 assert.equal(result.outcome,'PASS',result.errors.join('; '));
 assert.notEqual(result.actual.jobState,'COMPLETED');
});
