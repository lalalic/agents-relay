// Direct src/cli-support.ts ServiceEventBus vs Rust ServiceEventBus using
// original in-process buses. No NATS, daemon, live Jobs, or external providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {ServiceEventBus} from '../../dist/cli-support.js';
import {MemoryEventBus} from '../../dist/events.js';

const root=resolve(import.meta.dirname,'../..');
const executable=join(root,'rust/target/debug/relay-rust2-parity');
let seed=0x907fe;
function rand(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
function pick(arr){return arr[rand()%arr.length];}
const fixtures=[];
for(let n=0;n<100;n++){
 const actions=[];
 let subscriptions=0;
 const labels=['one','two','three','all','extra'];
 const jobs=['101','102','103'];
 for(let k=0;k<24;k++){
  const method=pick(['subscribe','subscribeAll','publish','publish','unsubscribe','close']);
  if(method==='subscribe'){
   actions.push({method,label:pick(labels),jobId:pick(jobs)});
   subscriptions++;
  }else if(method==='subscribeAll'){
   actions.push({method,label:pick(labels)});
   subscriptions++;
  }else if(method==='publish'){
   actions.push({method,event:{job_id:pick(jobs),type:pick(['job.wake','task.started','task.finished']),message:'fixture'}});
  }else if(method==='unsubscribe'){
   actions.push({method,index:subscriptions>0?rand()%subscriptions:0});
  }else actions.push({method});
 }
 fixtures.push({op:'serviceEventBusScenario',actions});
}
async function evaluateNode(fixture){
 const bus=new ServiceEventBus(new MemoryEventBus());
 const trace=[],unsub=[];
 for(const action of fixture.actions){
  if(action.method==='subscribe'||action.method==='subscribeAll'){
   const label=action.label;
   const callback=async event=>trace.push({label,jobId:event.job_id,type:event.type});
   const un=action.method==='subscribe'?await bus.subscribe(action.jobId,callback):
     await bus.subscribeAll(callback);
   unsub.push(un);
  }else if(action.method==='unsubscribe'){
   await unsub[action.index]?.();
  }else if(action.method==='publish')await bus.publish(action.event);
  else if(action.method==='close')await bus.close();
 }
 return trace;
}
test('100 Node/Rust subscription, unsubscribe, close and post-close scenarios preserve exact ordering',async()=>{
 const expected=[];
 for(const f of fixtures)expected.push(await evaluateNode(f));
 const run=spawnSync(executable,[],{cwd:root,encoding:'utf8',
  input:fixtures.map(JSON.stringify).join('\n')+'\n',
  timeout:120000,maxBuffer:10*1024*1024});
 assert.equal(run.status,0,run.stderr||run.error?.message);
 const actual=run.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,fixtures.length);
 const differences=[];
 for(let i=0;i<fixtures.length;i++){
  try{assert.deepEqual(actual[i],{ok:true,value:expected[i]});}
  catch{differences.push({index:i,actions:fixtures[i].actions,node:expected[i],rust:actual[i]});}
 }
 assert.deepEqual(differences.slice(0,5),[],`${differences.length} service event bus mismatches`);
 console.log('Verified 100 real in-memory Node/Rust ServiceEventBus lifecycle scenarios (2,400 operations)');
});
