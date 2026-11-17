// Direct Node/Rust differential for src/relay-job-snapshot-reads.ts: immutable Job metadata and offline normalized SQLite snapshots.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {currentJobMetadata,normalizeRelayJob,loadRelayJob,listRelayJobs} from '../../dist/relay-job-snapshot-reads.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let compiled=false;
function rust(req){if(!compiled){const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(build.status,0,build.stderr);compiled=true;}
 const outcome=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:13000,maxBuffer:8*1024*1024});assert.equal(outcome.status,0,`${outcome.error}: ${outcome.stderr}`);
 return JSON.parse(outcome.stdout.trim());}
function node(req){try{
 let value;
 if(req.op==='currentJobMetadata')value=currentJobMetadata(req.job);
 else if(req.op==='normalizeRelayJob')value=normalizeRelayJob(req.raw);
 else{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL)');
  for(const record of req.records)db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run(record.id,record.json,'2026-11-16T00:00:00Z');
  value=req.operations.map(op=>{
   try{return {ok:true,value:op.action==='load'?loadRelayJob(db,op.jobId??''):listRelayJobs(db,op.jobId)}}
   catch(error){return {ok:false,error:error.message}}
  });db.close();
 }
 return {ok:true,value:JSON.parse(JSON.stringify(value))};
 }catch(error){return {ok:false,error:error.message}}
}
let seed=0x21a1c74e;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};const pick=xs=>xs[rand(xs.length)];
const states=['ACTIVE','COMPLETED','CANCELLED','FAILED'];
const titles=['','Hello','中文任务','🎥 Scene ','A'.repeat(92)+'🙂'+('many words '.repeat(10))];
function mkJob(id){
 const tasks=Array.from({length:rand(7)},(_,j)=>({id:`${id}-task-${j}`,agentName:pick(['worker','troubleshooter','planner','reviewer']),kind:pick(['task','planner','worker']),
  title:pick([undefined,null,'', 'Existing Title','  ']),input:pick(titles),attempt:pick([0,1,3]),maxAttempts:pick([undefined,0,2,4]),
  state:pick(['UNBLOCKED','BLOCKED','DRAFT','RUNNING','COMPLETED']),updatedAt:'2026-11-16T21:00:00Z',
  interactiveInvocation:pick([undefined,{boundAt:'2026-11-16T20:00:00Z',status:'awaiting_decision'}]),
  executionId:pick([undefined,null,'',`run-${id}-${j}`]),failureReason:pick([undefined,null,'preserve']),
  metadata:{originalState:'unchanged'}}));
 const plans=Array.from({length:rand(5)},(_,j)=>({id:`p-${id}-${j}`,forceCleanHistory:pick([true,false,undefined]),
  cleanHistoryTaskIds:pick([undefined,['1','3'],[],null]),forceRestate:pick([undefined,false,true,null]),
  restateTaskIds:pick([undefined,[],['2'],null]),metadata:{keep:'plan-data'}}));
 return {id,repository:pick(['repo','other']),projectRoot:'/opt/test-repo',prNumber:pick([0,1,4]),externalPrNumber:pick([undefined,14,null,0]),
  state:pick(states),tasks,plans:pick([undefined,null,...[plans]]),metadata:{keep:{nested:'unchanged'}},
  schedule:{obsolete:true},executionMode:'shortcut',contentOnly:true,shortcutExecutionStartedAt:'now',
  shortcutRunnerContext:{content:'old'},shortcutExecutionDeadlineAt:'tomorrow'};
}
const jobs=Array.from({length:1200},(_,i)=>mkJob(String(i)));
const metaFixtures=[];
for(let i=0;i<400;i++){
 const value=pick([mkJob('metadata-'+i),{schedule:1,contentOnly:false,kept:'yes'}, {executionMode:'old',nested:{shortcutExecutionDeadlineAt:'should stay'}},{}, {shortcutExecutionStartedAt:'x'}]);
 metaFixtures.push({op:'currentJobMetadata',job:value});
}
test('current Job fields and normalized durable plan/task projections match original Node exports',()=>{
 for(const [i,req] of metaFixtures.entries())assert.deepEqual(rust(req),node(req),`currentJobMetadata ${i}`);
 for(const [i,job] of jobs.entries()){
  const req={op:'normalizeRelayJob',raw:JSON.stringify(job)};
  assert.deepEqual(rust(req),node(req),`normalizeRelayJob ${i}`);
 }
 console.log(`Verified ${metaFixtures.length} Job metadata projections and ${jobs.length} full legacy Job normalizations`);
});
test('Node/Rust SQLite list/load preserves sorted identity, scoped lookup, original historical JSON',()=>{
 for(let i=0;i<240;i++){
  const rows=Array.from({length:1+rand(15)},(_,j)=>{const id=`j${i}-${String(j+1).padStart(3,'0')}`;return {id,json:JSON.stringify(mkJob(id))};});
  const operations=Array.from({length:1+rand(12)},()=>({action:pick(['load','load','list']),jobId:pick([undefined,null,'',...rows.map(row=>row.id),'not-found'])}));
  const req={op:'relayJobSnapshotScenario',records:rows,operations};
  assert.deepEqual(rust(req),node(req),`SQLite Job snapshot series ${i}`);
 }
 console.log('Verified 240 complete in-memory SQLite Job snapshot read/list histories');
});
