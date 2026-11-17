// Differential head-to-head for src/local-commit-events.ts: cloned durable Job snapshots and subscription/unsubscription order; no real SQLite commits.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {publishLocalCommit,subscribeLocalCommits} from '../../dist/local-commit-events.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');const binary=resolve(root,'rust/target/debug/relay-rust2-parity');let built=false;
function rust(req){
 if(!built){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);built=true;}
 const out=spawnSync(binary,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:10000,maxBuffer:3*1024*1024});
 assert.equal(out.status,0,`${out.error}: ${out.stderr}`);return JSON.parse(out.stdout.trim());
}
function node(req){
 const trace=[],dispose=[];
 try{
  for(const name of req.subscribers){
   dispose.push(subscribeLocalCommits(job=>trace.push({subscriber:name,job})));
  }
  for(let i=0;i<req.jobs.length;i++){
   for(const remove of req.unsubscribeBefore?.[i]??[])dispose[remove]?.();
   publishLocalCommit(req.jobs[i]);
  }
  return {ok:true,value:trace};
 }catch(e){return {ok:false,error:e.message}}
 finally{for(const end of dispose)end();}
}
let seed=0x25b5b01;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};const pick=xs=>xs[rand(xs.length)];
const requests=[];
for(let i=0;i<620;i++){
 const subscribers=Array.from({length:rand(10)},(_,j)=>`listener-${i}-${j}`);
 const jobs=Array.from({length:rand(9)},(_,j)=>({id:`job-${i}`,state:pick(['ACTIVE','COMPLETED','FAILED']),
  tasks:[{id:`task-${j}`,state:'RUNNING',metadata:{nested:{i,j}}}],updatedAt:`2026-11-16T21:00:${String(j).padStart(2,'0')}Z`}));
 const unsubscribeBefore={};for(let j=0;j<jobs.length;j++){
  if(rand(3)===0)unsubscribeBefore[String(j)]=Array.from({length:rand(4)},()=>rand(subscribers.length||1));
 }
 requests.push({op:'localCommitScenario',subscribers,jobs,unsubscribeBefore});
}
requests.push({op:'localCommitScenario',subscribers:['a','b','c'],jobs:[{id:'1',state:'ACTIVE'},{id:'1',state:'COMPLETED'}],unsubscribeBefore:{1:[0]}});
test('post-commit listeners receive exactly one independent Job clone per active subscription',()=>{
 for(const [i,req] of requests.entries())assert.deepEqual(rust(req),node(req),`local commit fixture ${i}`);
 console.log(`Verified ${requests.length} Node/Rust local-commit subscription and delivery fixtures`);
});
