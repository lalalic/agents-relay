// Node/Rust managed prompt assembly parity with an isolated immutable snapshot
// directory. The Rust input uses the SAME canonical Node contract resolver
// output, so this only validates the post-resolve port (no live workers).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const {resolveExecutionContext,resolveAgentContract}=await import('../dist/execution-context.js');
const {managedWorkerInput}=await import('../dist/managed-worker-input.js');
const root=resolve('.'),snapshots=mkdtempSync(join(tmpdir(),'rust2-managed-prompt-'));
const oldDir=process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR;
process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR=snapshots;
const rust=resolve('rust/target/debug/relay-rust2-parity');
let assertions=0;
function run(req) {
 const p=spawnSync(rust,[],{input:JSON.stringify({op:'deliveryWave2',case:'managedWorkerInput',
   packageRoot:root,referenceDirectory:snapshots,...req})+'\n',encoding:'utf8'});
 assert.equal(p.status,0,p.stderr);
 const data=JSON.parse(p.stdout.trim());
 if(!data.ok)throw new Error(data.error);
 return data.value;
}
async function capture(f){try{return {ok:true,value:await f()}}catch(e){return {ok:false,error:e.message}}}
try{
 const global=join(snapshots,'global');
 const context=await resolveExecutionContext(root,'worker',{globalRoot:global});
 for(const [agentName,adapter,mode] of [
  ['implementation','codex','production'],['implementation','chatgpt','production'],
  ['planner','codex','production'],['reviewer','codex','evaluation'],
  ['troubleshooter','codex','evaluation'],['implementation','codex','evaluation']
 ]) {
   const task={id:'fixture-task',jobId:'42',title:'Isolated prompt assembly',kind:'work',
    state:'QUEUED',agentName,adapter,input:'UNTRUSTED TASK payload',
    output:{kind:'task_pr'},executionId:'exec-1',attempt:1,maxAttempts:2,dependencies:[]};
   const job={id:'42',repository:'fixture-repo',title:'Fixture',state:'ACTIVE',tasks:[task],plans:[]};
   const selected=await resolveAgentContract(context,agentName);
   const n=await capture(()=>managedWorkerInput(job,task,context,mode));
   const r=await capture(()=>run({job,task,context,selected,mode}));
   assert.deepStrictEqual(r,n,'managed input '+agentName+'/'+adapter+'/'+mode);
   assertions++;
 }
 const job={id:'42',repository:'fixture',tasks:[]};
 for(const task of [
  {id:'x',adapter:'shell',input:'raw'},
  {id:'x',adapter:'chatgpt',input:'raw'},
  {id:'x',adapter:'chatgpt',input:'raw',output:{kind:'file'}},
  {id:'x',adapter:'chatgpt',input:'raw',output:{kind:'file'},executionId:'ex1'},
 ]) {
   const n=await capture(()=>managedWorkerInput(job,task));
   const r=await capture(()=>run({job,task,context:null,selected:null}));
   assert.deepStrictEqual(r,n,'managed input negative binding '+JSON.stringify(task));
   assertions++;
 }
 console.log('PASS Rust2 worker C managed worker input differential '+assertions);
}finally{
 if(oldDir===undefined)delete process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR;
 else process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR=oldDir;
 rmSync(snapshots,{recursive:true,force:true});
}
