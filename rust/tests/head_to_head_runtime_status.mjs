// Node/Rust direct differential for src/runtime-status.ts. Exactly the persisted Job inputs; no external PR calls.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {isSuperseded,implementationTasks,implementationComplete,deriveJobRuntimeStatus} from '../../dist/runtime-status.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),binary=resolve(root,'rust/target/debug/relay-rust2-parity');let ready=false;
function rust(req){if(!ready){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);ready=true;}
 const r=spawnSync(binary,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:10000});assert.equal(r.status,0,`${r.error}: ${r.stderr}`);return JSON.parse(r.stdout.trim());}
function node(req){try{let v;
 if(req.op==='runtimeStatusIsSuperseded')v=isSuperseded(req.task,new Map(req.tasks.map(t=>[t.id,t])));
 if(req.op==='runtimeImplementationTasks')v=implementationTasks(req.job);
 if(req.op==='runtimeImplementationComplete')v=implementationComplete(req.job);
 if(req.op==='deriveJobRuntimeStatus')v=deriveJobRuntimeStatus(req.job,req.prState);
 return {ok:true,value:v};
 }catch(e){return {ok:false,error:e.message}}}
let seed=0xbad1a551;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};const pick=a=>a[rand(a.length)];
const states=['RUNNING','QUEUED','SUCCEEDED','FAILED','CANCELLED','BLOCKED','AWAITING_DECISION','DRAFT'];
const agentNames=['worker','planner','troubleshooter','reviewer','job-acceptance-reviewer','coordinator',''];
const jobs=[];
for(let i=0;i<900;i++){
 const tasks=Array.from({length:rand(12)},(_,j)=>({id:`t-${i}-${j}`,state:pick(states),kind:pick(['work','planner','worker','task']),agentName:pick(agentNames),
   executionId:pick([null,undefined,`execution-${i}-${j}`]),leaseOwner:pick([null,undefined,'relay']),revision:pick([null,undefined,{}, {requestIds:['x']}]),
   resolution:pick([undefined,{path:'cancel_supersede',state:'resolved'},{path:'other',state:'waiting'}]),
   resolutionClassification:pick([undefined,{kind:'superseded',targetTaskId:`t-${i}-${rand(12)}`,evidence:'evidence',reason:'done'},
       {kind:'superseded',targetTaskId:'',evidence:'',reason:'done'}, {kind:'failed'}])}));
 const job={id:`j-${i}`,state:pick(['ACTIVE','ACTIVE','ACTIVE','FAILED','COMPLETED','DRAFT','CANCELLED']),reviewEnabled:pick([true,false]),
  tasks,plans:pick([undefined,[],[{status:'FAILED'}],[{status:'PLANNING'}],[{status:'SUCCEEDED'}]]),
  review:pick([undefined,null,{outcome:'approved'},{outcome:'pending'}, {outcome:'started'}]),
  reviewRevisionRequests:pick([undefined,[],...Array.from({length:2},()=>[{status:pick(['stale','queued']),revisionTaskId:`t-${i}-${rand(12)}`}])])};
 jobs.push(job);
}
const requests=[];
for(const job of jobs){
 for(const op of ['runtimeImplementationTasks','runtimeImplementationComplete','deriveJobRuntimeStatus'])requests.push({op,job,prState:pick(['UNKNOWN','OPEN','CLOSED','MERGED'])});
 for(const task of job.tasks.slice(0,2))requests.push({op:'runtimeStatusIsSuperseded',task,tasks:job.tasks});
}
test('computed Job status and implementation selection are PR-independent and match Node',()=>{
 for(let i=0;i<requests.length;i++){
  const transported=JSON.parse(JSON.stringify(requests[i]));
  const actual=rust(transported),expected=node(transported);
  assert.deepEqual(actual,expected,`status fixture ${i}: ${JSON.stringify(requests[i]).slice(0,500)}`);
 }
 console.log(`Verified ${requests.length} Node/Rust runtime status and supersession cases`);
});
