// All five public original Node interactive-request APIs versus native Rust.
// A disposable in-memory store represents atomic mutation; no user review UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import * as nodeApi from '../../dist/interactive-request.js';
import {reviewRequestThreadOverride} from '../../dist/cli-review.js';
const root=resolve(import.meta.dirname,'../..');
const binary=resolve(root,'rust/target/debug/relay-rust2-parity');
const date='2026-11-18T20:00:00.000Z';
const job=(state,execution,inv)=>({id:'25',repository:'test',state,createdAt:date,updatedAt:date,
 tasks:[{id:'11',jobId:'25',kind:'work',adapter:'script',state:execution==='none'?'DRAFT':'RUNNING',
  executionId:execution==='none'?null:execution,updatedAt:date,
  ...(inv?{interactiveInvocation:{invocationId:inv.executionId,executionId:inv.executionId,
   revision:inv.executionId,status:inv.status,boundAt:date}}:{})}],plans:[]});
function normalized(value){return JSON.parse(JSON.stringify(value, (key,val)=>{
 if(['event_id','timestamp','ts','at','timestamp_ms','created_at'].includes(key))return '<generated>';
 if(typeof val==='string' && /^\d{4}-\d\d-\d\dT\d\d:/.test(val))return '<clock>';
 return val;
}));}
function runRust(rows){
 const r=spawnSync(binary,[],{cwd:root,input:rows.map(x=>JSON.stringify(x)).join('\n')+'\n',encoding:'utf8',timeout:45000,maxBuffer:4e6});
 assert.equal(r.status,0,r.stderr);
 const output=r.stdout.trim().split('\n').map(s=>JSON.parse(s));
 assert.equal(output.length,rows.length);
 return output;
}
async function runNode(f){
 try{
  const state=structuredClone(f.job);
  const store={mutateJob:async (_id,callback)=>{
   const next=await callback(structuredClone(store.value));store.value=structuredClone(next);return store.value;
  },value:state};
  let value;
  switch(f.action){
   case 'begin':{
    const receipt=await nodeApi.beginInteractiveReview(store,f.jobId,f.taskId,f.executionId);
    value={job:store.value,receipt};break;
   }
   case 'abort':{
    await nodeApi.abortInteractiveReview(store,f.jobId,f.taskId,f.executionId);
    value={job:store.value};break;
   }
   case 'template':value=nodeApi.interactiveTemplate(f.jobId,f.taskId,f.executionId);break;
   case 'waiting':value=nodeApi.interactiveWaitingEvent(f.jobId,f.taskId,f.parentTaskId??null,f.executionId);break;
   default:throw Error('unrecognized fixture');
  }
  return {ok:true,value:normalized(value)};
 }catch(error){return {ok:false,error:error.message};}
}
const fixtures=[];
for(const state of ['ACTIVE','DRAFT','COMPLETED'])for(const generation of ['gen-1','gen-2','none'])for(const inv of [null,
 {status:'awaiting_decision',executionId:'gen-1'}, {status:'approved',executionId:'gen-1'},
 {status:'changes_requested',executionId:'gen-2'},{status:'awaiting_decision',executionId:'old'}])for(const action of ['begin','abort']){
 fixtures.push({op:'certInteractiveLifecycle',action,jobId:'25',taskId:'11',executionId:'gen-1',
  job:job(state,generation,inv)});
}
for(const action of ['template','waiting'])for(const parentTaskId of [null,'3']){
 fixtures.push({op:'certInteractiveLifecycle',action,jobId:'25',taskId:'11',executionId:'gen-1',parentTaskId});
}
test('original Node/Rust interactive review begin/abort/template/waiting 94 cases',async()=>{
 const rust=runRust(fixtures);
 for(let n=0;n<fixtures.length;n++){
  const actual=rust[n].ok?{ok:true,value:normalized(rust[n].value)}:rust[n];
  const expected=await runNode(fixtures[n]);
  assert.deepEqual(actual,expected,`Interactive fixture ${n}: ${JSON.stringify(fixtures[n])}`);
 }
});
test('original Node/Rust review thread override input validation',()=>{
 const args=[[],['--repo','fixture'],['--thread-id',''],['--thread-id','test-1234'],
  ['--thread-id','https://chatgpt.com/c/fixture-valid-12345'],
  ['--thread-id','thread_fixture_12345'],['--thread-id','https://chatgpt.com/c/'],
  ['--thread-id','http://example.com/test'],['--thread-id','test id'],
  ['--thread-id','test-123456','--thread-id','other-123456']];
 const rows=args.map(args=>({op:'certCliReviewThread',args}));const rust=runRust(rows);
 for(let i=0;i<args.length;i++){
  let expected;try{expected={ok:true,value:reviewRequestThreadOverride(args[i])??null};}
  catch(error){expected={ok:false,error:error.message};}
  assert.deepEqual(rust[i],expected,`Review thread override ${JSON.stringify(args[i])}`);
 }
});
