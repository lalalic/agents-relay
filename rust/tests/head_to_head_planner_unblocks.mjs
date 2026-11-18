// Real Node src/planner-runtime.ts drainPlannerUnblocks/retryPendingPlannerUnblocks
// vs native Rust SQLite. External cross-Job registration is a deterministic
// injected fixture: partial failures and concurrent intent additions are kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {drainPlannerUnblocks,retryPendingPlannerUnblocks} from '../../dist/planner-runtime.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
let seed=0x931f1;function rnd(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
const pick=x=>x[rnd()%x.length];
const intent=id=>({repository:'test/repo',prNumber:7,jobId:'dependent-job',taskId:'task-'+id,resolutionMode:'merge'});
const fixtures=[];
for(let i=0;i<110;i++){
 const plans=Array.from({length:1+rnd()%3},(_,p)=>({id:'plan-'+p,
  status:pick(['PLANNING','SUCCEEDED','SUCCEEDED','FAILED']),
  pendingUnblocks:Array.from({length:rnd()%4},(_,j)=>intent((i+p+j)%7)),
  updatedAt:'2026-11-17T09:00:00.000Z'}));
 const method=pick(['drain','retry']);
 const planId=pick(plans).id;
 const failTaskIds=Array.from({length:rnd()%4},()=>('task-'+rnd()%7));
 const missingRegistration=rnd()%13===0;
 const missingMutation=!missingRegistration && rnd()%17===0;
 const concurrentAdd=!missingRegistration&&!missingMutation&&rnd()%7===0?intent('concurrent-'+i):null;
 fixtures.push({op:'plannerUnblocksParity',method,planId,failTaskIds,
  missingRegistration,missingMutation,concurrentAdd,
  job:{id:'job-'+i,title:'unblock fixture',repository:'test/repo',prNumber:0,
   state:'ACTIVE',createdAt:'2026-11-17T09:00:00.000Z',
   updatedAt:'2026-11-17T09:00:00.000Z',tasks:[],plans}});
}
fixtures.push({op:'plannerUnblocksParity',method:'drain',planId:'plan-0',failTaskIds:['task-1'],
 missingRegistration:false,missingMutation:false,concurrentAdd:intent('late-new'),
 job:{id:'race',title:'race',repository:'test/repo',state:'ACTIVE',tasks:[],plans:[
 {id:'plan-0',status:'SUCCEEDED',pendingUnblocks:[intent(1),intent(2),intent(1)]}]}});
fixtures.push({op:'plannerUnblocksParity',method:'retry',planId:'plan-0',failTaskIds:[],
 missingRegistration:false,missingMutation:false,concurrentAdd:null,
 job:{id:'retry',title:'retry',repository:'test/repo',state:'ACTIVE',tasks:[],plans:[
 {id:'plan-0',status:'SUCCEEDED',pendingUnblocks:[intent(1)]},
 {id:'plan-1',status:'FAILED',pendingUnblocks:[intent(2)]},
 {id:'plan-2',status:'SUCCEEDED',pendingUnblocks:[intent(3)]}]}});
function projection(job){return (job.plans??[]).map(plan=>({
 id:plan.id,status:plan.status,pending:plan.pendingUnblocks??null}));}
async function original(fixture){
 const store=new SQLiteRelayStore(':memory:');
 await store.saveJob(fixture.job);
 const registered=[];let injected=false;
 const ports={store:{
  load:id=>store.loadJob(id),
  ...(fixture.missingMutation?{}:{mutateJob:(id,mutator)=>store.mutateJob(id,mutator)}),
  ...(fixture.missingRegistration?{}:{registerBlockerDependent:async(id,item)=>{
   registered.push(structuredClone(item));
   if(!injected&&fixture.concurrentAdd){
    injected=true;
    await store.mutateJob(id,current=>{
     const plan=current.plans.find(plan=>plan.id===fixture.planId);
     if(plan?.pendingUnblocks)plan.pendingUnblocks.push(structuredClone(fixture.concurrentAdd));
     return current;
    });
   }
   if(fixture.failTaskIds.includes(item.taskId))throw new Error('injected dependent registration failure');
  }})
 }};
 let outcome;
 try{
  const value=fixture.method==='retry'?
    await retryPendingPlannerUnblocks(ports,fixture.job.id):
    await drainPlannerUnblocks(ports,fixture.job.id,fixture.planId);
  outcome={ok:true,value:value??null};
 }catch(error){outcome={ok:false,error:error.message};}
 const current=await store.loadJob(fixture.job.id);
 store.close();
 return {outcome,plans:projection(current),registered};
}
test('112 direct Node/Rust cross-Job pending unblock retention, concurrency and retries',async()=>{
 const expected=[];for(const fixture of fixtures)expected.push(await original(fixture));
 const input=fixtures.map(JSON.stringify).join('\n')+'\n';
 const run=spawnSync(bin,[],{cwd:root,input,encoding:'utf8',timeout:120000,maxBuffer:14*1024*1024});
 assert.equal(run.status,0,run.stderr||run.error?.message);
 const actual=run.stdout.trim().split('\n').map(JSON.parse).map(result=>result.ok?result.value:result);
 assert.equal(actual.length,fixtures.length);
 const mismatches=[];
 for(let i=0;i<fixtures.length;i++){
  try{assert.deepEqual(actual[i],expected[i]);}
  catch{mismatches.push({index:i,fixture:fixtures[i],node:expected[i],rust:actual[i]});}
 }
 assert.deepEqual(mismatches.slice(0,8),[],`${mismatches.length} mismatches / ${fixtures.length} original Node cases`);
 console.log('DIRECT_PLANNER_UNBLOCKS_NODE_RUST_PASS',fixtures.length);
});
