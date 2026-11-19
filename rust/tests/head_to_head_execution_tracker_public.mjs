// Both public original Node execution-process-tracker APIs compared to Rust,
// using only fake PID or completed records; never signals any live group.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {monitorExecutionProcess,reclaimStaleExecutionProcess}
  from '../../dist/execution-process-tracker.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
let seed=0x717c0;function rnd(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
const choices=xs=>xs[rnd()%xs.length];
const fixtures=[];
const child=spawn('/bin/sleep',['20'],{detached:true,stdio:'ignore'});
assert.ok(child.pid>1);
test.after(()=>{
  try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
});
await new Promise(resolve=>setTimeout(resolve,120));
for(let i=0;i<10;i++)fixtures.push({op:'certExecutionTracker',method:'monitor',
    jobId:'17',taskId:String(i+700),executionId:'real-exec-'+i,
    owner:'isolated-owned-process',pid:child.pid});
for(let i=0;i<70;i++){
  fixtures.push({op:'certExecutionTracker',method:'monitor',
    jobId:'17',taskId:String(i+2),executionId:'exec-'+i,
    owner:'isolated-owner',pid:choices([null,0,-1,-23,-2024])});
}
for(let i=0;i<100;i++){
  const task={id:String(i+2),jobId:'17',
    state:choices(['QUEUED','RUNNING','FAILED','SUCCEEDED']),
    executionId:choices([null,'', 'exec-'+i]),
    leaseOwner:choices([null,'isolated-owner','relayd-999999999'])};
  const record=choices([null,
    {pid:999999999,pgid:999999999,host:'test',endedAt:'2026-11-19T00:00:00.000Z'},
    {pid:999999999,pgid:999999999,host:'test',startToken:'not-a-live-process'}]);
  fixtures.push({op:'certExecutionTracker',method:'reclaim',task,
    currentOwner:choices(['isolated-owner','other','relayd-999999999',null]),record});
}
async function original(f){
  if(f.method==='monitor'){
    const saved=[];
    const store={recordExecutionProcess:async(record)=>{saved.push(record);}};
    const execution={pid:f.pid??undefined,promise:new Promise(()=>{})};
    await monitorExecutionProcess(store,f.jobId,f.taskId,f.executionId,f.owner,execution);
    return {saved};
  }
  let loadCalls=0;
  const store={loadExecutionProcess:async()=>{loadCalls++;return f.record;}};
  const reclaim=await reclaimStaleExecutionProcess(store,f.task,f.currentOwner??undefined);
  return {reclaim,loadCalls};
}
test('180 original Node/Rust process registration and stale-generation safety paths',async()=>{
  const expected=[];
  for(const fixture of fixtures){
    try{expected.push({ok:true,value:await original(fixture)});}
    catch(error){expected.push({ok:false,error:error.message});}
  }
  const p=spawnSync(binary,[],{cwd:root,
    input:fixtures.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',
    timeout:120000,maxBuffer:10*1024*1024});
  assert.equal(p.status,0,p.stderr);
  const actual=p.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(actual.length,fixtures.length);
  const mismatches=[];
  const normalize=value=>JSON.parse(JSON.stringify(value, (key,v)=>{
    if(key==='observedAt'&&typeof v==='string')return '<time>';
    return v;
  }));
  for(let i=0;i<fixtures.length;i++){
    try{assert.deepEqual(normalize(actual[i]),normalize(expected[i]));}
    catch{mismatches.push({i,fixture:fixtures[i],expected:expected[i],rust:actual[i]});}
  }
  assert.deepEqual(mismatches.slice(0,4),[],`${mismatches.length} execution process tracker mismatches`);
  console.log('Verified',fixtures.length,'original Node/Rust process tracker cases');
});
