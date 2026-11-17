// Direct Node src/review-revision-model.ts and execution helpers vs Rust randomized parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import * as model from '../../dist/review-revision-model.js';
import * as execution from '../../dist/review-revision-execution.js';
const root=process.cwd(),bin=resolve(root,'rust/target/debug/relay-rust2-parity');
let seed=2026111704;
function random(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32}
function pick(a){return a[Math.floor(random()*a.length)]}
function call(op,args,invoke) {
 let expected;try{expected={ok:true,value:JSON.parse(JSON.stringify(invoke()))}}catch(e){expected={ok:false,error:e.message}}
 const proc=spawnSync(bin,[],{input:JSON.stringify({op,root,...args})+'\n',encoding:'utf8'});
 assert.equal(proc.status,0,proc.stderr);
 const actual=JSON.parse(proc.stdout.trim());
 try{assert.deepEqual(actual,expected)}catch(e){
   throw new Error(op+': '+e.message+'\nargs='+JSON.stringify(args)+'\nnode='+JSON.stringify(expected)+'\nrust='+JSON.stringify(actual));
 }
}
const states=['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','DRAFT','BLOCKED'];
const statuses=['requested','queued','running','verified','failed','stale','invalid'];
const request=()=>({requestId:pick(['req1','req2','req3']),
  reviewTaskId:pick(['r','q']),reviewExecutionId:pick(['e1','e2']),
  reviewHeadSha:pick(['h','old']),originalTaskId:pick(['a','missing']),
  revisionTaskId:pick(['b','c',null]),status:pick(statuses),
  findings:pick([[{id:'f1',summary:'one'}],[{id:'f1',summary:'one'},{id:'f2',summary:'two'}],[]])});
const task=(id)=>({id,state:pick(states),executionId:pick(['e1','e2',null]),kind:'work',attempt:pick([0,1,3]),
 createdAt:pick(['2025-01-01','2025-02-01','2026-01-01']),revision:pick([undefined,{kind:'targeted',originalTaskId:'a',reviewTaskId:'r',requestIds:pick([[],['req1'],['req2'],['req1','req2']]),basedOnHeadSha:'h'}])});
test('public revisionRequestReady + reconcileReviewRevisionFacts direct randomized Node/Graph vs Rust',()=>{
 for(let i=0;i<1050;i++){
 const j={id:'job',updatedAt:'OLD',review:pick([undefined,{taskId:'r',outcome:'changes_required',revisionDisposition:'targeted'},{taskId:'q',outcome:'stale',revisionDisposition:'targeted'},{taskId:'r',outcome:'passed',revisionDisposition:'other'}]),
 tasks:[task('a'),task('b'),task('c')],reviewRevisionRequests:Array.from({length:Math.floor(random()*4)},request)};
 for(const child of j.tasks) {
  call('revisionRequestReady',{job:j,task:child},()=>execution.revisionRequestReady(j,child));
 }
 let nodeJob=structuredClone(j);
 let changed=execution.reconcileReviewRevisionFacts(nodeJob);
 if(changed)nodeJob.updatedAt='NORMALIZED';
 call('reconcileReviewRevisionFacts',{job:j},()=>({changed,job:nodeJob}));
 }
});
test('revision-model coverage facts, dependency modes, semantic generation order',()=>{
 for(let i=0;i<720;i++){
 const j={tasks:[{id:'a',state:pick(states),attempt:pick([0,1,2]),createdAt:'2025-01-01'},
 {id:'b',state:pick(states),attempt:pick([0,2,3]),createdAt:pick(['2025-01-02','2025-03-01']),
  revision:pick([undefined,{originalTaskId:'a'}])},
 {id:'c',state:pick(states),attempt:pick([0,2]),createdAt:pick(['2025-01-03','2025-02-01']),
  revision:pick([undefined,{originalTaskId:'a'}])}],
 reviewRevisionRequests:Array.from({length:Math.floor(random()*5)},request)};
 const reviewer={id:pick(['r','q']),executionId:pick(['e1','e2',null])};
 const head=pick(['h','old']);
 call('targetedRequestsForReview',{job:j,task:reviewer,headSha:head},
    ()=>model.targetedRequestsForReview(j,reviewer,head));
 const issues=pick([[],['f1'],['f2'],['one'],['f1','two'],['[unparseable blocking finding]'],[' f1 ']]);
 call('targetedRequestsCoverReview',{job:j,task:reviewer,headSha:head,issues},
    ()=>model.targetedRequestsCoverReview(j,reviewer,head,issues));
 const dep=pick(['a','b','c','missing']);
 const actor={id:'t',dependencies:pick([[],['a'],['a','a'],['a','b'],['b','c'],['missing']]),
 dependencyValidity:pick([{}, {a:'revalidate',b:'rerun',missing:'rerun'},{a:'other'}, {a:'order-only'}])};
 call('dependencyValidityReview',{task:actor,id:dep},()=>model.dependencyValidity(actor,dep));
 call('dependencyRevisionVectorReview',{job:j,task:actor},()=>model.dependencyRevisionVector(j,actor));
 const a=pick([{}, {a:'a:1'},{b:'b:2',a:'a:1'}, {a:null}]),b=pick([{}, {a:'a:1'}, {a:'a:1',b:'b:2'}, {a:null}]);
 call('sameDependencyRevisionVectorReview',{a,b},()=>model.sameDependencyRevisionVector(a,b));
 }
});
