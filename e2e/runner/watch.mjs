#!/usr/bin/env node
// Outside Agents Relay: detects true E2E failures and hands off evidence.
import {spawnSync} from 'node:child_process';
import {openSync, closeSync, readSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {reviewHeadSha} from './evidence.mjs';
import {NatsEventBus} from '../../dist/events.js';
import {resolveEventsBusRuntime} from '../../dist/events-bus-runtime.js';
import {scenario005Decision,scenario005PassEligible} from './scenario-005.mjs';
const root=resolve(import.meta.dirname,'../..');
const argv=process.argv.slice(2);
const option=(k,def)=>{const i=argv.indexOf('--'+k);return i>=0?argv[i+1]:def};
const repo=option('repo',''),pr=String(option('pr','0'));
const jobId=option('job','');
if(!repo)throw Error('--repo is required');
if(!jobId)throw Error('--job is required');
const branch=option('branch','');
const scenario=option('scenario','');
const runKey=`${repo}/${jobId}`;
const eventsPath=option('events','/Users/chengli/Library/Application Support/EventsBus/events.jsonl');
const statePath=option('state',resolve(root,`e2e/runs/current/${jobId}/watch-state.json`));
const handoffPath=option('out',resolve(root,`e2e/runs/current/${jobId}/handoff.json`));
const expectedCancelPath=option('expected-cancel',resolve(dirname(statePath),'expected-cancel.json'));
const threadId=option('thread',option('thread-id',process.env.E2E_CHATGPT_THREAD_ID||''));
const handoffCommand=option('handoff-command',process.env.E2E_HANDOFF_COMMAND||(threadId?resolve(root,'e2e/runner/handoff.mjs'):''));
const intervalMs=Number(option('interval-ms','5000')),staleMs=Number(option('stale-ms','240000'));
const save=(p,v)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,JSON.stringify(v,null,2)+'\n')};
const abnormalStatuses=new Set(['FAILED','BLOCKED']);
let pendingAbnormalStatus=null;
let state={runKey,scenario,offset:0,lastEventAt:null,fingerprint:null,delivered:false,pendingTransferId:null,phase:'monitoring',evidence:{workerFailedOrBlocked:false,troubleshooterCreated:false,troubleshooterSucceeded:false,originalRetried:false,reviewChangesRequired:0,reviewApproved:0,reviewHeads:[],recoveryExhausted:0,projectionPendingSince:null}};
try{const previous=JSON.parse(readFileSync(statePath,'utf8'));if(previous.runKey===runKey)state={...state,...previous}}catch{}
function events(){
 let size;try{size=statSync(eventsPath).size}catch{return []}
 if(size<state.offset)state.offset=0;
 const len=size-state.offset;if(!len)return[];
 const fd=openSync(eventsPath,'r'),buf=Buffer.alloc(len);
 try{readSync(fd,buf,0,len,state.offset)}finally{closeSync(fd)}
 const lines=buf.toString('utf8').split('\n'),partial=lines.pop()||'';
 state.offset=size-Buffer.byteLength(partial);
 return lines.flatMap(line=>{try{const item=JSON.parse(line);return item.event?.job_id===jobId?[item]:[]}catch{return []}});
}
function snapshot(){
 const args=[resolve(root,'dist/cli.js'),'job','show','--repo',repo,'--id',jobId];
 if(pr!=='0')args.push('--pr',pr);
 const p=spawnSync(process.execPath,args,{encoding:'utf8',cwd:root,timeout:30000,maxBuffer:8000000});
 if(p.status!==0)throw Error(p.error?.message||p.stderr||'job show failed');
 return JSON.parse(p.stdout);
}

function githubCapability(){
 const p=spawnSync('curl',['-fsS','http://127.0.0.1:8787/api/status'],{encoding:'utf8',timeout:30000,maxBuffer:1000000});
 if(p.status!==0)return {enabled:false,error:p.error?.message||p.stderr||'status unavailable'};
 try{const status=JSON.parse(p.stdout);return {enabled:status.githubEnabled===true,authenticated:status.githubAuthenticated!==false,error:status.githubAuthError||null,status};}catch(error){return {enabled:false,error:error.message};}
}

function externalJobSnapshot(j){
 const boundPr=Number(j.externalPrNumber||j.prNumber||0);
 if(boundPr<=0)return null;
 const p=spawnSync('curl',['-fsS','http://127.0.0.1:8787/api/jobs?refresh=1'],{encoding:'utf8',timeout:30000,maxBuffer:8000000});
 if(p.status!==0)return {error:p.error?.message||p.stderr||'dashboard GitHub verification unavailable'};
 try{
  const jobs=JSON.parse(p.stdout);
  const match=(Array.isArray(jobs)?jobs:[]).find(x=>x.id===jobId&&x.repository===repo&&Number(x.externalPrNumber||x.prNumber)===boundPr);
  return match?{githubState:match.githubState||'UNKNOWN',prNumber:boundPr}:{error:'Job not found in dashboard inventory'};
 }catch(error){return {error:error.message};}
}

function scenario002(j){
 const tasks=j.tasks||[];
 const ordinary=tasks.filter(x=>x.kind==='work'&&x.agentName!=='reviewer'&&x.agentName!=='troubleshooter');
 const recoveries=tasks.filter(x=>x.agentName==='troubleshooter');
 const reviews=tasks.filter(x=>x.agentName==='reviewer'||x.review?.role);
 const failedRoot=ordinary.find(x=>x.state==='FAILED'||x.state==='BLOCKED');
 const failedRecovery=recoveries.find(x=>x.state==='FAILED'||x.state==='BLOCKED');
 const recoveredRoot=ordinary.find(x=>x.state==='SUCCEEDED'&&Number(x.attempt)>=2);
 const successfulRecovery=recoveries.find(x=>x.state==='SUCCEEDED');
 if(j.state==='COMPLETED'){
  if(!state.evidence.workerFailedOrBlocked&&!ordinary.some(x=>Number(x.attempt)>=2))return {type:'SCENARIO_TRIGGER_MISSING',message:'Scenario 002 completed without evidence that the original worker failed or blocked first'};
  if(!successfulRecovery&&!state.evidence.troubleshooterSucceeded)return {type:'TROUBLESHOOTER_EVIDENCE_MISSING',message:'Scenario 002 completed without a successful Troubleshooter recovery'};
  if(!recoveredRoot)return {type:'ORIGINAL_TASK_NOT_RECOVERED',message:'Scenario 002 completed without the original implementation Task succeeding on a later attempt'};
  if(j.reviewEnabled&& !reviews.some(x=>x.state==='SUCCEEDED'))return {type:'TERMINAL_INCONSISTENCY',message:'Job completed without successful independent review'};
  if(j.localMerge&&j.localMerge.status!=='succeeded')return {type:'TERMINAL_INCONSISTENCY',message:'Job completed without successful local merge',localMerge:j.localMerge};
  return null;
 }
 if(failedRecovery)return {type:'TROUBLESHOOTER_FAILED',tasks:[{id:failedRecovery.id,state:failedRecovery.state,error:failedRecovery.error,attempt:failedRecovery.attempt}]};
 if(failedRoot){
  const age=failedRoot.updatedAt?Date.now()-Date.parse(failedRoot.updatedAt):0;
  const related=recoveries.filter(x=>x.parentTaskId===failedRoot.id||x.id.startsWith('troubleshoot-'));
  if(!related.length&&age>30000)return {type:'TROUBLESHOOTER_NOT_CREATED',task:{id:failedRoot.id,state:failedRoot.state,error:failedRoot.error,attempt:failedRoot.attempt}};
  return null;
 }
 if(successfulRecovery&&!recoveredRoot){
  const root=ordinary[0];
  if(root&&!['QUEUED','RUNNING','SUCCEEDED'].includes(root.state)){
   const age=successfulRecovery.updatedAt?Date.now()-Date.parse(successfulRecovery.updatedAt):0;
   if(age>30000)return {type:'RECOVERY_DID_NOT_REACTIVATE_ORIGINAL',task:{id:root.id,state:root.state,attempt:root.attempt},troubleshooter:successfulRecovery.id};
  }
 }
 return null;
}
function scenario003(j){
 const tasks=j.tasks||[];
 const ordinary=tasks.filter(x=>x.kind==='work'&&x.agentName!=='reviewer'&&x.agentName!=='troubleshooter'&&!String(x.id).startsWith('review-fix-'));
 const recoveries=tasks.filter(x=>x.agentName==='troubleshooter');
 const fixes=tasks.filter(x=>String(x.id).startsWith('review-fix-'));
 const reviews=tasks.filter(x=>x.agentName==='reviewer'||x.review?.role);
 const root=ordinary[0];
 const rootRecoveries=root?recoveries.filter(x=>x.parentTaskId===root.id):[];
 const incidentalRecoveries=root?recoveries.filter(x=>x.parentTaskId!==root.id):recoveries;
 const successfulRecovery=rootRecoveries.find(x=>x.state==='SUCCEEDED');
 const failedRecovery=recoveries.find(x=>x.state==='FAILED'||x.state==='BLOCKED');
 if(rootRecoveries.length>1)return {type:'UNEXPECTED_DUPLICATE_ROOT_RECOVERY',recoveries:rootRecoveries.map(x=>({id:x.id,state:x.state,attempt:x.attempt,parentTaskId:x.parentTaskId}))};
 if(failedRecovery)return {type:'TROUBLESHOOTER_FAILED',tasks:[{id:failedRecovery.id,state:failedRecovery.state,error:failedRecovery.error,attempt:failedRecovery.attempt,parentTaskId:failedRecovery.parentTaskId}]};
 for(const recovery of incidentalRecoveries){
   const parent=tasks.find(x=>x.id===recovery.parentTaskId);
   if(!parent)return {type:'ORPHAN_TROUBLESHOOTER',recovery:{id:recovery.id,state:recovery.state,parentTaskId:recovery.parentTaskId}};
   if(!['FAILED','BLOCKED','QUEUED','RUNNING','SUCCEEDED'].includes(parent.state))return {type:'INVALID_INCIDENTAL_RECOVERY_PARENT',recovery:{id:recovery.id,state:recovery.state},parent:{id:parent.id,state:parent.state}};
 }
 if(root && ['FAILED','BLOCKED'].includes(root.state)){
   const age=root.updatedAt?Date.now()-Date.parse(root.updatedAt):0;
   const related=recoveries.filter(x=>x.parentTaskId===root.id||x.id.startsWith('troubleshoot-'));
   if(!related.length&&age>30000)return {type:'TROUBLESHOOTER_NOT_CREATED',task:{id:root.id,state:root.state,error:root.error,attempt:root.attempt}};
   return null;
 }
 if(successfulRecovery&&root&&!['QUEUED','RUNNING','SUCCEEDED'].includes(root.state)){
   const age=successfulRecovery.updatedAt?Date.now()-Date.parse(successfulRecovery.updatedAt):0;
   if(age>30000)return {type:'RECOVERY_DID_NOT_REACTIVATE_ORIGINAL',task:{id:root.id,state:root.state,attempt:root.attempt},troubleshooter:successfulRecovery.id};
 }
 if(j.state==='COMPLETED'){
   if(!state.evidence.workerFailedOrBlocked)return {type:'SCENARIO_TRIGGER_MISSING',message:'Scenario 003 completed without the required first implementation failure'};
   if(!state.evidence.troubleshooterSucceeded&&!successfulRecovery)return {type:'TROUBLESHOOTER_EVIDENCE_MISSING',message:'Scenario 003 completed without successful recovery of the intentionally failed implementation Task'};
   const unresolvedIncidental=incidentalRecoveries.filter(x=>x.state!=='SUCCEEDED');
   if(unresolvedIncidental.length)return {type:'INCIDENTAL_RECOVERY_UNRESOLVED',recoveries:unresolvedIncidental.map(x=>({id:x.id,state:x.state,parentTaskId:x.parentTaskId,error:x.error}))};
   if(!root||root.state!=='SUCCEEDED'||Number(root.attempt)<2)return {type:'ORIGINAL_TASK_NOT_RECOVERED',task:root?{id:root.id,state:root.state,attempt:root.attempt}:null};
   if(Number(state.evidence.reviewChangesRequired||0)<2||new Set(state.evidence.reviewHeads||[]).size<2)return {type:'REVIEW_REJECTION_LADDER_MISSING',count:state.evidence.reviewChangesRequired||0,heads:state.evidence.reviewHeads||[]};
   if(fixes.filter(x=>x.state==='SUCCEEDED').length<2)return {type:'REVIEW_FIX_LADDER_MISSING',fixes:fixes.map(x=>({id:x.id,state:x.state}))};
   if(Number(state.evidence.reviewApproved||0)<1&&!reviews.some(x=>x.state==='SUCCEEDED'))return {type:'FINAL_REVIEW_APPROVAL_MISSING'};
   if(j.localMerge&&j.localMerge.status!=='succeeded')return {type:'TERMINAL_INCONSISTENCY',message:'Scenario 003 completed without successful local merge',localMerge:j.localMerge};
   return null;
 }
 // Intentional reviewer changes_required produces SUCCEEDED reviewer tasks plus queued fix work;
 // do not classify those historical review outcomes as task failures.
 const unexpected=tasks.filter(x=>['FAILED','BLOCKED'].includes(x.state)&&x.agentName!=='troubleshooter'&&x!==root&&!recoveries.some(r=>r.parentTaskId===x.id&&['QUEUED','RUNNING','SUCCEEDED'].includes(r.state)));
 if(unexpected.length)return {type:'TASK_FAILED',tasks:unexpected.map(x=>({id:x.id,state:x.state,error:x.error,attempt:x.attempt}))};
 return null;
}

function scenario004(j){
 const tasks=j.tasks||[];
 const ordinary=tasks.filter(x=>x.kind==='work'&&x.agentName!=='reviewer'&&x.agentName!=='troubleshooter'&&!String(x.id).startsWith('review-fix-'));
 const recoveries=tasks.filter(x=>x.agentName==='troubleshooter');
 const root=ordinary[0];
 const rootRecoveries=root?recoveries.filter(x=>x.parentTaskId===root.id):[];
 if(rootRecoveries.length!==recoveries.length)return {type:'UNRELATED_RECOVERY',recoveries:recoveries.map(x=>({id:x.id,parentTaskId:x.parentTaskId}))};
 if(rootRecoveries.length>1)return {type:'RECURSIVE_RECOVERY',recoveries:rootRecoveries.map(x=>({id:x.id,state:x.state}))};
 if(recoveries.some(x=>x.state==='FAILED'&&x.attempt>=x.maxAttempts))return {type:'RECOVERY_BUDGET_EXHAUSTED',recoveries:recoveries.map(x=>({id:x.id,state:x.state,attempt:x.attempt,maxAttempts:x.maxAttempts}))};
 if(j.state==='COMPLETED'){
  if(!root||root.state!=='SUCCEEDED'||Number(root.attempt)<2)return {type:'ORIGINAL_TASK_NOT_RECOVERED',task:root};
  if(rootRecoveries.length!==1||rootRecoveries[0].state!=='SUCCEEDED'||Number(rootRecoveries[0].attempt)<2)return {type:'TROUBLESHOOTER_RETRY_NOT_PROVEN',recoveries:rootRecoveries};
  if((j.recoveryFailures||[]).length)return {type:'UNEXPECTED_RECOVERY_EXHAUSTION',failures:j.recoveryFailures};
  if(j.reviewEnabled!==false&&j.review?.outcome!=='approved')return {type:'FINAL_REVIEW_NOT_APPROVED',review:j.review};
  if(j.localMerge?.status!=='succeeded')return {type:'LOCAL_MERGE_NOT_SUCCEEDED',localMerge:j.localMerge};
  return null;
 }
 if(j.recoveryFailures?.length)return {type:'RECOVERY_EXHAUSTED_BEFORE_JOB_COMPLETION',failures:j.recoveryFailures};
 return null;
}

function detect(j){
 const tasks=j.tasks||[],plans=j.plans||[];
 const work=tasks.filter(x=>x.kind==='work'&&x.agentName!=='reviewer'&&x.agentName!=='troubleshooter');
 const reviews=tasks.filter(x=>x.agentName==='reviewer'||x.review?.role);
 if(j.state==='CANCELLED')return {type:'UNEXPECTED_CANCELLED',jobState:j.state};
 if(scenario.startsWith('002-')){
  const specific=scenario002(j);
  if(specific)return specific;
 } else if(scenario.startsWith('003-')){
  const specific=scenario003(j);
  if(specific)return specific;
 } else if(scenario.startsWith('004-')){
  const specific=scenario004(j);
  if(specific)return specific;
 } else {
  const failed=tasks.filter(x=>x.state==='FAILED'||x.state==='BLOCKED');
  if(failed.length)return {type:'TASK_FAILED',tasks:failed.map(x=>({id:x.id,state:x.state,error:x.error,executionId:x.executionId,attempt:x.attempt}))};
 }
 if(j.state==='COMPLETED'){
  if(work.some(x=>x.state==='SUCCEEDED') && (!j.reviewEnabled || reviews.some(x=>x.state==='SUCCEEDED')) && (!j.localMerge || j.localMerge.status==='succeeded'))return null;
  return {type:'TERMINAL_INCONSISTENCY',jobState:j.state,reviewStates:reviews.map(x=>x.state),localMerge:j.localMerge||null};
 }
 const last=plans.at(-1);
 if(last?.status==='PLANNING' && last.updatedAt && Date.now()-Date.parse(last.updatedAt)>Math.max(staleMs,Number(last.timeoutMs||0)))return {type:'PLANNER_STALLED',plan:{id:last.id,status:last.status,updatedAt:last.updatedAt,timeoutMs:last.timeoutMs}};
 if(last?.status==='FAILED'&&!tasks.some(x=>x.state==='QUEUED'||x.state==='RUNNING'))return {type:'PLANNER_FAILED',plan:{id:last.id,error:last.error}};
 if(j.localMerge?.status==='failed')return {type:'LOCAL_MERGE_FAILED',localMerge:j.localMerge};
 const active=tasks.filter(x=>x.state==='QUEUED'||x.state==='RUNNING');
 const stale=active.filter(x=>{const recent=[x.updatedAt,x.createdAt,state.lastEventAt].filter(Boolean).map(v=>Date.parse(v)).filter(Number.isFinite);if(!recent.length)return false;const deadline=Math.max(staleMs,Number(x.timeoutMs||0)+30000);return Date.now()-Math.max(...recent)>deadline;});
 if(!active.length && state.lastEventAt && Date.now()-Date.parse(state.lastEventAt)>staleMs)return {type:'NO_PROGRESS',jobState:j.state,taskStates:tasks.map(x=>({id:x.id,state:x.state}))};
 if(stale.length)return {type:'STALLED',tasks:stale.map(x=>({id:x.id,state:x.state,executionId:x.executionId,updatedAt:x.updatedAt,timeoutMs:x.timeoutMs}))};
 return null;
}

let working=false;
async function tick(){
 if(working)return;working=true;
 try{
  const newEvents=events();
  // Worker-reported timestamps are not trusted for liveness.
  if(newEvents.length)state.lastEventAt=new Date().toISOString();
  for(const item of newEvents){
    const e=item.event||{};
    if((e.type==='task.failed'||e.type==='task.blocked')&&!String(e.task_id||'').startsWith('troubleshoot-'))state.evidence.workerFailedOrBlocked=true;
    if(e.type==='troubleshooter.created')state.evidence.troubleshooterCreated=true;
    if(e.type==='task.completed'&&String(e.task_id||'').startsWith('troubleshoot-'))state.evidence.troubleshooterSucceeded=true;
    if(e.type==='review.changes_required'){
      state.evidence.reviewChangesRequired=Number(state.evidence.reviewChangesRequired||0)+1;
      const head=reviewHeadSha(e);
      if(head&&!state.evidence.reviewHeads.includes(head))state.evidence.reviewHeads.push(head);
    }
    if(e.type==='review.approved')state.evidence.reviewApproved=Number(state.evidence.reviewApproved||0)+1;
    if(e.type==='recovery.exhausted')state.evidence.recoveryExhausted=Number(state.evidence.recoveryExhausted||0)+1;
  }
  if(state.pendingTransferId){
   const statusPath=join(process.env.NEOY_DATA_DIR||join(homedir(),'Library/Application Support/NeoY'),'xchat-lifecycle',state.pendingTransferId+'.status.json');
   try{
    const transfer=JSON.parse(readFileSync(statusPath,'utf8'));
    if(transfer.status==='completed'){
     state.delivered=true;state.pendingTransferId=null;state.phase='awaiting_repair';
     console.log(JSON.stringify({event:'handoff_delivered',at:new Date().toISOString()}));
    }else if(transfer.status==='failed'){
     state.delivered=false;state.pendingTransferId=null;state.phase='monitoring';
     console.error('handoff failed:',transfer.error);
    }
   }catch(error){console.error('handoff status unavailable:',error.message)}
  }
  const j=snapshot();
  if(abnormalStatuses.has(j.runtimeStatus)&&state.lastObservedRuntimeStatus!==j.runtimeStatus&&!pendingAbnormalStatus){
    pendingAbnormalStatus={from:state.lastObservedRuntimeStatus||'UNKNOWN',to:j.runtimeStatus,updatedAt:j.updatedAt};
  }
  state.lastObservedRuntimeStatus=j.runtimeStatus;
  if(scenario.startsWith('005-') && j.state!=='CANCELLED'){
    const terminationPath=join(dirname(statePath),'terminated.json');
    const stalePath=join(dirname(statePath),'stale-replayed.json');
    const step=scenario005Decision(j,newEvents,terminationPath,stalePath);
    if(step.action==='terminate'){
      const e=step.event;
      const run=spawnSync(process.execPath,[join(root,'e2e/runner/inject.mjs'),'--scenario',scenario,'--job',jobId,'--phase','terminate-from-event','--task',e.task_id,'--execution',e.data.executionId,'--pid',String(e.data.pid),'--out',terminationPath],{encoding:'utf8',cwd:root,timeout:15000});
      if(run.status!==0)state.scenario005Issue={type:'INJECTION_FAILED',message:run.stderr||run.error?.message||'worker termination failed'};
      else console.log(JSON.stringify({event:'scenario_action',action:'terminate-worker',jobId,taskId:e.task_id}));
    }else if(step.action==='replay'){
      const run=spawnSync(process.execPath,[join(root,'e2e/runner/inject.mjs'),'--scenario',scenario,'--job',jobId,'--phase','replay-stale-terminal','--receipt',terminationPath,'--out',stalePath],{encoding:'utf8',cwd:root,timeout:20000});
      if(run.status!==0)state.scenario005Issue={type:'STALE_INJECTION_FAILED',message:run.stderr||run.error?.message||'stale replay failed'};
      else console.log(JSON.stringify({event:'scenario_action',action:'replay-stale-terminal',jobId}));
    }
    if(step.issue)state.scenario005Issue=step.issue;
  }
  const github=githubCapability();
  if(j.state==='CANCELLED'&&existsSync(expectedCancelPath)){
    state.phase='superseded';state.supersededAt=new Date().toISOString();state.fingerprint=null;state.pendingTransferId=null;save(statePath,state);console.log(JSON.stringify({event:'e2e_superseded',repo,jobId,scenario}));process.exit(0);return;
  }
  if((j.tasks||[]).some(x=>x.agentName!=='troubleshooter'&&x.agentName!=='reviewer'&&Number(x.attempt)>=2))state.evidence.originalRetried=true;
  let issue=state.scenario005Issue||detect(j);
  // An abnormal computed status is a decision point even when recovery is expected.
  // Never turn it into a forced repair/cancellation without human/model judgment.
  if(pendingAbnormalStatus){
    const transition=pendingAbnormalStatus;pendingAbnormalStatus=null;
    const statusKey=`${transition.from}->${transition.to}@${transition.updatedAt||''}`;
    if(state.lastAbnormalStatusKey!==statusKey){
      const payload={kind:'runtime_status_judgment',observedAt:new Date().toISOString(),repo,jobId,scenario,branch,
        transition,computedStatus:j.runtimeStatus,jobState:j.state,issue:issue||null,
        plans:(j.plans||[]).map(p=>({id:p.id,status:p.status,error:p.error})),
        tasks:(j.tasks||[]).map(t=>({id:t.id,state:t.state,attempt:t.attempt,agent:t.agentName,parentTaskId:t.parentTaskId,error:t.error})),
        events:newEvents.slice(-15).map(x=>({type:x.event?.type,taskId:x.event?.task_id,message:x.event?.message}))};
      const transitionPath=join(dirname(statePath),'abnormal-status-handoff.json');save(transitionPath,payload);
      if(handoffCommand){
        const delivery=spawnSync(handoffCommand,[transitionPath],{encoding:'utf8',cwd:root,timeout:30000,env:{...process.env,...(threadId?{E2E_CHATGPT_THREAD_ID:threadId}:{})}});
        if(delivery.status===0){
          state.lastAbnormalStatusKey=statusKey;
          console.log(JSON.stringify({event:'abnormal_runtime_status_handoff',jobId,transition,delivery:'submitted'}));
        }else console.error('abnormal status handoff failed:',delivery.stderr||delivery.error?.message||delivery.status);
      }
    }
  }
  // Scenario 005 deliberately kills its first implementation execution.
  // A failed original Task with a matching termination receipt is expected while
  // Graph-owned Troubleshooter recovery is active; never manually retry it.
  if(scenario.startsWith('005-') && issue?.type==='TASK_FAILED' && existsSync(join(dirname(statePath),'terminated.json'))){
    const receipt=JSON.parse(readFileSync(join(dirname(statePath),'terminated.json'),'utf8'));
    const original=(j.tasks||[]).find(t=>t.id===receipt.taskId);
    const recovery=(j.tasks||[]).filter(t=>t.agentName==='troubleshooter'&&t.parentTaskId===receipt.taskId);
    const expectedFailure=original?.attempt===1 && original?.state==='FAILED' &&
      original?.executionHistory?.some(e=>e.id===receipt.executionId) &&
      issue.tasks?.every(t=>t.id===receipt.taskId);
    if(expectedFailure && recovery.some(t=>['DRAFT','QUEUED','RUNNING','SUCCEEDED'].includes(t.state)))issue=null;
  }
  let external=null;
  const boundPr=Number(j.externalPrNumber||j.prNumber||0);
  if(!issue&&github.enabled&&github.authenticated===false)issue={type:'GITHUB_AUTH_UNAVAILABLE',message:github.error||'GitHub is enabled but authentication is unavailable'};
  if(!issue&&github.enabled&&boundPr<=0){
    const age=Date.now()-Date.parse(j.createdAt||new Date().toISOString());
    if(age>60000)issue={type:'GITHUB_PR_NOT_CREATED',message:'GitHub is enabled but this Job has no external PR binding after 60s'};
  }
  if(j.state==='COMPLETED'&&!issue&&github.enabled){
    if(boundPr<=0)issue={type:'GITHUB_PR_NOT_CREATED',message:'GitHub is enabled but completed Job has no external PR binding'};
    else {
      external=externalJobSnapshot(j);
      if(external?.error)issue={type:'GITHUB_VERIFICATION_UNAVAILABLE',message:external.error,prNumber:boundPr};
      else if(external?.githubState!=='MERGED'){
        const now=new Date().toISOString();
        state.evidence.projectionPendingSince ??= now;
        const pendingMs=Date.now()-Date.parse(state.evidence.projectionPendingSince);
        if(pendingMs>=30000)issue={type:'GITHUB_PR_NOT_MERGED',prNumber:boundPr,githubState:external?.githubState||'UNKNOWN',pendingMs};
      } else {
        state.evidence.projectionPendingSince=null;
      }
    }
  } else if(j.state!=='COMPLETED') state.evidence.projectionPendingSince=null;
  if(!issue&&scenario.startsWith('005-')&&j.state==='COMPLETED'&&!scenario005PassEligible(join(dirname(statePath),'terminated.json'),join(dirname(statePath),'stale-replayed.json'))){
    issue={type:'SCENARIO_005_EVIDENCE_MISSING',message:'Job completed without both real worker termination and stale-generation injection receipts'};
  }
  const externalReady=!github.enabled || external?.githubState==='MERGED';
  if(j.state==='COMPLETED'&&!issue&&externalReady){
    state.phase='passed';state.passedAt ??= new Date().toISOString();state.external=external;state.fingerprint=null;
    save(statePath,state);
    if(handoffCommand && !state.passHandoffDelivered){
      const passPayload={kind:'scenario_pass',observedAt:new Date().toISOString(),repo,jobId,scenario,branch,prNumber:boundPr,jobState:j.state,githubState:external?.githubState,evidence:state.evidence};
      save(handoffPath,passPayload);
      const delivery=spawnSync(handoffCommand,[handoffPath],{encoding:'utf8',cwd:root,timeout:120000,env:{...process.env,...(threadId?{E2E_CHATGPT_THREAD_ID:threadId}:{})}});
      if(delivery.status===0){
        try{const receipt=JSON.parse(delivery.stdout.trim().split('\n').at(-1));state.passHandoffDelivered=receipt.status==='submitted'||receipt.status==='scheduled';}
        catch(error){console.error('invalid PASS handoff receipt:',error.message)}
      }else console.error('PASS handoff failed:',delivery.stderr||delivery.error?.message||delivery.status);
      save(statePath,state);
      if(!state.passHandoffDelivered)return;
    }
    console.log(JSON.stringify({event:'e2e_pass',repo,jobId,scenario,evidence:state.evidence,external,handoffDelivered:!!state.passHandoffDelivered}));
    process.exit(0);return;
  }
  if(state.phase==='passed')state.phase='monitoring';
  if(!issue && state.phase==='awaiting_repair'){state.phase='monitoring';state.fingerprint=null;state.delivered=false;state.pendingTransferId=null;}
  if(issue){
   const fingerprint=JSON.stringify(issue);
   if(state.pendingTransferId) {save(statePath,state);return;}
   if(fingerprint!==state.fingerprint || (!state.delivered && !state.pendingTransferId && handoffCommand && (!state.lastHandoffAt || Date.now()-Date.parse(state.lastHandoffAt)>60000))){
    const payload={observedAt:new Date().toISOString(),repo,pr:Number(pr)||0,jobId,branch,issue,events:newEvents.slice(-15).map(e=>({cursor:e.cursor,type:e.event.type,taskId:e.event.task_id,message:e.event.message,timestamp:e.event.timestamp})),instruction:'Fix this in the existing ChatGPT thread: confirm root cause, directly edit existing branch, test, commit each fix, rerun E2E. Do not use Agents Relay Job/Task for repairs.'};
    save(handoffPath,payload);state.fingerprint=fingerprint;state.delivered=false;state.lastHandoffAt=new Date().toISOString();
    if(handoffCommand){
      const result=spawnSync(handoffCommand,[handoffPath],{encoding:'utf8',cwd:root,timeout:30000,env:{...process.env,...(threadId?{E2E_CHATGPT_THREAD_ID:threadId}:{})}});
      if(result.status===0){
        try{
          const receipt=JSON.parse(result.stdout.trim().split('\n').at(-1));
          if(receipt.status==='scheduled'&&receipt.transfer_id)state.pendingTransferId=receipt.transfer_id;
          else if(receipt.status==='submitted')state.delivered=true;
          else throw Error('missing successful transfer receipt');
        }catch(error){console.error('invalid handoff receipt:',error.message)}
      }else console.error('handoff failed',result.stderr||result.error?.message||result.status);
    }
    console.log(JSON.stringify({event:'incident',issue:issue.type,delivered:state.delivered,handoff:handoffPath}));
   }
  }
  save(statePath,state);
 }catch(e){console.error('sentinel error:',e.message)}
 finally{working=false}
}
console.log(JSON.stringify({event:'started',repo,pr:Number(pr)||0,jobId,scenario,branch,deliveryConfigured:!!handoffCommand}));
await tick();
if(!argv.includes('--once')){
  const runtime=resolveEventsBusRuntime();
  const statusBus=new NatsEventBus(runtime.natsUrl,runtime.subjectPrefix);
  await statusBus.subscribe(jobId,async event=>{
    if(event.type!=='job.runtime_status.changed')return;
    if(abnormalStatuses.has(event.data?.to))pendingAbnormalStatus={from:event.data?.from,to:event.data?.to,updatedAt:event.data?.updatedAt};
    console.log(JSON.stringify({event:'runtime_status_change',jobId,from:event.data?.from,to:event.data?.to}));
    await tick();
  });
  // Keep a low-frequency safety check for missed ephemeral events and liveness deadlines.
  setInterval(tick,Math.max(30000,intervalMs));
}
