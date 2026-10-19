#!/usr/bin/env node
/** Evidence gates; a test passing is not proof of unexecuted provider/workflow paths. */
import {loadScenarios, newEvidence, writeReport} from './harness.mjs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=dirname(fileURLToPath(import.meta.url));
const corpus=loadScenarios(join(dir,'scenarios.json'));
export function evidenceGate(scenario, observation={}) {
 const actual=observation.actualTerminal??null;
 const reasons=[];
 if(!observation.productionPath)reasons.push('No production event ingress and SQLite causal proof');
 if(scenario.category==='L2' && (!observation.realProvider || !observation.realAdapter || !observation.acceptedByRelay))reasons.push('No verified real-provider, real-adapter and Relay-accepted event');
 if(scenario.category==='L3' && (!observation.graphTransitions || !observation.schedulerTransitions || !observation.sqlitePredicates))reasons.push('Missing graph/scheduler/SQLite verification');
 if(scenario.category==='L1' && !observation.contractAssertions)reasons.push('No executed contract assertions');
 if(!actual)reasons.push('No observed authoritative terminal state');
 const outcome=reasons.length?'NOT_RUN':actual===scenario.expectedTerminal?'PASS':'FAIL';
 return newEvidence(scenario,{outcome,actualTerminal:actual,reason:reasons.join('; ')||null,trace:observation.trace??[]});
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 if(process.argv[2] && !process.argv[2].startsWith('/'))throw new Error('Only output directory is accepted; evidence must come from trusted production runners');
 const results=corpus.map(s=>evidenceGate(s));
 const report=writeReport(results,resolve(process.argv[2]??'/tmp/agents-relay-verification-b'));
 console.log(JSON.stringify({results:results.map(({scenarioId,category,outcome,reason})=>({scenarioId,category,outcome,reason})),report},null,2));
 if(results.some(r=>r.outcome==='FAIL'))process.exitCode=1;
}
