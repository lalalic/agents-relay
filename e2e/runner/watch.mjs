#!/usr/bin/env node
// Outside Agents Relay: detects true E2E failures and hands off evidence.
import {spawnSync} from 'node:child_process';
import {openSync, closeSync, readSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {homedir} from 'node:os';
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
let state={runKey,scenario,offset:0,lastEventAt:null,fingerprint:null,delivered:false,pendingTransferId:null,phase:'monitoring',evidence:{workerFailedOrBlocked:false,troubleshooterCreated:false,troubleshooterSucceeded:false,originalRetried:false}};
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
 try{const status=JSON.parse(p.stdout);return {enabled:status.githubEnabled===true,status};}catch(error){return {enabled:false,error:error.message};}
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
function detect(j){
 const tasks=j.tasks||[],plans=j.plans||[];
 const work=tasks.filter(x=>x.kind==='work'&&x.agentName!=='reviewer'&&x.agentName!=='troubleshooter');
 const reviews=tasks.filter(x=>x.agentName==='reviewer'||x.review?.role);
 if(j.state==='CANCELLED')return {type:'UNEXPECTED_CANCELLED',jobState:j.state};
 if(scenario.startsWith('002-')){
  const specific=scenario002(j);
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
  const github=githubCapability();
  if(j.state==='CANCELLED'&&existsSync(expectedCancelPath)){
    state.phase='superseded';state.supersededAt=new Date().toISOString();state.fingerprint=null;state.pendingTransferId=null;save(statePath,state);console.log(JSON.stringify({event:'e2e_superseded',repo,jobId,scenario}));process.exit(0);return;
  }
  if((j.tasks||[]).some(x=>x.agentName!=='troubleshooter'&&x.agentName!=='reviewer'&&Number(x.attempt)>=2))state.evidence.originalRetried=true;
  let issue=detect(j);
  let external=null;
  const boundPr=Number(j.externalPrNumber||j.prNumber||0);
  if(!issue&&github.enabled&&boundPr<=0){
    const age=Date.now()-Date.parse(j.createdAt||new Date().toISOString());
    if(age>60000)issue={type:'GITHUB_PR_NOT_CREATED',message:'GitHub is enabled but this Job has no external PR binding after 60s'};
  }
  if(j.state==='COMPLETED'&&!issue&&github.enabled){
    if(boundPr<=0)issue={type:'GITHUB_PR_NOT_CREATED',message:'GitHub is enabled but completed Job has no external PR binding'};
    else {
      external=externalJobSnapshot(j);
      if(external?.error)issue={type:'GITHUB_VERIFICATION_UNAVAILABLE',message:external.error,prNumber:boundPr};
      else if(external?.githubState!=='MERGED')issue={type:'GITHUB_PR_NOT_MERGED',prNumber:boundPr,githubState:external?.githubState||'UNKNOWN'};
    }
  }
  if(j.state==='COMPLETED'&&!issue){state.phase='passed';state.passedAt=new Date().toISOString();state.external=external;state.fingerprint=null;state.delivered=false;state.pendingTransferId=null;save(statePath,state);console.log(JSON.stringify({event:'e2e_pass',repo,jobId,scenario,evidence:state.evidence,external}));process.exit(0)}
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
          if(receipt.status!=='scheduled'||!receipt.transfer_id)throw Error('missing transfer receipt');
          state.pendingTransferId=receipt.transfer_id;
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
if(!argv.includes('--once'))setInterval(tick,Math.max(2000,intervalMs));
