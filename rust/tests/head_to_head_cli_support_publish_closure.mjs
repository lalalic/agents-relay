// Exact Node src/cli-support.ts Graph-selected observation effects vs Rust.
// Uses two in-memory event buses. No NATS, live daemon, SQLite or Task state.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {MemoryEventBus} from '../../dist/events.js';
import {
  publishWake,publishTaskUnblocked,publishTaskBlocked,
  publishDependentUnblocked,requestManagedReconciliation,
} from '../../dist/cli-support.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
let seed=0x70513;
function rnd(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
const pick=values=>values[rnd()%values.length];
const fixtures=[];
for(let i=0;i<95;i++){
 const job={id:String(100+i),repository:pick(['toy','demo','x/y','']),prNumber:pick([0,1,20,null])};
 const targets=Array.from({length:rnd()%5},(_,j)=>({
  jobId:String(100+i),taskId:String(j+1),repository:'toy',prNumber:j+1}));
 const actions=Array.from({length:18},()=>{
  const method=pick(['wake','unblock','block','dependent','none','require','requireNone']);
  return {method,job,taskId:pick(['1','2','3']),reason:pick(['review','error','needs-input','']),
    message:pick(['queued','test','中文','']),
    targets,extra:pick([undefined,{}, {data:'x'}, {repository:'override',reason:'from-data'}, {prNumber:null}])};
 });
 fixtures.push({op:'cliSupportEventPublishing',actions});
}
async function runNode(fixture){
 const bus=new MemoryEventBus(),events=[],receipts=[];
 await bus.subscribeAll(async event=>{
  const normalized=JSON.parse(JSON.stringify(event));
  normalized.event_id='NORMALIZED';normalized.timestamp='NORMALIZED';
  events.push(normalized);
 });
 for(const a of fixture.actions){
  if(a.method==='wake')await publishWake(bus,a.job,a.taskId,a.message);
  else if(a.method==='unblock')await publishTaskUnblocked(bus,a.job,a.taskId,a.reason);
  else if(a.method==='block')await publishTaskBlocked(bus,a.job,a.taskId,a.reason,a.extra);
  else if(a.method==='dependent')await publishDependentUnblocked(bus,a.targets,a.reason);
  else if(a.method==='none')await publishWake(undefined,a.job,a.taskId,a.message);
  else if(a.method==='require'||a.method==='requireNone'){
   try{await requestManagedReconciliation(a.method==='require'?bus:undefined,a.job);
    receipts.push({ok:true});
   }catch(e){receipts.push({ok:false,error:e.message});}
  }
 }
 return {events,receipts};
}
test('95 Node/Rust event emission and no-bus fail-closed parity scenarios',async()=>{
 const expected=await Promise.all(fixtures.map(runNode));
 const run=spawnSync(binary,[],{cwd:root,encoding:'utf8',
  input:fixtures.map(JSON.stringify).join('\n')+'\n',maxBuffer:18*1024*1024,timeout:120000});
 assert.equal(run.status,0,run.stderr||run.error?.message);
 const actual=run.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,fixtures.length);
 const mismatches=[];
 for(let i=0;i<fixtures.length;i++){
  try{assert.deepEqual(actual[i],{ok:true,value:expected[i]});}
  catch{mismatches.push({index:i,actions:fixtures[i].actions,node:expected[i],rust:actual[i]});}
 }
 assert.deepEqual(mismatches.slice(0,3),[],`${mismatches.length} event publishing mismatches`);
 console.log('Verified 95 Node/Rust event publishing scenarios and 1,710 Graph-selected wake API calls');
});
