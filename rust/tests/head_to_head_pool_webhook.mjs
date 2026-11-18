// Node/Rust Github transport observation: published events are never a Job wake.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {RepositoryWorkerPool} from '../../dist/pool.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const job={id:'job-11',repository:'org/proj',prNumber:7};
const wake={deliveryId:'delivery-1',event:'workflow_run',action:'completed'};
const published={package:'@sample/pkg',version:'1.2.0',registry:'npm',sha:'abc'};
const failed={runId:'812',stage:'publish',reason:'forbidden'};
const cases=[
 {job,wake},
 {job,wake:{...wake,publication:published}},
 {job,wake:{...wake,publishFailure:failed}},
 {job,wake:{...wake,publication:published,publishFailure:failed}},
 {job,wake:{...wake,publication:{package:'pkg',version:'1.0'}}},
 {job,wake:{...wake,publication:{package:'pkg',version:'1.0',registry:null,sha:null}}},
 {job,wake:{...wake,publishFailure:{runId:'812',stage:'upload'}}},
 {job,wake:{...wake,publication:published,publishFailure:failed},failAt:0},
 {job,wake:{...wake,publication:published,publishFailure:failed},failAt:1},
 {job,wake:{...wake,publication:published,publishFailure:failed},failAt:2},
 {job,wake:{...wake,publication:published,publishFailure:failed},bus:false},
 {job,wake,bus:false},
];
function normalized(record){
 // JSON bridge drops Node's undefined-valued optional Event data keys.
 record=JSON.parse(JSON.stringify(record));
 return {
  outcome:record.outcome,
  events:record.events.map(({timestamp,event_id,...event})=>({
   ...event,event_id:event_id?.startsWith('github:')?event_id:'<uuid>'
  }))
 };
}
async function node(f){
 const events=[];
 const pool=new RepositoryWorkerPool(2,()=>({}),async()=>[],async()=>null);
 const bus={publish:async event=>{
  if(events.length===f.failAt)throw Error('Fixture publish failure');
  events.push(structuredClone(event));
 }};
 let outcome={ok:true};
 try{await pool.webhookWake(f.bus===false?undefined:bus,f.job,f.wake);}
 catch(error){outcome={ok:false,error:error.message};}
 return {outcome,events};
}
test('Node/Rust Pool webhookWake event ordering, payload and fail-fast',async()=>{
 const expected=[];
 for(const scenario of cases)expected.push(normalized(await node(scenario)));
 const result=spawnSync(bin,[],{cwd:root,encoding:'utf8',timeout:120000,
  input:cases.map(f=>JSON.stringify({op:'apiPoolWebhook',...f})).join('\n')+'\n'});
 assert.equal(result.status,0,result.stderr||result.error?.message);
 const actual=result.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,cases.length);
 const diffs=[];
 for(let i=0;i<cases.length;i++){
  try{assert.deepEqual(normalized(actual[i].value),expected[i]);}
  catch{diffs.push({i,expected:expected[i],rust:normalized(actual[i].value)});}
 }
 assert.deepEqual(diffs,[],JSON.stringify(diffs,null,2));
 console.log('Verified',cases.length,'Node/Rust Pool GitHub observation cases');
});
