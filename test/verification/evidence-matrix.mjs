#!/usr/bin/env node
/** Only direct execution of production replay can provide L3 evidence. */
import {loadScenarios,newEvidence,writeReport} from './harness.mjs';
import {runReplay} from './l3-replay.mjs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=dirname(fileURLToPath(import.meta.url));
const corpus=loadScenarios(join(dir,'scenarios.json'));
/** This entry point intentionally does NOT accept caller-supplied execution flags or terminals. */
export async function evidenceGate(scenario, {fixture}={}) {
 if(scenario.category==='L2')return newEvidence(scenario,{reason:'Real installed provider, adapter and Relay delivery not executed'});
 if(scenario.category==='L1')return newEvidence(scenario,{reason:'Contract assertions run separately; no scenario-bound production evidence'});
 if(!fixture)return newEvidence(scenario,{reason:'No full-path production ingress fixture executed'});
 if(fixture.id!==scenario.id)return newEvidence(scenario,{outcome:'FAIL',reason:'Fixture ID mismatch'});
 // runReplay builds its own isolated store, drives the production event bus and
 // reconciler, then derives actual state from SQLite. No caller flags are used.
 const result=await runReplay(fixture);
 const causal=result.trace.some(t=>t.event==='task.completed'&&t.progress)&&result.trace.some(t=>t.event==='reconcile');
 const terminal=result.actual.jobState;
 const outcome=result.outcome==='PASS'&&causal&&terminal===scenario.expectedTerminal?'PASS':'FAIL';
 return newEvidence(scenario,{outcome,actualTerminal:terminal,trace:result.trace,reason:outcome==='PASS'?null:result.errors.join('; ')||'Missing causal transitions or terminal mismatch'});
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 if(process.argv.length>3)throw Error('Only an output directory is accepted; external observation flags are forbidden');
 const results=await Promise.all(corpus.map(s=>evidenceGate(s)));
 const report=writeReport(results,resolve(process.argv[2]??'/tmp/agents-relay-verification-b'));
 console.log(JSON.stringify({results:results.map(({scenarioId,category,outcome,reason})=>({scenarioId,category,outcome,reason})),report},null,2));
}
