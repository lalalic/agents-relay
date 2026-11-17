// Node/Rust direct differential for src/workflow/durable-publication.ts and src/reconciler-workflow-outbox.ts; all writes are isolated :memory: SQLite.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {DurableWorkflowPublication,DurableWorkflowConsumer} from '../../dist/workflow/durable-publication.js';
import {drainProductionWorkflowOutbox} from '../../dist/reconciler-workflow-outbox.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let ready=false;
function rust(req){if(!ready){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);ready=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:15000,maxBuffer:6*1024*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim());}
async function node(req){try{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE objective (value INTEGER NOT NULL); INSERT INTO objective VALUES(0)');
 const outbox=new DurableWorkflowPublication(db),inbox=new DurableWorkflowConsumer(db);
 const outputs=[];
 for(const op of req.operations){try{
  const event={key:op.key,eventId:op.eventId,payload:op.payload};let value;
  switch(op.action){
   case 'enqueue':outbox.enqueue(op.key,op.eventId,op.payload);value=null;break;
   case 'transition':outbox.commitTransitionAndEvents(()=>{db.exec('UPDATE objective SET value=value+1');if(op.reject)throw Error('fixture transition failed')},op.events);value=null;break;
   case 'consume':value=inbox.consume(op.consumerId,event,()=>{db.exec('UPDATE objective SET value=value+1');if(op.reject)throw Error('fixture consumer failed')});break;
   case 'pending':value=outbox.pending();break;
   case 'replay':{let sent=0;value=await outbox.replay(async()=>{if(op.rejectAfter>=0&&sent>=op.rejectAfter)throw Error('fixture transport failed');sent++});break;}
   case 'drain':{
    const transport=op.transport??'both',fail=op.reject===true;
    const eventBus=transport==='both'||transport==='bus'?{publish:async()=>{if(fail)throw Error('fixture bus failed')}}:undefined;
    const emit=transport==='both'||transport==='emit'?async()=>{if(fail)throw Error('fixture emit failed')}:undefined;
    value=await drainProductionWorkflowOutbox({drainWorkflowEvents:async publish=>outbox.replay(async row=>publish(row.payload))},{eventBus,emit});break;
   }
   default:throw Error('unknown workflow durable operation');
  }
  outputs.push({ok:true,value});
 }catch(error){outputs.push({ok:false,error:error.message})}}
 const value=db.prepare('SELECT value FROM objective').get().value;
 const outboxRows=db.prepare('SELECT event_key,event_id,payload_json,state FROM workflow_event_outbox ORDER BY event_key').all().map(row=>({key:row.event_key,eventId:row.event_id,payload:JSON.parse(row.payload_json),state:row.state}));
 const receipts=db.prepare('SELECT consumer_id,event_key,event_id,payload_json FROM workflow_event_inbox ORDER BY consumer_id,event_key').all().map(row=>({consumerId:row.consumer_id,key:row.event_key,eventId:row.event_id,payload:JSON.parse(row.payload_json)}));
 db.close();return {ok:true,value:{outputs,value,outbox:outboxRows,receipts}};
 }catch(error){return {ok:false,error:error.message}}}
let seed=0x18021710;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n},pick=xs=>xs[rand(xs.length)];
const cases=[];
for(let i=0;i<550;i++){
 const operations=[];
 for(let j=0;j<1+rand(13);j++){
  const type=pick(['enqueue','enqueue','transition','consume','pending','replay','drain']);
  const key=pick([`job${i}/task${j}`,`job${i}/same-key`]);
  const eventId=pick(['event.finished','task.completed','on:launch', '']);
  const payload=pick([null,{job:`${i}`,step:j},{name:'panda',count:j},['hello',j]]);
  const events=Array.from({length:1+rand(3)},(_,index)=>({key:`job${i}/tx${j}/${index}`,eventId:'event.finished',payload:{j,index}}));
  operations.push({action:type,key,eventId,payload,consumerId:pick(['publisher','reconciler','']),reject:rand(11)===0,rejectAfter:pick([-1,-1,0,1]),events,transport:pick(['both','bus','emit','none'])});
 }
 cases.push({op:'durableWorkflowScenario',operations});
}
test('atomic SQLite outbox commit/publish/replay and consumer idempotency match Node',async()=>{
 for(const [index,req] of cases.entries()){
  const a=rust(req),b=await node(req);
  assert.deepEqual(a,b,`outbox ${index}: ${JSON.stringify(req).slice(0,500)}`);
 }
 console.log(`Verified ${cases.length} Node/Rust durable Workflow Outbox and Consumer histories`);
});
