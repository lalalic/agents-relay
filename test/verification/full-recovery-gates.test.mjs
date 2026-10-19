import test from 'node:test';
import assert from 'node:assert/strict';
import {REQUIRED_RECOVERY_PATHS,evaluateRecoveryMatrix} from './full-recovery-gates.mjs';
test('Job 481 matrix derives only trusted replay proof from production Graph and isolated SQLite',async()=>{
 assert.equal(REQUIRED_RECOVERY_PATHS.length,11);
 const results=await evaluateRecoveryMatrix();
 assert.equal(results.length,11);
 for(const id of ['human-escalation-resume','unknown-effect-reconciliation','review-changes-required','reviewer-failure-recovery','merge-failure-recovery','impossible-objective','worker-failure-recovery']){
  const item=results.find(x=>x.id===id);
  assert.equal(item.outcome,'PASS',JSON.stringify(item));
  assert.equal(item.sqliteJobState,id==='impossible-objective'?'ACTIVE':'COMPLETED');
  assert.match(item.authority,/isolated SQLite/);
 }
 for(const item of results.filter(x=>!['human-escalation-resume','unknown-effect-reconciliation','review-changes-required','reviewer-failure-recovery','merge-failure-recovery','impossible-objective','worker-failure-recovery'].includes(x.id)))
  assert.equal(item.outcome,'NOT_RUN',item.id);
});
test('external inputs cannot bless any of the remaining paths',async()=>{
 const forged={outcome:'PASS',trusted:true,objective:'COMPLETED'};
 const results=await evaluateRecoveryMatrix(forged);
 assert.equal(results.filter(x=>x.outcome==='PASS').length,7);
});
