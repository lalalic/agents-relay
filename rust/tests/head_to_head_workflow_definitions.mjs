// Node/Rust direct differential for src/workflow/definitions-v2.ts. Canonical .mmd files are Graph topology authority.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {taskLifecycleV2,jobLifecycleV2,assertV2StateTransition} from '../../dist/workflow/definitions-v2.js';
import {WORKFLOW_EVENT_NAMES,WORKFLOW_EFFECT_NAMES,WORKFLOW_MUTATION_NAMES} from '../../dist/workflow/contracts.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),dir=resolve(root,'workflow'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let ready=false;
function rust(req){if(!ready){const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(build.status,0,build.stderr);ready=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:15000,maxBuffer:6*1024*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim());}
function node(req){try{const runtime=req.graph==='task'?taskLifecycleV2:jobLifecycleV2;
 if(req.op==='assertV2StateTransition'){assertV2StateTransition(runtime.graph,req.from,req.to,req.kind);return {ok:true,value:null}}
 return {ok:true,value:runtime.evaluateSync(req.facts)};
 }catch(error){return {ok:false,error:error.message}}}
let seed=0xf77a21ca;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;},pick=a=>a[rand(a.length)];
const transitions=[];
for(let i=0;i<950;i++){
 const graph=pick(['job','task']),runtime=graph==='job'?jobLifecycleV2:taskLifecycleV2;
 const states=[...new Set([...runtime.graph.nodes.values()].filter(node=>node.kind==='state').map(node=>node.semanticId))];
 transitions.push({op:'assertV2StateTransition',graph,directory:dir,from:pick([...states,'unknown-state']),to:pick([...states,'bogus']),kind:graph});
}
test('canonical task/job state transitions are allowed only by reachable Mermaid edges',()=>{
 for(const [i,req] of transitions.entries())assert.deepEqual(rust(req),node(req),`state transition ${i}: ${JSON.stringify(req)}`);
 console.log(`Verified ${transitions.length} Node/Rust lifecycle Graph topology transition claims`);
});
const GUARDS=['dependenciesSatisfied','dependenciesUnsatisfied','runnable','dispatchable','shortcutEffectsSafe','recoverableExecution','troubleshooterRecovery','troubleshooterTask','awaitingInteractiveDecision','retryAvailable','platformFallbackSafe','noStartFallbackAllowed','notMerged','autoMerge','prOpen','reviewDisabled','implementationComplete','headAvailable','mergeCapable','jobActive','autoMergeEnabled','completionGateSatisfied','reviewSatisfied','localMergeRequired','localMergeSucceeded','localMergePresent','reviewHeadCurrent','mergeAttemptReady'];
const choices=[...WORKFLOW_EVENT_NAMES,...WORKFLOW_EFFECT_NAMES,...WORKFLOW_MUTATION_NAMES,'bogus-event'];
const decisions=[];
for(let i=0;i<1150;i++){
 const graph=pick(['job','task']),runtime=graph==='job'?jobLifecycleV2:taskLifecycleV2;
 const states=[...new Set([...runtime.graph.nodes.values()].filter(node=>node.kind==='state').map(node=>node.semanticId))];
 const ids=[...new Set(runtime.graph.edges.filter(edge=>edge.kind==='on'||edge.kind==='request').map(edge=>edge.semanticId))];
 const id=pick([...ids,...choices]);
 const transport=pick(['event','event','action']);
 const facts={currentState:pick([...states,'INVALID']),input:{transport,id,payload:{request:i}},durableFacts:Object.fromEntries(GUARDS.map(key=>[key,pick([true,false])]))};
 decisions.push({op:'canonicalWorkflowV2Evaluate',graph,directory:dir,facts});
}
test('canonical loaded Job/Task Graph guard paths and action decisions match Node',()=>{
 for(const [i,req] of decisions.entries())assert.deepEqual(rust(req),node(req),`loaded Graph decision ${i}: ${JSON.stringify(req).slice(0,500)}`);
 console.log(`Verified ${decisions.length} real Node/Rust canonical Job/Task Graph decision scenarios`);
});
