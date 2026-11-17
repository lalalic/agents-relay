import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import * as replan from '../../dist/review-replan.js';
import * as thread from '../../dist/reviewer-thread.js';
const root=process.cwd(),bin=resolve(root,'rust/target/debug/relay-rust2-parity');
let seed=482901;
function rand(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32}
function pick(a){return a[Math.floor(rand()*a.length)]}
function scrub(v){if(v===undefined)return null;if(Array.isArray(v))return v.map(scrub);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([,x])=>x!==undefined).map(([k,x])=>[k,k==='decidedAt'?'NORMALIZED':scrub(x)]));return v}
function rust(op,props){
 const r=spawnSync(bin,[],{input:JSON.stringify({op,root,...props})+'\n',encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 return JSON.parse(r.stdout.trim());
}
function cmp(op,props,call){
 let expected;
 try{expected={ok:true,value:scrub(call())}}catch(e){expected={ok:false,error:e.message}}
 const actual=rust(op,props);
 if(!expected.ok){assert.deepEqual(actual,expected,`${op}: ${JSON.stringify(props)}`);return}
 try{assert.deepEqual(scrub(actual),expected)}catch(e){throw new Error(`${op} mismatch: ${e.message}\ninput=${JSON.stringify(props)}\nnode=${JSON.stringify(expected)}\nrust=${JSON.stringify(actual)}`)}
}
const states=['DRAFT','QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','BLOCKED'];
const id=()=>pick(['1','2','3','a',null,undefined,34]);
function task(i){
 return {id:String(i),kind:pick(['work','planner']),agentName:pick(['implementation','troubleshooter','reviewer','final-review','final-reviewer']),
   state:pick(states),attempt:pick([0,1,2,3]),maxAttempts:pick([1,2,3]),
   parentTaskId:pick(['1','2','3',null,undefined]),recoveryForAttempt:pick([0,1,2,3,undefined]),
   resolution:pick([undefined,{state:'active'},{state:'waiting'},{state:'resolved'},{}]),
   adapter:pick(['chatgpt','codex','model']),routing:{provider:pick(['chatgpt','codex'])},
   threadId:pick(['abc',' ',null,undefined]),threadUrl:pick(['https://chatgpt.com/c/abc','https://test.invalid/c/abc',null]),threadDeletedAt:pick([null,undefined,'yesterday'])};
}
const plan=()=>({id:String(Math.floor(rand()*10)),status:pick(['PLANNING','FAILED','SUCCEEDED','CANCELLED']),
 trigger:{source:pick(['review','manual']),reviewTaskId:pick(['9','10','11'])},generatedTaskIds:pick([[],['1'],['2'],['1','2'],['99']])});
const job=()=>({id:'91',headSha:'sha',review:{taskId:pick(['9','10','11',null,undefined]),outcome:pick(['changes_required','stale','passed','none']),revisionDisposition:pick(['targeted','full',undefined])},
 tasks:Array.from({length:Math.floor(rand()*7)},(_,i)=>task(i+1)),
 plans:Array.from({length:Math.floor(rand()*5)},plan),
 reviewRevisionRounds:pick([[],[{reviewTaskId:'9',status:'changes_required'}],[{reviewTaskId:'10',status:'changes_required'}],undefined])});
test('review-replan all 3 exported pure APIs vs original Node: recovery and immutable-plan legacy cases',()=>{
 for(let i=0;i<350;i++){
 const j=job();
 cmp('reviewNeedsReplan',{job:j},()=>replan.reviewNeedsReplan(j));
 cmp('reviewPlanReady',{job:j},()=>replan.reviewPlanReady(j));
 cmp('reviewWorkSettled',{job:j},()=>replan.reviewWorkSettled(j));
 }
});
test('reviewer-thread exported destination, normalization, requirements, CLI surface',()=>{
 const vals=[undefined,null,'',' ', ' abc ', 'a'.repeat(256),'a'.repeat(257),1,true,[],{},'🙂'.repeat(128),'🙂'.repeat(129),'\n'];
 for(const v of vals){cmp('normalizeThreadId',{value:v},()=>thread.normalizeThreadId(v));cmp('normalizeThreadId',{value:v,label:'L'},()=>thread.normalizeThreadId(v,'L'))}
 for(let i=0;i<260;i++){
 const j={implementationThreadId:pick([undefined,null,'abc',' ',3,' x ']),reviewerThreadId:pick([undefined,null,'abc',' ',3,' x ']),
 creatorThreadId:pick([undefined,null,'abc',' ',3,' x ']),tasks:Array.from({length:Math.floor(rand()*4)},(_,i)=>task(i+1))};
 const t=task(9),override=pick([undefined,null,'', ' x ',3]);
 cmp('resolveImplementationThreadDestination',{job:j},()=>thread.resolveImplementationThreadDestination(j));
 cmp('resolveImplementationTaskThreadDestination',{job:j,task:t},()=>thread.resolveImplementationTaskThreadDestination(j,t));
 cmp('resolveReviewerThreadDestination',{job:j,override},()=>thread.resolveReviewerThreadDestination(j,override));
 const reviewer={...t,agentName:pick(['reviewer','final-review','implementation']),chatgptThreadDelivery:pick([undefined,
 {threadId:'abc',requestId:'req'}, {threadId:'x',requestId:'req',deliveredAt:'2025-01-01'}]),reviewHeadSha:'h'};
 cmp('prepareReviewerThreadDelivery',{job:{...j,id:'91',headSha:'sha'},task:reviewer,override},()=>thread.prepareReviewerThreadDelivery({...j,id:'91',headSha:'sha'},reviewer,override));
 const requirements=pick([undefined,{capabilities:['model']},{capabilities:['chatgpt','other'],runtime:'other'},{capabilities:[]}]);
 cmp('chatgptThreadRequirements',{configured:requirements},()=>thread.chatgptThreadRequirements(requirements));
 const args=pick([[],['--thread-id','t'],['--thread-id',' '],['--thread-id'],['--thread-id',' a '],['--other','x'],['--thread-id','one','--thread-id','two']]);
 cmp('runtimeReviewer',{args},()=>thread.runtimeReviewer(args));
 }
});
