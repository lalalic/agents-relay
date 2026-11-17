import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {ReconcileCoordinator} from '../../dist/reconcile-coordinator.js';
const root=resolve(import.meta.dirname,'../..');
const bin=resolve(root,'rust/target/debug/relay-rust2-parity');
let seed=0x172cad04;
const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};
const pick=a=>a[rand(a.length)];
const cases=[];
for(let i=0;i<260;i++){
  const signals=[];
  for(let n=0;n<1+rand(7);n++){
    signals.push({method:pick(['accept','acceptTransport','acceptObserved']),
      signal:{jobId:pick(['1','2','99']),reason:'case-'+i+'-'+n,fail:rand(9)===0}});
  }
  cases.push({op:'wave2Coordinator',signals});
}
function rust(cases){
 const run=spawnSync(bin,[],{input:cases.map(x=>JSON.stringify(x)).join('\n')+'\n',cwd:root,
 encoding:'utf8',timeout:90000,maxBuffer:30*1024*1024});
 assert.equal(run.status,0,run.stderr||String(run.error));
 return run.stdout.trim().split('\n').map(x=>JSON.parse(x));
}
async function node(request){
 const batches=[],failures=[];
 const coordinator=new ReconcileCoordinator(async(jobId,signals)=>{
   batches.push({jobId,signals});
   if(signals.some(x=>x.fail))throw new Error('fixture consumer failed');
 },(error,signal)=>{failures.push({error:error.message,signal})});
 const outcomes=[];
 for(const {method,signal} of request.signals){
   try{await coordinator[method](signal);outcomes.push({ok:true})}
   catch(error){outcomes.push({ok:false,error:error.message})}
   await coordinator.settle();
 }
 return {outcomes,batches,failures,idle:coordinator.isIdle()};
}
test('Node/Rust coordinator public accept methods preserve ordered jobs, errors, settle and detached notifications',async()=>{
 const outcomes=rust(cases);
 for(let i=0;i<cases.length;i++){
  const expected={ok:true,value:await node(cases[i])};
  assert.deepEqual(outcomes[i],expected,'case '+i+': '+JSON.stringify(cases[i]));
 }
 console.log('Coordinator: '+cases.length+' direct Node/Rust randomized FIFO, failed-batch and settle scenarios');
});
