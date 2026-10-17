#!/usr/bin/env node
// Deterministic production-ingress replay. External provider and Git effects are disabled.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createIsolatedEnvironment} from './harness.mjs';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {LocalAuthorityDurableStore} from '../../dist/local-authority-store.js';
import {InMemoryStore} from '../../dist/store.js';
import {MemoryEventBus,eventFor} from '../../dist/events.js';
import {Reconciler,executionEventSource} from '../../dist/reconciler.js';
const stamp='2026-10-17T12:00:00.000Z';
const jobId='l3-replay';
const task=(id,deps=[],initialState)=>{const state=initialState??(deps.length?'DRAFT':'RUNNING');const running=state==='RUNNING';return {jobId,id,kind:'work',agentName:'implementation',adapter:'chatgpt',input:'mock agent',output:{kind:'task_pr'},parentTaskId:null,dependencies:deps,capabilities:[],state,attempt:state==='QUEUED'||deps.length?0:1,maxAttempts:3,leaseOwner:running?'mock':null,leaseExpiresAt:running?'2099-01-01T00:00:00.000Z':null,executionId:running?'exec-a':null,executionHistory:running?[{id:'exec-a',attempt:1,startedAt:stamp}]:[],threadId:null,result:null,error:null,timeoutMs:900000,createdAt:stamp,updatedAt:stamp};};
const fingerprint=value=>JSON.stringify({job:value.state,merge:value.localMerge?.status??null,tasks:value.tasks.map(({id,state,attempt,executionId,result,error})=>({id,state,attempt,executionId,result:result??null,error:error??null}))});
export async function runReplay(scenario) {
 if(!scenario || !/^[a-z0-9-]+$/.test(scenario.id??'') || !Array.isArray(scenario.steps) || scenario.steps.length>200) throw Error('invalid scenario');
 const env=createIsolatedEnvironment('relay-l3-replay-');
 let sqlite=new SQLiteRelayStore(join(env.storeDir,'relay.sqlite'),jobId);
 let store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore(),undefined,true);
 const bus=new MemoryEventBus();
 let runtime=new Reconciler(store,{owner:'l3-replay',adapters:[],eventBus:bus,maxConcurrent:0,noGitHub:true});
 const trace=[];let stop;
 try {
  const tasks=(scenario.tasks??[{id:'a'},{id:'b',dependencies:['a']}]).map(item=>task(item.id,item.dependencies??[],item.state));
  if(new Set(tasks.map(item=>item.id)).size!==tasks.length || tasks.some(item=>item.dependencies.some(dep=>!tasks.some(other=>other.id===dep)))) throw Error('invalid task dependencies');
  await store.saveJob({id:jobId,title:scenario.id,repository:'local/isolated',prNumber:0,state:'ACTIVE',executionMode:scenario.executionMode??'fixed',autoMerge:false,reviewEnabled:false,createdAt:stamp,updatedAt:stamp,tasks});
  stop=await runtime.watch(jobId);
  const snapshot=async()=>await sqlite.loadJob(jobId);
  let prior=await snapshot();
  for(let index=0;index<scenario.steps.length;index++) {
   const step=scenario.steps[index];
   if(!['task.completed','task.failed','task.started','review.started','review.approved','review.changes_required','job.merge.failed','job.merge.succeeded','reconcile','restart'].includes(step.type)) throw Error(`unsupported event: ${step.type}`);
   if(step.type==='reconcile') await runtime.reconcile(jobId);
   else if(step.type==='restart') {
    await stop?.(); await runtime.close(); sqlite.close();
    sqlite=new SQLiteRelayStore(join(env.storeDir,'relay.sqlite'),jobId);
    store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore(),undefined,true);
    runtime=new Reconciler(store,{owner:'l3-replay',adapters:[],eventBus:bus,maxConcurrent:0,noGitHub:true});
    stop=await runtime.watch(jobId);
   }
   else if(step.type.startsWith('job.merge.')) {
    const current=await snapshot();
    current.localMerge=step.type==='job.merge.succeeded'
      ? {status:'succeeded',mergedCommitSha:step.mergedCommitSha??'merge-1',sourceSha:step.sourceSha??'head-1',attempts:step.attempts??1}
      : {status:'failed',error:step.message??'simulated merge failure',attempts:step.attempts??1,nextAttemptAt:step.nextAttemptAt??stamp};
    await sqlite.saveJob(current);
   }
   else {
    const taskId=step.taskId??(step.type.startsWith('review.')?'review':'a');
    const source=executionEventSource(jobId,taskId,step.executionId??'exec-a');
    await bus.publish(eventFor(jobId,taskId,null,step.type,step.type==='task.failed'?'failed':'succeeded',step.type,'orchestrator',step.data??{}, {id:source}));
   }
   if(step.type!=='restart') await runtime.idle();
   const observed=await snapshot();
   trace.push({index,event:step.type,source:step.executionId??'exec-a',before:prior.tasks.map(t=>({id:t.id,state:t.state,executionId:t.executionId})),after:observed.tasks.map(t=>({id:t.id,state:t.state,executionId:t.executionId})),jobState:observed.state,mergeStatus:observed.localMerge?.status??null,progress:fingerprint(prior)!==fingerprint(observed)});
   prior=observed;
  }
  const actual={jobState:prior.state,tasks:Object.fromEntries(prior.tasks.map(t=>[t.id,t.state])),localMerge:prior.localMerge??null};
  const errors=[];
  if(scenario.expected?.jobState && scenario.expected.jobState!==actual.jobState) errors.push(`job expected ${scenario.expected.jobState}, got ${actual.jobState}`);
  for(const [id,state] of Object.entries(scenario.expected?.tasks??{})) if(actual.tasks[id]!==state)errors.push(`${id} expected ${state}, got ${actual.tasks[id]??'missing'}`);
  if(scenario.expected?.localMergeStatus && actual.localMerge?.status!==scenario.expected.localMergeStatus) errors.push(`merge expected ${scenario.expected.localMergeStatus}, got ${actual.localMerge?.status??'none'}`);
  for(const assertion of scenario.assertions??[]){
   const transition=trace[assertion.step];
   if(!transition){errors.push(`missing transition step ${assertion.step}`);continue;}
   if(assertion.taskId){const before=transition.before.find(t=>t.id===assertion.taskId)?.state;const after=transition.after.find(t=>t.id===assertion.taskId)?.state;
    if(assertion.before!==undefined&&assertion.before!==before)errors.push(`step ${assertion.step} ${assertion.taskId} before expected ${assertion.before}, got ${before}`);
    if(assertion.after!==undefined&&assertion.after!==after)errors.push(`step ${assertion.step} ${assertion.taskId} after expected ${assertion.after}, got ${after}`);}
   if(assertion.progress!==undefined&&assertion.progress!==transition.progress)errors.push(`step ${assertion.step} progress mismatch`);
  }
  const seen=new Set();
  for(const item of trace) if(!item.progress && item.event==='reconcile'){const stable=JSON.stringify({after:item.after.map(t=>({id:t.id,state:t.state,executionId:t.executionId})),job:item.jobState,merge:item.mergeStatus});if(seen.has(stable))errors.push('NO_PROGRESS_LOOP');seen.add(stable);}
  return {schemaVersion:2,scenarioId:scenario.id,category:scenario.category??'L3',outcome:errors.length?'FAIL':'PASS',actual,trace,errors,authority:'isolated SQLite via production event bus and reconciler'};
 }finally{await stop?.();await runtime.close();sqlite.close();env.cleanup();}
}
export async function replayFile(path,outputDir){
 const scenario=JSON.parse(readFileSync(path,'utf8'));
 const result=await runReplay(scenario);
 mkdirSync(outputDir,{recursive:true});
 writeFileSync(join(outputDir,'report.json'),JSON.stringify(result,null,2)+'\n');
 writeFileSync(join(outputDir,'report.md'),['# L3 production-ingress replay','',`Scenario: ${result.scenarioId}`,`Result: ${result.outcome}`,`SQLite job state: ${result.actual.jobState}`,'','| Step | Event | Before | After |','| --- | --- | --- | --- |',...result.trace.map(s=>`| ${s.index} | ${s.event} | ${s.before.map(t=>t.id+':'+t.state).join(', ')} | ${s.after.map(t=>t.id+':'+t.state).join(', ')} |`),'',...result.errors.map(e=>'- ERROR: '+e),''].join('\n'));
 return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [source,output=resolve('.verification-reports/l3')]=process.argv.slice(2);
 if(!source) throw Error('Usage: node test/verification/l3-replay.mjs scenario.json output-dir');
 const result=await replayFile(resolve(source),resolve(output));
 console.log(JSON.stringify(result,null,2));
 if(result.outcome!=='PASS')process.exitCode=1;
}
