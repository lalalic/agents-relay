// Optional remote delivery failures are observational and deduplicated.
// Mock event bus only: no GitHub, publishing, credentials or Job state.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const {handleGitHubProjectionFailure}=await import('../dist/projection-failure-recovery.js');
const {ProjectionFailureDeduplicator}=await import('../dist/projection-failure-dedupe.js');
const rust=resolve('rust/target/debug/relay-rust2-parity');
const job={id:'42',repository:'fixture',updatedAt:'2026-11-17T12:00:00.000Z'};
const errors=[
 {message:'invalid api key',status:400},
 {message:'rate limit exceeded',status:429},
 {message:'conflict',status:409},
 {message:'unavailable',status:503},
];
let count=0;
function clean(event){const {timestamp,event_id,...rest}=event;return JSON.parse(JSON.stringify(rest));}
function run(failures){
 const p=spawnSync(rust,[],{input:JSON.stringify({op:'deliveryWave2',case:'projectionFailureScenario',failures})+'\n',
  encoding:'utf8',timeout:30000});
 assert.equal(p.status,0,p.stderr);
 const response=JSON.parse(p.stdout.trim());
 if(!response.ok)throw Error(response.error);
 return response.value;
}
async function node(failures){
 const deduplicator=new ProjectionFailureDeduplicator();
 const events=[],accepted=[];
 for(const {error,job} of failures){
  const before=events.length;
  await handleGitHubProjectionFailure(error,job,'/tmp/nonexistent-snapshot',
   {deduplicator,eventBus:{publish:async event=>{events.push(clean(event));}}});
  accepted.push(events.length>before);
 }
 return {events,accepted};
}
for(const error of errors){
 for(const attempts of [1,2,3]){
   const failures=Array.from({length:attempts},()=>({error,job,asError:false}));
   const n=await node(failures);
   const r=run(failures);
   assert.deepStrictEqual({events:r.events,accepted:r.accepted},n,
     'classification and dedup '+JSON.stringify({error,attempts}));
   assert.equal(r.observations.length,n.events.length);
   count++;
 }
}
console.log('PASS Rust2 worker C optional projection differential '+count);
