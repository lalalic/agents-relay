import test from 'node:test';
import assert from 'node:assert/strict';
import {loadScenarios,newEvidence,createIsolatedEnvironment,classifyTrace,classifyObservedTrace,validateScenario} from './harness.mjs';
const s={id:'sample',category:'L3',expectedTrace:['start','end'],expectedTerminal:'COMPLETED'};
test('scenario corpus',()=>assert.ok(loadScenarios(new URL('./scenarios.json',import.meta.url)).length>=3));
test('no fabricated success',()=>assert.equal(newEvidence(s).outcome,'NOT_RUN'));
test('store isolation',()=>{const x=createIsolatedEnvironment();assert.notEqual(x.env.AGENTS_RELAY_STORE_DIR,process.env.AGENTS_RELAY_STORE_DIR);x.cleanup()});
test('deadlock and loop',()=>{assert.equal(classifyTrace(s,['start','end'],{terminal:'COMPLETED'}).outcome,'PASS');assert.equal(classifyTrace(s,['start'],{}).failureEdge,'DEADLOCK');assert.equal(classifyTrace(s,[{event:'a',progress:false},{event:'a',progress:false}],{terminal:'COMPLETED'}).failureEdge,'NO_PROGRESS_LOOP')});

test('observed state is required for workflow verdict',async()=>{
  await assert.rejects(classifyObservedTrace(s,['start','end']),/durable state reader/);
  assert.equal((await classifyObservedTrace(s,['start','end'],{loadDurableState:async()=>({state:'ACTIVE'})})).failureEdge,'TERMINAL_MISMATCH');
  assert.equal((await classifyObservedTrace(s,['start','end'],{loadDurableState:async()=>({state:'COMPLETED'})})).outcome,'PASS');
});
test('loop fingerprint ignores timestamp variation',()=>{
  const trace=[{event:'idle',state:'RUNNING',progress:false,timestamp:'a'},{event:'idle',state:'RUNNING',progress:false,timestamp:'b'}];
  assert.equal(classifyTrace(s,trace,{terminal:'COMPLETED'}).failureEdge,'NO_PROGRESS_LOOP');
});
test('scenario rejects invalid outcome injection',()=>{
  assert.throws(()=>validateScenario({...s,externalOutcomes:[{foo:'bar'}]}),/invalid externalOutcomes/);
});
