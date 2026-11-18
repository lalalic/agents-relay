// Direct Node Reconciler.recoverLostExecutions vs Rust generation-fenced
// execution recovery, native Graph transitions and Store effect recording.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {Reconciler} from '../../dist/reconciler.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const now=Date.parse('2026-11-18T17:00:00.000Z');
const before='2026-11-18T10:00:00.000Z',after='2026-11-18T22:00:00.000Z';
const makeTask=(id='task-1',state='RUNNING',attempt=1,maxAttempts=3,expiry=before)=>({
 id,jobId:'41',kind:'work',state,adapter:'codex',attempt,maxAttempts,
 executionId:`e-${id}`,leaseOwner:'old-worker',leaseExpiresAt:expiry,
 dependencies:[],capabilities:[],createdAt:before,updatedAt:before,
 error:null,report:null,result:null
});
const job=(tasks=[])=>({id:'41',repository:'fixture',prNumber:0,
 state:'ACTIVE',title:'Recover test',priority:'P2',createdAt:before,
 updatedAt:before,tasks,plans:[],reviewEnabled:false,headSha:'head'});
const cases=[
 {job:job()},
 {job:job([makeTask()])},
 {job:job([makeTask('maxed','RUNNING',3,3)])},
 {job:job([makeTask('future','RUNNING',2,3,after)])},
 {job:job([makeTask('queued','QUEUED',1,3)])},
 {job:job([{...makeTask('plan'),'kind':'planner'}])},
 {job:job([makeTask('terminal','SUCCEEDED')])},
 {job:job([{...makeTask('missing'),leaseExpiresAt:null}])},
 {job:job([makeTask('mismatch')]),currentJob:job([{...makeTask('mismatch'),executionId:'new-generation'}])},
 {job:job([makeTask('leasechanged')]),currentJob:job([{...makeTask('leasechanged'),leaseExpiresAt:after}])},
 {job:job([makeTask('invalid','RUNNING',1,3,'not-a-date')])},
 {job:job([makeTask('multiple'),makeTask('future','RUNNING',1,3,after),makeTask('maxed','RUNNING',3,3)])},
 {job:job([makeTask('boundary','RUNNING',1,3,new Date(now).toISOString())])},
];
function rust(fixtures){
 const result=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:120000,
  input:fixtures.map(f=>JSON.stringify({op:'apiReconcilerRecovery',root,now,...f})).join('\n')+'\n',maxBuffer:10*1024*1024});
 assert.equal(result.status,0,result.stderr||result.error?.message);
 const lines=result.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(lines.length,fixtures.length);
 return lines.map(line=>line.value);
}
async function node(f){
 let current=structuredClone(f.currentJob??f.job);
 const calls=[],events=[];
 const store={
  load:async id=>{assert.equal(id,'41');calls.push(['load']);return structuredClone(current);},
  saveTask:async task=>{
   calls.push(['saveTask',task.id]);
   const pos=current.tasks.findIndex(entry=>entry.id===task.id);
   if(pos>=0)current.tasks[pos]=structuredClone(task);
  },
  loadExecutionProcess:async (jobId,taskId,executionId)=>{
   assert.equal(jobId,'41');assert.equal(executionId,`e-${taskId}`);
   calls.push(['reclaim',taskId]);return null;
  }
 };
 const reconciler=new Reconciler(store,{owner:'fixture',adapters:[],
  emit:async event=>{events.push({type:event.type,task_id:event.task_id,
   reason:event.data?.reason??null});}});
 let outcome={ok:true};
 try{await reconciler.recoverLostExecutions(structuredClone(f.job),now);}
 catch(error){outcome={ok:false,error:error.message};}
 await reconciler.close();
 return {outcome,job:current,calls,events};
}
function normalize(value){
 if(Array.isArray(value))return value.map(normalize);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
  .map(([k,v])=>[k,/At$/.test(k)&&typeof v==='string'&&/^20\d\d-/.test(v)?'<time>':normalize(v)]));
 return value;
}
test('Reconciler.recoverLostExecutions respects generation ownership and canonical Graph retry/failure',async()=>{
 const actual=rust(cases).map(normalize);
 const expected=[];
 for(const fixture of cases)expected.push(normalize(await node(fixture)));
 const diffs=[];
 for(let i=0;i<cases.length;i++){
  try{assert.deepEqual(actual[i],expected[i]);}
  catch{diffs.push({i,fixture:cases[i],expected:expected[i],actual:actual[i]});}
 }
 assert.deepEqual(diffs,[],JSON.stringify(diffs,null,2));
 console.log('Verified',cases.length,'Reconciler lost execution recovery Node/Rust cases');
});
