import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const wt=new URL('../..',import.meta.url).pathname.replace(/\/$/,'');
const {SQLiteRelayStore}=await import(pathToFileURL(wt+'/dist/relay-store.js'));
const {LocalAuthorityDurableStore}=await import(pathToFileURL(wt+'/dist/local-authority-store.js'));
const {InMemoryStore}=await import(pathToFileURL(wt+'/dist/store.js'));
const {HostInteractiveInvocationCoordinator,hostInvocationPorts,
 hostInteractiveDecisionEvent}=await import(pathToFileURL(wt+'/dist/interactive-invocation.js'));
const bin=wt+'/rust/target/debug/relay-rust2-parity';
function fixture(index,events){
 const id='J'+index,executionId='exec-'+index,taskId='T'+index;
 const at='2026-11-17T22:00:00.000Z';
 const task={jobId:id,id:taskId,parentTaskId:null,dependencies:[],capabilities:[],
  adapter:'orchestrator',input:'work',state:'RUNNING',attempt:1,maxAttempts:3,
  leaseOwner:'owner',leaseExpiresAt:'2026-11-17T23:00:00.000Z',executionId,
  threadId:null,result:null,error:null,timeoutMs:60_000,createdAt:at,updatedAt:at,
  interactiveInvocation:{invocationId:executionId,revision:executionId,
   executionId,status:'awaiting_decision',boundAt:at}};
 const job={id,title:'Interactive contract',prNumber:0,repository:'job',state:'ACTIVE',
  continuation:null,createdAt:at,updatedAt:at,tasks:[task]};
 const valid=(decision,eventId,feedback='good')=>hostInteractiveDecisionEvent(
  {jobId:id,taskId,executionId},{decision,eventId,feedback,comments:[]},
  '2026-11-17T22:01:00.000Z');
 return {op:'hostInvocationPortsScenario',job,events:events({valid,executionId,id,taskId})};
}
const cases=[
 fixture(1,()=>[{type:'other'}]),
 fixture(2,({valid})=>[valid('approved','yes')]),
 fixture(3,({valid})=>[valid('approved','yes'),valid('approved','yes')]),
 fixture(4,({valid})=>[valid('approved','yes'),valid('approved','different','changed')]),
 fixture(5,({valid})=>[valid('changes_requested','yes','shorten ending')]),
 fixture(6,({valid})=>[valid('changes_requested','yes','shorten ending'),valid('changes_requested','same-again','shorten ending')]),
 fixture(7,({valid})=>[valid('changes_requested','yes','shorten ending'),valid('approved','late','now good')]),
 fixture(8,({valid})=>{const f=valid('approved','yes');f.source.id='forged';return [f];}),
 fixture(9,({valid})=>{const f=valid('approved','yes');f.data.interactive.revision='forged';return [f];}),
 fixture(10,({valid})=>{const f=valid('approved','yes');f.data.interactive.feedback=undefined;return [f];}),
];
function normalize(value){
 const v=structuredClone(value);
 function walk(x){
  if(!x||typeof x!=='object')return;
  for(const [k,item] of Object.entries(x)){
   if(k==='decidedAt'||k==='event_id'&&x.type==='task.interactive_decision.accepted'||k==='timestamp'&&x.type==='task.interactive_decision.accepted')x[k]='NORMALIZED';
   else walk(item);
  }
 }
 walk(v);return JSON.parse(JSON.stringify(v));
}
async function nodeCase({job,events}){
 const db=new SQLiteRelayStore(':memory:'); await db.saveJob(job);
 const emitted=[];let callbacks=0;
 const facade=new LocalAuthorityDurableStore(db,new InMemoryStore());
 const coord=new HostInteractiveInvocationCoordinator({store:hostInvocationPorts(facade),
  emit:event=>emitted.push(event),onAccepted:()=>{callbacks++}});
 const decisions=[];
 try{
  for(const event of events){
   try{decisions.push({ok:true,value:await coord.applyEvent(event)});}
   catch(error){decisions.push({ok:false,error:error.message});}
  }
  const task=(await db.loadJob(job.id)).tasks[0];
  return normalize({decisions,callbacks,events:emitted,task});
 }finally{coord.close();db.close();}
}
const expected=[];for(const item of cases)expected.push(await nodeCase(item));
const r=spawnSync(bin,[],{input:cases.map(JSON.stringify).join('\n')+'\n',
 encoding:'utf8',timeout:120000,maxBuffer:6*1024*1024});
assert.equal(r.status,0,r.stderr);
const results=r.stdout.trim().split('\n').map(JSON.parse);
assert.equal(results.length,cases.length);
const mismatches=[];
for(let i=0;i<cases.length;i++){
 const result=results[i].ok?normalize(results[i].value):results[i];
 try{assert.deepEqual(result,expected[i]);}
 catch{mismatches.push({index:i,node:expected[i],rust:result});}
}
function firstDiff(a,b,path=''){
 if(Object.is(a,b))return null;
 if(a===null||b===null||typeof a!=='object'||typeof b!=='object')
   return {path,node:a,rust:b};
 const keys=new Set([...Object.keys(a),...Object.keys(b)]);
 for(const key of keys){
   if(!(key in a)||!(key in b))return {path:path+'.'+key,node:a[key],rust:b[key]};
   const found=firstDiff(a[key],b[key],path+'.'+key);
   if(found)return found;
 }
 return null;
}
if(mismatches.length){
 console.log('MISMATCHES',mismatches.length);
 for(const item of mismatches) console.log('DIFF',item.index,JSON.stringify(firstDiff(item.node,item.rust)));
 for(const item of mismatches.slice(0,3)) console.log(JSON.stringify(item,null,2).slice(0,10000));
 process.exitCode=1;
}else console.log('H2H_PASS',cases.length);
