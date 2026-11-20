// Real ORIGINAL Node startServiceExternalActionFlusher vs compiled native
// Rust timer and projection/reconcile/error sink. These tests have no provider
// credentials, no live service and no durable Relay Job.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {startServiceExternalActionFlusher} from '../../dist/service-external-actions.js';
import {LocalAuthorityDurableStore} from '../../dist/local-authority-store.js';
import {RelayObservability,observability,setObservability} from '../../dist/observability.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const cases=[
 {local:false,noGitHub:false,projected:4,intervalMs:35},
 {local:true,noGitHub:true,projected:4,intervalMs:35},
 {local:true,noGitHub:false,projected:0,intervalMs:35},
 {local:true,noGitHub:false,projected:3,intervalMs:35},
 {local:true,noGitHub:false,projected:2,intervalMs:35,fail:'flush'},
 {local:true,noGitHub:false,projected:2,intervalMs:35,fail:'reconcile'},
 {local:true,noGitHub:false,projected:0,intervalMs:20,fail:'reconcile'},
];
async function original(f){
 const prev=observability();const errors=[];let ticks=0,reconciles=0;
 setObservability(new RelayObservability(record=>errors.push(record),'debug'));
 try{
  const store=f.local?Object.create(LocalAuthorityDurableStore.prototype):{};
  store.noGitHub=f.noGitHub;
  store.projection={flushOnce:async()=>{
   ticks++;
   if(f.fail==='flush')throw Error('fixture projection failed');
   return {projected:f.projected};
  }};
  const reconciler={reconcile:async()=>{
   reconciles++;
   if(f.fail==='reconcile')throw Error('fixture reconcile failed');
  }};
  const stop=startServiceExternalActionFlusher(store,reconciler,'fake-immutable-id',f.intervalMs);
  const enabled=f.local&&!f.noGitHub;
  const immediate=(!enabled&&ticks===0)||(enabled&&ticks>=1);
  await sleep(f.intervalMs*4+35);
  const repeated=(!enabled&&ticks===0)||(enabled&&ticks>=3);
  stop();
  const stoppedAt=ticks;await sleep(f.intervalMs*2+20);
  return {immediate,repeated,stopped:ticks===stoppedAt,
   reconcileOnlyAfterProjection:enabled&&f.projected>0&&f.fail!=='flush'?
    reconciles>0:reconciles===0,
   errorReported:enabled&&(f.fail==='flush'||f.fail==='reconcile'&&f.projected>0)?
    errors.some(r=>r.stage==='reconcile'&&r.event==='service.external_action_flush_failed'
      &&r.level==='warn'&&r.outcome==='failed'):errors.length===0};
 }finally{setObservability(prev);}
}
function native(f){
 const result=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:15000,
  input:JSON.stringify({op:'serviceFlusherProbe',...f})+'\n'});
 assert.equal(result.status,0,result.stderr);
 const decoded=JSON.parse(result.stdout.trim());
 assert.equal(decoded.ok,true,JSON.stringify(decoded));
 return decoded.value;
}
test('service external flusher immediate/periodic/stop/errors are direct Node/Rust parity',async()=>{
 for(const fixture of cases){
  const actual=native(fixture);
  const expected=await original(fixture);
  assert.deepEqual(actual,expected,JSON.stringify(fixture));
  assert.deepEqual(actual,{immediate:true,repeated:true,stopped:true,
   reconcileOnlyAfterProjection:true,errorReported:true},JSON.stringify(fixture));
 }
});
