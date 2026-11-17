import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const {resolveExecutionContext}=await import('../dist/execution-context.js');
const {managedWorkerInput}=await import('../dist/managed-worker-input.js');
const root=resolve('.'),snapshots=mkdtempSync(join(tmpdir(),'rust2-wave3-managed-resolve-'));
const old=process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR;
process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR=snapshots;
const bin=resolve('rust/target/debug/relay-rust2-parity');
let comparisons=0;
const rust=req=>{
 const p=spawnSync(bin,[],{input:JSON.stringify({op:'deliveryWave2',case:'managedWorkerInputResolved',
  packageRoot:root,referenceDirectory:snapshots,...req})+'\n',encoding:'utf8',timeout:30000,
   env:{...process.env,AGENTS_RELAY_STORE_DIR:join(snapshots,'store')}});
 assert.equal(p.status,0,p.stderr);
 const result=JSON.parse(p.stdout);
 if(!result.ok)throw new Error(result.error);
 return result.value;
};
const capture=async fn=>{try{return {ok:true,value:await fn()}}catch(e){return {ok:false,error:e.message}}};
try {
 const context=await resolveExecutionContext(root,'worker',{globalRoot:join(snapshots,'global')});
 for(const [name,adapter,mode] of [
   ['implementation','chatgpt','evaluation'],['reviewer','chatgpt','evaluation'],
   ['planner','codex','evaluation'],['troubleshooter','codex','evaluation'],
   ['implementation','chatgpt','production']]){
   const task={id:'51',jobId:'10',adapter,agentName:name,executionId:'exec-fixture',
    title:'Offline test',input:'Inspect artifact only.',output:{kind:'file'},attempt:1,dependencies:[]};
   const job={id:'10',repository:'fixtures',state:'ACTIVE',tasks:[task],plans:[]};
   const n=await capture(()=>managedWorkerInput(job,task,context,mode));
   const r=await capture(()=>rust({job,task,context,mode}));
   assert.deepEqual(r,n,'agent '+name+' / '+adapter+' / '+mode);
   comparisons++;
 }
 let rng=0x3a7618;
 for(let i=0;i<70;i++){
   rng^=rng<<13;rng^=rng>>>17;rng^=rng<<5;
   const adapter=['chatgpt','codex','z'][rng>>>0%3] || 'chatgpt';
   const task={id:'51',jobId:'10',adapter,agentName:'implementation',
     executionId:'exec-fixture',title:'Offline test',
     input:'line '+i+' '+('x'.repeat((rng>>>8)&31)),
     output:{kind:'file'},attempt:1,dependencies:[]};
   const job={id:'10',repository:'fixtures',state:'ACTIVE',tasks:[task],plans:[]};
   const n=await capture(()=>managedWorkerInput(job,task,context,'evaluation'));
   const r=await capture(()=>rust({job,task,context,mode:'evaluation'}));
   assert.deepEqual(r,n,'random '+i);comparisons++;
 }
 console.log('PASS Rust2 Wave3 runtime Agent resolver Node/Rust direct parity '+comparisons);
}finally{
 if(old===undefined)delete process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR;
 else process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR=old;
 rmSync(snapshots,{recursive:true,force:true});
}
