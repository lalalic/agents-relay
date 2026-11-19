// Exact original Node src/manual-plan.ts executeManualPlan vs native Rust port.
// Injected atomic store / launch; never starts a real Planner or Job.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {resolve} from 'node:path';
import {executeManualPlan} from '../../dist/manual-plan.js';
const root=resolve(import.meta.dirname,'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');
const stamp='2026-11-18T20:00:00.000Z';
const task=(state)=>({id:'2',jobId:'17',kind:'work',state,agentName:'implementation',
 adapter:'script',dependencies:[],attempt:0,maxAttempts:1,createdAt:stamp,updatedAt:stamp});
const job=(state,mode)=>({id:'17',repository:'fixture',prNumber:0,projectRoot:'/tmp/fixture',
 state,createdAt:stamp,updatedAt:stamp,tasks:[task('SUCCEEDED')],
 plans:mode==='pending'||mode==='leased'?[{id:'plan-1',jobId:'17',round:1,status:'PLANNING',
   executionId:mode==='leased'?'execution-1':null,manualPlanning:true,
   attempt:0,createdAt:stamp,updatedAt:stamp}]:[]});
const fixtures=[];
for(const state of ['ACTIVE','PAUSED','DRAFT','COMPLETED','CANCELLED'])
 for(const mode of ['pending','leased','none'])
 for(const forceRestate of [false,true])
 for(const terminalStatus of ['SUCCEEDED','FAILED']){
 fixtures.push({op:'certManualPlan',job:job(state,mode),jobId:'17',
  guidance:'Review the objective',timeoutMs:5000,forceRestate,atomic:true,terminalStatus});
}
for(const mode of ['pending','none'])for(const forceRestate of [false,true])
 fixtures.push({op:'certManualPlan',job:job('ACTIVE',mode),jobId:'17',
  guidance:'Retry after launch failure',timeoutMs:5000,forceRestate,atomic:true,failLaunch:true});
function normalize(value){return JSON.parse(JSON.stringify(value,(key,v)=>{
 if(['createdAt','updatedAt','boundAt','lastUpdatedAt','startedAt','completedAt'].includes(key)&&typeof v==='string')return '<clock>';
 return v;
}));}
function rust(){const p=spawnSync(bin,[],{cwd:root,input:fixtures.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',timeout:75000,maxBuffer:6e6});assert.equal(p.status,0,p.stderr);return p.stdout.trim().split('\n').map(JSON.parse);}
async function node(f){
 let current=structuredClone(f.job),count=0;
 const store={load:async()=>structuredClone(current),
  mutateJob:async(_id,change)=>{current=structuredClone(await change(structuredClone(current)));return structuredClone(current);}};
 try{
  const result=await executeManualPlan(store,'17',f.guidance,f.timeoutMs,
   async (job,round)=>{
    count++;if(f.failLaunch)throw Error('injected Planner transport failure');
    const plan=current.plans.find(x=>x.id===round.id);
    plan.status=f.terminalStatus; if(f.terminalStatus==='FAILED')plan.error='injected Planner failure';
   },f.forceRestate);
  return {ok:true,value:normalize({...result,launched:count})};
 }catch(error){return {ok:false,error:error.message};}
}
test('original Node/Rust atomic manual Planner lifecycle and injection/retry fences',async()=>{
 const a=rust();assert.equal(a.length,fixtures.length);
 for(let i=0;i<fixtures.length;i++){
  const expected=await node(fixtures[i]);
  const actual=a[i].ok?{ok:true,value:normalize(a[i].value)}:a[i];
  assert.deepEqual(actual,expected,`manual-plan fixture ${i}: ${JSON.stringify(fixtures[i])}`);
 }
 console.log(`${fixtures.length} source Node/Rust manual Planner admission/round/terminal cases`);
});
