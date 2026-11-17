// Direct Node/Rust differential for src/task-comments.ts: append-only idempotency, UUID/timestamp generation, stale snapshot reconciliation and prompt context.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {appendTaskComment,taskCommentContext,preserveTaskComments} from '../../dist/task-comments.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let built=false;
function rust(req){if(!built){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);built=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:10000,maxBuffer:5*1024*1024});assert.equal(r.status,0,`${r.error}: ${r.stderr}`);return JSON.parse(r.stdout.trim());}
function node(req){try{
 let value;
 if(req.op==='appendTaskComment'){
  const job=structuredClone(req.job);const options=req.options??'cli';const comment=appendTaskComment(job,req.taskId,req.message,options);value={comment,job};
 }else if(req.op==='taskCommentContext')value=taskCommentContext(req.task);
 else value=preserveTaskComments(req.previous,req.incoming);
 return {ok:true,value:JSON.parse(JSON.stringify(value))};
 }catch(error){return {ok:false,error:error.message}}
}
function normalize(value){
 if(Array.isArray(value))return value.map(normalize);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='createdAt'&&typeof v==='string'&&/^\d{4}-/.test(v)?'<ISO-TIMESTAMP>':normalize(v)]));
 if(typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))return '<RANDOM-UUID-V4>';
 return value;
}
let seed=0x2bb47019;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};const choose=values=>values[rand(values.length)];
const comments=[
 {id:'c1',text:'first message',author:'human',createdAt:'2026-01-01T00:00:00Z',idempotencyKey:'key-1'},
 {id:'c2',text:'中文反馈',author:'relay',createdAt:'2026-01-02T00:00:00Z',kind:'review.feedback'},
 {id:'c3',text:'notes',author:'planner',createdAt:'2026-01-03T00:00:00Z'},
];
const words=[' trim me ','\t中文 🐼\n','👍','\u00a0Whitespace\u3000','    ', '\n\n', '  multi-line\nkeep it  '];
const requests=[];
for(let i=0;i<1200;i++){
 const id=`task-${i}`,mode=rand(8);
 const task={id,state:'RUNNING',input:'unchanged',executionId:'e1',comments:choose([undefined,[],[comments[0]],[comments[0],comments[1]],comments])};
 const job={id:'job-'+i,repository:'repo',tasks:mode===2?[]:[task,{id:'other',comments:[comments[2]]}]};
 const options=choose(['cli','human','reviewer',{}, {author:'operator',kind:'human',executionId:'exec-2'},
  {author:'',kind:'review.feedback',idempotencyKey:'key-1'},
  {author:'operator',transition:'WAITING->ACTIVE',idempotencyKey:'unique-'+i},
  {idempotencyKey:''},{idempotencyKey:'key-1',kind:'human'}, {idempotencyKey:'key-new',executionId:'e1',kind:'resolution.changed'}]);
 requests.push({op:'appendTaskComment',job,taskId:mode===2?'missing':id,message:choose(words),options});
}
for(let i=0;i<700;i++){
 const task={id:String(i),comments:choose([undefined,[],comments,comments.slice(0,1),[{}],
  [{id:'c1',createdAt:'now',author:'a',text:'x'}, {id:'c2',createdAt:'later',author:'b',text:'y'}]])};
 requests.push({op:'taskCommentContext',task});
}
for(let i=0;i<720;i++){
 const previous=Array.from({length:1+rand(5)},(_,j)=>({id:`t${j}`,comments:choose([undefined,[],comments,comments.slice(0,2)])}));
 const incoming=Array.from({length:1+rand(7)},(_,j)=>({id:choose([`t${j%5}`,`new-${i}-${j}`]),
  title:'Existing title',comments:choose([undefined,[],comments.slice(0,2),[comments[1],{id:'new',text:'more',author:'user',createdAt:'today'}]])}));
 requests.push({op:'preserveTaskComments',previous,incoming});
}
test('append, context and append-only preservation exactly match Node for comments and Task snapshots',()=>{
 for(const [i,req] of requests.entries()){
  const expected=node(req),actual=rust(req);
  assert.deepEqual(normalize(actual),normalize(expected),`Task comments fixture ${i}: ${JSON.stringify(req).slice(0,450)}`);
 }
 console.log(`Verified ${requests.length} Node/Rust Task comment append/context/stale snapshot fixtures`);
});
