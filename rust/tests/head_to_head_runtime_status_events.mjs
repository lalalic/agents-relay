// Node/Rust direct differential: src/runtime-status-events.ts, process-local snapshots and transitions; no real EventBus.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {createRuntimeStatusPublisher} from '../../dist/runtime-status-events.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),binary=resolve(root,'rust/target/debug/relay-rust2-parity');let ready=false;
function rust(req){if(!ready){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);ready=true;}
 const r=spawnSync(binary,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:10000});assert.equal(r.status,0,`${r.error}: ${r.stderr}`);return JSON.parse(r.stdout.trim());}
const normalize=raw=>raw.map(({event_id,timestamp,...rest})=>rest);
function node(req){try{const events=[],publish=createRuntimeStatusPublisher({publish:async event=>{events.push(event)}});
 for(const job of req.jobs)publish(job);
 return {ok:true,value:events};}catch(e){return {ok:false,error:e.message}}}
let seed=0x77a21124;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n},pick=a=>a[rand(a.length)];
const scenarios=[];
for(let i=0;i<430;i++){
 const jobs=[];
 const repo=pick(['repo-a','repo-b','repo-a']);
 for(let j=0;j<1+rand(10);j++){
  const taskState=pick(['QUEUED','RUNNING','SUCCEEDED','FAILED','BLOCKED','AWAITING_DECISION']);
  jobs.push({id:pick([`j-${i}` ,`j-${i}-other`]),repository:pick([repo,repo,'other-repo']),state:pick(['ACTIVE','ACTIVE','COMPLETED','DRAFT']),
   updatedAt:`2026-11-17T04:${String(j).padStart(2,'0')}:00Z`,reviewEnabled:false,
   tasks:[{id:'t1',kind:'work',agentName:'worker',state:taskState,executionId:pick([null,'e1']),leaseOwner:pick([null,'relay'])}]});
 }
 scenarios.push({op:'runtimeStatusPublisherScenario',jobs});
}
const validId=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
test('Job runtime status transition emission matches Node with no duplicate or initial event',()=>{
 for(const [i,req] of scenarios.entries()){
  const actual=rust(req),expected=node(req);
  assert.equal(actual.ok,true);assert.equal(expected.ok,true);
  assert.deepEqual(normalize(actual.value),normalize(expected.value),`runtime event fixture ${i}`);
  for(const event of actual.value){assert.match(event.event_id,validId);assert(!Number.isNaN(Date.parse(event.timestamp)));}
 }
 console.log(`Verified ${scenarios.length} Node/Rust runtime status publisher histories, including UUID and timestamps`);
});
