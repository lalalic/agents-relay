import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync,spawn} from 'node:child_process';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {allocateEntityId} from '../../dist/job-task-id-sequence.js';
import {parseAgentGraph} from '../../dist/agent-graph.js';
const exe=resolve(import.meta.dirname,'../target/debug/examples/interop_fixture');
const t0='2099-01-01T00:00:00.000Z';
const graph='flowchart TD\nA[agent:visioner]\nB[agent:metadata]\nA --> C[agent:editor]\nB --> C';
const hash=createHash('sha256').update(graph).digest('hex');
function task(id){return {jobId:'91',id,parentTaskId:null,dependencies:[],capabilities:[],adapter:'orchestrator',input:JSON.stringify({scenario:'review',reviewDecision:'forged'}),
  state:'QUEUED',attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:null,
  timeoutMs:120000,createdAt:t0,updatedAt:t0,continuation:null,continuationDeliveredAt:null,agentGraph:graph};}
function invoke(op,db,at,arg){
 const result=spawnSync(exe,[op,db,'91',at,typeof arg==='string'?arg:JSON.stringify(arg)],{
  encoding:'utf8',env:{...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'},timeout:3000,
 });
 assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
function childInput(nodeId,projectPath,executor='script'){
 return {parentTaskId:'101',nodeId,executor,projectPath,timeoutMs:300000};
}
test('Rust Coordinator materializes ordinary SQLite Tasks readable by TS and completes after descendants',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-rust-authority-'));const db=join(dir,'relay.sqlite');
 writeFileSync(join(dir,'.relay-rust-authority-isolated-test'),'isolated');
 let store;
 try{
  store=new SQLiteRelayStore(db);
  await store.saveJob({id:'91',title:'Coordinator E2E',repository:'example',projectRoot:dir,
    prNumber:0,state:'ACTIVE',reviewEnabled:false,continuation:null,createdAt:t0,updatedAt:t0,tasks:[task('101')]});
  store.close();store=null;
  assert.deepEqual(parseAgentGraph(graph).waves,[['A','B'],['C']]);
  assert.deepEqual(invoke('dag-begin',db,'2099-01-01T00:00:01.000Z','101'),{started:true});
  assert.equal(invoke('dag-create',db,'2099-01-01T00:00:02.000Z',childInput('C',dir)),null);
  const a=invoke('dag-create',db,'2099-01-01T00:00:03.000Z',childInput('A',dir,'script'));
  const b=invoke('dag-create',db,'2099-01-01T00:00:04.000Z',childInput('B',dir,'model'));
  assert.equal(a.childId,'102');assert.equal(b.childId,'103');assert.equal(a.state,'QUEUED');
  assert.equal(invoke('dag-create',db,'2099-01-01T00:00:05.000Z',childInput('B',dir,'model')).childId,b.childId);
  store=new SQLiteRelayStore(db);
  let current=await store.loadJob('91');
  assert.deepEqual(current.tasks.map(t=>t.id),['101','102','103']);
  assert.equal(current.tasks[0].title,'Coordinator');
  assert.equal(current.tasks[0].result.data.dag.graphHash,hash);
  assert.deepEqual(current.tasks.slice(1).map(t=>t.state),['QUEUED','QUEUED']);
  assert.deepEqual(current.tasks.slice(1).map(t=>t.parentTaskId),['101','101']);
  assert.deepEqual(current.tasks.slice(1).map(t=>t.dagNode.graphHash),[hash,hash]);
  assert.deepEqual(current.tasks.slice(1).map(t=>t.adapter),['script','codex']);
  const child=JSON.parse(current.tasks[1].input);
  assert.equal(child.nodeId,'A');assert.equal(child.source,'relay-dag-task');
  assert.equal(child.reviewDecision,undefined,'untrusted review field must be stripped');
  assert.equal(child.taskId,'102');assert.equal(child.outputPath,current.tasks[1].output.path);
  assert.equal(current.tasks[2].workerRequirements.capabilities[0],'model');
  assert.equal(current.tasks[1].output.path,join(dir,'.relay-dag-results','91','101','.dag-node-results','102.json'));
  await store.mutateJob('91',old=>{
   for(const task of old.tasks.filter(t=>['102','103'].includes(t.id))){
    task.state='SUCCEEDED';task.result={data:{status:'COMPLETED',output:{node:task.dagNode.nodeId}}};
   }
   old.updatedAt='2099-01-01T00:00:06.000Z';return old;
  });
  store.close();store=null;
  const c=invoke('dag-create',db,'2099-01-01T00:00:07.000Z',childInput('C',dir,'model'));
  assert.equal(c.childId,'104');assert.deepEqual(c.dependencies,['102','103']);
  store=new SQLiteRelayStore(db);current=await store.loadJob('91');
  const finalInput=JSON.parse(current.tasks[3].input);
  assert.deepEqual(finalInput.predecessorOutputs,{A:{node:'A'},B:{node:'B'}});
  assert.equal(current.tasks[3].state,'QUEUED');
  assert.equal(current.tasks[3].title,'editor');
  assert.equal(allocateEntityId(join(dir,'stores'),current.repository,'task',`dag:91:101:${hash}:C`),'104');
  await store.mutateJob('91',old=>{old.tasks[3].state='SUCCEEDED';old.updatedAt='2099-01-01T00:00:08.000Z';return old;});
  store.close();store=null;
  assert.deepEqual(invoke('dag-complete',db,'2099-01-01T00:00:09.000Z','101'),{completed:true});
  store=new SQLiteRelayStore(db);
  current=await store.loadJob('91');assert.equal(current.tasks[0].state,'SUCCEEDED');
  assert.deepEqual(current.tasks[0].result.data.nodes,{A:'102',B:'103',C:'104'});
  assert.equal(current.tasks.length,4);
  console.log('Cross-language DAG: Rust begin/materialize/finish + TS read/update + scoped idempotency');
 } finally {store?.close();rmSync(dir,{recursive:true,force:true});}
});

function invokeAsync(op,db,at,arg){
 return new Promise((resolvePromise,reject)=>{
  const child=spawn(exe,[op,db,'91',at,typeof arg==='string'?arg:JSON.stringify(arg)],{
   env:{...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'},
   stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',bytes=>out+=bytes);child.stderr.on('data',bytes=>err+=bytes);
  child.once('error',reject);
  child.once('exit',code=>code===0?resolvePromise(JSON.parse(out)):reject(Error(`Rust parallel create ${code}: ${err}`)));
 });
}
test('12 Rust Coordinator ticks race for one node but create exactly one durable Task and global ID',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-rust-authority-'));const db=join(dir,'relay.sqlite');
 writeFileSync(join(dir,'.relay-rust-authority-isolated-test'),'isolated');let store;
 try{
  store=new SQLiteRelayStore(db);
  await store.saveJob({id:'91',title:'Parallel Coordinator ticks',repository:'example',projectRoot:dir,
   prNumber:0,state:'ACTIVE',reviewEnabled:false,continuation:null,createdAt:t0,updatedAt:t0,tasks:[task('101')]});
  store.close();store=null;
  invoke('dag-begin',db,'2099-01-01T00:00:01.000Z','101');
  const created=await Promise.all(Array.from({length:12},()=>invokeAsync('dag-create',db,'2099-01-01T00:00:02.000Z',childInput('A',dir))));
  assert.equal(created.filter(c=>c.created).length,1);
  assert.deepEqual([...new Set(created.map(c=>c.childId))],['102']);
  store=new SQLiteRelayStore(db);
  const rows=(await store.loadJob('91')).tasks;
  assert.equal(rows.length,2);
  assert.equal(rows[1].dagNode.nodeId,'A');
  assert.equal(rows[1].state,'QUEUED');
  assert.equal(allocateEntityId(join(dir,'stores'),'example','task',`dag:91:101:${hash}:A`),'102');
  assert.equal(allocateEntityId(join(dir,'stores'),'example','task',`dag:91:101:${hash}:B`),'103');
  console.log('Concurrent Rust DAG writers: 12 contenders, 1 durable child, no duplicated global Task ID');
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
