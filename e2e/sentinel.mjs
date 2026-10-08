#!/usr/bin/env node
// Outside Agents Relay: detects true E2E failures and hands off evidence.
import {spawnSync} from 'node:child_process';
import {openSync, closeSync, readSync, statSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {homedir} from 'node:os';
const root=resolve(import.meta.dirname,'..');
const argv=process.argv.slice(2);
const option=(k,def)=>{const i=argv.indexOf('--'+k);return i>=0?argv[i+1]:def};
const repo=option('repo','lalalic/agents-relay-e2e'),pr=String(option('pr','2'));
const jobId=option('job','e2e-autonomy-smoke-20261008');
const eventsPath=option('events','/Users/chengli/Library/Application Support/EventsBus/events.jsonl');
const statePath=option('state',resolve(root,'e2e/reports/sentinel-state.json'));
const handoffPath=option('out',resolve(root,'e2e/reports/pending-handoff.json'));
const handoffCommand=option('handoff-command',process.env.E2E_HANDOFF_COMMAND||'');
const intervalMs=Number(option('interval-ms','5000')),staleMs=Number(option('stale-ms','240000'));
const save=(p,v)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,JSON.stringify(v,null,2)+'\n')};
let state={offset:0,lastEventAt:null,fingerprint:null,delivered:false,pendingTransferId:null};
try{state={...state,...JSON.parse(readFileSync(statePath,'utf8'))}}catch{}
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
 const p=spawnSync(process.execPath,[resolve(root,'dist/cli.js'),'job','show','--repo',repo,'--pr',pr,'--id',jobId],{encoding:'utf8',cwd:root,timeout:30000,maxBuffer:8000000});
 if(p.status!==0)throw Error(p.error?.message||p.stderr||'job show failed');
 return JSON.parse(p.stdout);
}
function detect(j){
 const tasks=j.tasks||[],plans=j.plans||[];
 const failed=tasks.filter(x=>x.state==='FAILED'||x.state==='BLOCKED');
 if(failed.length)return {type:'TASK_FAILED',tasks:failed.map(x=>({id:x.id,state:x.state,error:x.error,executionId:x.executionId,attempt:x.attempt}))};
 const last=plans.at(-1);
 if(last?.status==='FAILED'&&!tasks.some(x=>x.state==='QUEUED'||x.state==='RUNNING'))return {type:'PLANNER_FAILED',plan:{id:last.id,error:last.error}};
 const active=tasks.filter(x=>x.state==='QUEUED'||x.state==='RUNNING');
 const stale=active.filter(x=>{ const recent=[x.updatedAt,x.createdAt,state.lastEventAt].filter(Boolean).map(v=>Date.parse(v)).filter(Number.isFinite);return recent.length>0 && Date.now()-Math.max(...recent)>staleMs; });
 if(stale.length)return {type:'STALLED',tasks:stale.map(x=>({id:x.id,state:x.state,executionId:x.executionId,updatedAt:x.updatedAt}))};
 return null;
}
let working=false;
async function tick(){
 if(working)return;working=true;
 try{
  const newEvents=events();
  if(newEvents.length)state.lastEventAt=newEvents.at(-1).event.timestamp||new Date().toISOString();
  if(state.pendingTransferId){
   const statusPath=join(process.env.NEOY_DATA_DIR||join(homedir(),'Library/Application Support/NeoY'),'xchat-lifecycle',state.pendingTransferId+'.status.json');
   try{
    const transfer=JSON.parse(readFileSync(statusPath,'utf8'));
    if(transfer.status==='completed'){
     state.delivered=true;state.pendingTransferId=null;
     console.log(JSON.stringify({event:'handoff_delivered',at:new Date().toISOString()}));
    }else if(transfer.status==='failed'){
     state.delivered=false;state.pendingTransferId=null;
     console.error('handoff failed:',transfer.error);
    }
   }catch(error){console.error('handoff status unavailable:',error.message)}
  }
  const j=snapshot(),issue=detect(j);
  if(issue){
   const fingerprint=JSON.stringify(issue);
   if(fingerprint!==state.fingerprint || (!state.delivered && !state.pendingTransferId && handoffCommand && (!state.lastHandoffAt || Date.now()-Date.parse(state.lastHandoffAt)>60000))){
    const payload={observedAt:new Date().toISOString(),repo,pr,jobId,branch:'fix/e2e-production-autonomy-20261008',issue,events:newEvents.slice(-15).map(e=>({cursor:e.cursor,type:e.event.type,taskId:e.event.task_id,message:e.event.message,timestamp:e.event.timestamp})),instruction:'Fix this in the existing ChatGPT thread: confirm root cause, directly edit existing branch, test, commit each fix, rerun E2E. Do not use Agents Relay Job/Task for repairs.'};
    save(handoffPath,payload);state.fingerprint=fingerprint;state.delivered=false;state.lastHandoffAt=new Date().toISOString();
    if(handoffCommand){
      const result=spawnSync(handoffCommand,[handoffPath],{encoding:'utf8',cwd:root,timeout:30000});
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
console.log(JSON.stringify({event:'started',repo,pr,jobId,deliveryConfigured:!!handoffCommand}));
await tick();
if(!argv.includes('--once'))setInterval(tick,Math.max(2000,intervalMs));
