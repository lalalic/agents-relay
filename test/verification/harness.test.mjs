import test from 'node:test';
import assert from 'node:assert/strict';
import {loadScenarios,newEvidence,createIsolatedEnvironment,classifyTrace} from './harness.mjs';
const s={id:'sample',category:'L3',expectedTrace:['start','end'],expectedTerminal:'COMPLETED'};
test('scenario corpus',()=>assert.ok(loadScenarios(new URL('./scenarios.json',import.meta.url)).length>=3));
test('no fabricated success',()=>assert.equal(newEvidence(s).outcome,'NOT_RUN'));
test('store isolation',()=>{const x=createIsolatedEnvironment();assert.notEqual(x.env.AGENTS_RELAY_STORE_DIR,process.env.AGENTS_RELAY_STORE_DIR);x.cleanup()});
test('deadlock and loop',()=>{assert.equal(classifyTrace(s,['start','end'],{terminal:'COMPLETED'}).outcome,'PASS');assert.equal(classifyTrace(s,['start'],{}).failureEdge,'DEADLOCK');assert.equal(classifyTrace(s,[{event:'a',progress:false},{event:'a',progress:false}],{terminal:'COMPLETED'}).failureEdge,'NO_PROGRESS_LOOP')});
