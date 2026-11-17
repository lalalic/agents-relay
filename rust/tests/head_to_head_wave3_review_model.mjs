// Worker B: exact Node module differential (randomized input/error ordering).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { recordTargetedRevisionRequest } from '../../dist/review-revision-model.js';
import { reviewWorkSettled } from '../../dist/review-replan.js';
const root=process.cwd(),bin=resolve(root,'rust/target/debug/relay-rust2-parity');
const canonical=v=>v===undefined?null:structuredClone(v);
function rust(op,payload){
 const result=spawnSync(bin,[],{input:JSON.stringify({op,root,...payload})+'\n',encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 return JSON.parse(result.stdout.trim());
}
function scrub(v){
 if(Array.isArray(v))return v.map(scrub);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([,val])=>val!==undefined).map(([key,val])=>[key,
   ['createdAt','updatedAt','decidedAt','deliveredAt'].includes(key)&&typeof val==='string'&&val.includes('2026-')?'TIMESTAMP':scrub(val)]));
 return v;
}
let seed=20261117;
const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32};
const pick=a=>a[Math.floor(rnd()*a.length)];
const base=()=>({id:'1',title:'Story',repository:'disposable',projectRoot:'/tmp/isolated',
 state:'ACTIVE',headSha:'head',priority:'P1',tasks:[
 {jobId:'1',id:'11',kind:'work',agentName:'implementation',state:'SUCCEEDED',attempt:1,maxAttempts:3,
  adapter:'chatgpt',capabilities:['model'],input:'original input',output:{kind:'task_pr'},title:'Original',
  result:{summary:'done',artifacts:[]},priority:'P1',storySize:'M',createdAt:'old',updatedAt:'old'},
 {jobId:'1',id:'12',kind:'work',agentName:'reviewer',state:'RUNNING',executionId:'e1',reviewHeadSha:'head',
  adapter:'chatgpt',capabilities:[],createdAt:'old',updatedAt:'old'}],plans:[],reviewRevisionRequests:[],
 review:{headSha:'head',taskId:'12',outcome:'started'},updatedAt:'old'});
function compareModel(job,input){
 const working=canonical(job);
 let node;
 try{node={ok:true,value:{result:recordTargetedRevisionRequest(working,canonical(input)),job:working}}}
 catch(e){node={ok:false,error:e.message}}
 const actual=rust('recordTargetedRevisionRequest',{job,input});
 try{
  if(node.ok){assert.equal(actual.ok,true,JSON.stringify(actual));assert.deepEqual(scrub(actual.value),scrub(node.value));}
  else assert.deepEqual(actual,node);
 }catch(e){throw new Error(`${e.message}\nNode=${JSON.stringify(scrub(node)).slice(0,1500)}\nRust=${JSON.stringify(scrub(actual)).slice(0,1500)}\nInput=${JSON.stringify(input)}`)}
}
test('revision recording randomized validation, Graph safety, idempotent identity and feedback',()=>{
 const input=()=>({requestId:pick(['r1','r2','', '  ', 'x'.repeat(161)]),reviewTaskId:pick(['12','other']),
  reviewExecutionId:pick(['e1','wrong','']),headSha:pick(['head','wrong','']),
  originalTaskId:pick(['11','missing']), allocatedTaskId:pick(['99','0','bad','',null]),
  findings:pick([[{id:'f1',summary:'issue',evidence:'evidence'}],[{id:'f1',summary:'issue'}],
    [{id:'f1',summary:'ok'},{id:'f1',summary:'dupe'}],[{id:'',summary:'ok'}],[],null])});
 for(let i=0;i<150;i++){
  const job=base();job.state=pick(['ACTIVE','CANCELLED']);
  job.tasks[0].state=pick(['SUCCEEDED','FAILED']);
  job.tasks[1].state=pick(['RUNNING','FAILED']);
  compareModel(job,input());
 }
 for(let i=0;i<8;i++){
  const job=base();
  const input={requestId:`ok-${i}`,reviewTaskId:'12',reviewExecutionId:'e1',headSha:'head',
    originalTaskId:'11',findings:[{id:'f1',summary:'issue '+i,evidence:'proof'}],allocatedTaskId:'99'};
  compareModel(job,input);
  const duplicate=structuredClone(job);
  recordTargetedRevisionRequest(duplicate,input);
  compareModel(duplicate,input);
  input.findings[0].summary='changed';compareModel(duplicate,input);
 }
});
test('reviewWorkSettled Graph blocked by missing/reusable/active recovery and actor waiting',()=>{
 for(let i=0;i<240;i++){
  const job={tasks:[
   {id:'1',kind:'work',agentName:'implementation',state:pick(['FAILED','SUCCEEDED','RUNNING','QUEUED']),
    attempt:pick([0,1,2,3]),resolution:{state:pick(['resolved','active','waiting',undefined])}},
   {id:'2',kind:'work',agentName:'troubleshooter',parentTaskId:'1',
    state:pick(['SUCCEEDED','CANCELLED','FAILED','RUNNING','QUEUED','DRAFT']),
    recoveryForAttempt:pick([0,1,2,3]),attempt:pick([0,1,3]),maxAttempts:pick([1,3,4])},
  ]};
  if(rnd()<0.35)job.tasks.splice(1,1);
  if(rnd()<0.25)job.tasks.push({id:'3',kind:'work',agentName:'reviewer',state:'FAILED'});
  const r=rust('reviewWorkSettled',{job});
  assert.equal(r.ok,true,r.error);
  assert.equal(r.value,reviewWorkSettled(job),JSON.stringify(job));
 }
});
