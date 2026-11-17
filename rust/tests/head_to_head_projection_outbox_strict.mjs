// Node/Rust head-to-head SQLite projection outbox parity: ALL SQLite databases are :memory:.
import {DatabaseSync} from 'node:sqlite';
import {ProjectionOutbox} from '../../dist/projection-outbox.js';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {test} from 'node:test';
const repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const t='2026-01-01T00:00:00.000Z';
const request=(id,priority=0,coalesce)=>({idempotencyKey:id,operation:'save_task',payload:{id},priority,...(coalesce?{coalesceKey:coalesce}:{})});
const diagnostic={kind:'task',jobId:'job-a',subjectId:'42',operation:'save_task',operationKey:'x',localDefinition:{a:1},remoteDefinition:{a:2},divergingFields:['a'],message:'definition changed',detectedAt:t};
const cases=[
 {name:'priority, claim, retry receipts, idempotency, coalesce and conflicts',steps:[
  {action:'enqueue',request:request('a',1),now:t},{action:'enqueue',request:request('b',4),now:t},{action:'enqueue',request:request('a',2),now:t},
  {action:'claim',limit:2,now:t},{action:'enqueue',request:request('b',5),now:t},{action:'enqueue',request:request('a:queued:2',6),now:t},
  {action:'counts'},{action:'retryWithReceipt',id:2,key:'b',attempts:2,nextAt:'2026-01-01T01:00:00.000Z',error:'timeout',detail:{cause:'slow'},now:t},
  {action:'completeWithReceipt',id:1,key:'a',status:'succeeded',attempts:1,detail:{ready:true},now:t},
  {action:'claim',limit:25,now:'2026-01-01T01:00:01.000Z'},
  {action:'enqueue',request:request('coalesce-a',1,'same'),now:t},{action:'enqueue',request:request('coalesce-b',2,'same'),now:t},
  {action:'recordConflict',id:3,diagnostic},{action:'listConflicts'},{action:'resolveConflict',id:999,resolution:{action:'requeue'}},
  {action:'counts'}]},
 {name:'scoped rows isolate job ids and receipt keys',scoped:true,steps:[
  {action:'enqueue',scope:'job-a',request:request('same',2),now:t},{action:'enqueue',scope:'job-b',request:request('same',5),now:t},
  {action:'claim',scope:'job-a',limit:5,now:t},{action:'claim',scope:'job-b',limit:5,now:t},
  {action:'completeWithReceipt',scope:'job-a',id:1,key:'same',status:'succeeded',attempts:1,detail:null,now:t},
  {action:'recordReceipt',scope:'job-b',key:'same',status:'failed',attempts:4,detail:{network:'down'},now:t},
  {action:'counts',scope:'job-a'},{action:'counts',scope:'job-b'},
  {action:'enqueue',scope:'job-a',request:request('same',9),now:t}]},
 {name:'receipt failures rollback deletion and retries',steps:[
  {action:'enqueue',request:request('first',1),now:t},{action:'dropReceipts'},
  {action:'completeWithReceipt',id:1,key:'first',status:'succeeded',attempts:1,detail:null,now:t},
  {action:'retryWithReceipt',id:1,key:'first',attempts:9,error:'dead',nextAt:t,now:t,detail:null},
  {action:'counts'}]},
 {name:'claim rollback on corrupt projection JSON',steps:[
  {action:'enqueue',request:request('one',1),now:t},{action:'enqueue',request:request('two',2),now:t},
  {action:'corruptPayload',id:2},{action:'claim',limit:2,now:t},{action:'counts'}]},
 {name:'historical v4 schema migration and deterministic conflict promotion',legacy:true,steps:[
  {action:'seedLegacyConflict',key:'old:queued:9',now:t},{action:'upgrade',previousVersion:4},{action:'listConflicts'},{action:'counts'}]},
];
const existing=new Set();
const schema=scoped=>`CREATE TABLE projection_outbox(scope_job_id TEXT NOT NULL,id INTEGER NOT NULL,idempotency_key TEXT NOT NULL,operation_key TEXT,coalesce_key TEXT,operation TEXT NOT NULL,payload_json TEXT NOT NULL,priority INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,conflict_definition_json TEXT,conflict_evidence_json TEXT,conflict_detected_at TEXT,conflict_disposition TEXT,conflict_resolution_json TEXT,PRIMARY KEY(scope_job_id,id),UNIQUE(scope_job_id,idempotency_key));CREATE TABLE projection_receipt(scope_job_id TEXT NOT NULL,operation_key TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL,detail_json TEXT,recorded_at TEXT,PRIMARY KEY(scope_job_id,operation_key));`;
function nodeScenario(scenario){
  const db=new DatabaseSync(':memory:');
  if (scenario.scoped) db.exec(schema(true));
  else if(scenario.legacy) db.exec("CREATE TABLE projection_outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,idempotency_key TEXT NOT NULL UNIQUE,coalesce_key TEXT,operation TEXT NOT NULL,payload_json TEXT NOT NULL,priority INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','dead')),attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);");
  else db.exec(ProjectionOutbox.createTableSql()+ProjectionOutbox.createIndexSql()+ProjectionOutbox.createReceiptTableSql());
  const rowsSql=`SELECT ${scenario.scoped?'scope_job_id,':''}id,idempotency_key,operation_key,coalesce_key,operation,payload_json,priority,status,attempts,next_attempt_at,last_error,created_at,updated_at,conflict_definition_json,conflict_evidence_json,conflict_detected_at,conflict_disposition,conflict_resolution_json FROM projection_outbox ORDER BY ${scenario.scoped?'scope_job_id,':''}id`;
  const receiptsSql=`SELECT ${scenario.scoped?'scope_job_id,':''}operation_key,status,attempts,detail_json,recorded_at FROM projection_receipt ORDER BY ${scenario.scoped?'scope_job_id,':''}operation_key`;
  const snapshot=()=>({rows:db.prepare(rowsSql).all(),receipts:(()=>{try{return db.prepare(receiptsSql).all()}catch{return []}})()});
  const results=[];
  for(const step of scenario.steps){const out=new ProjectionOutbox(db,step.scope??(scenario.scoped?'job-a':undefined));const at=step.now??t;let value=null;let output;
   try{switch(step.action){
    case 'enqueue':value=out.enqueue(step.request,at);break;
    case 'claim':value=out.claimDue(step.limit??1,new Date(at));break;
    case 'resetProcessing':out.resetProcessing(at);break;
    case 'complete':out.complete(step.id??1);break;
    case 'completeWithReceipt':out.completeWithReceipt(step.id??1,step.key??'operation',step.status??'succeeded',step.attempts??1,step.detail??null,at);break;
    case 'retryWithReceipt':out.retryWithReceipt(step.id??1,step.key??'operation',step.error??'error',new Date(step.nextAt??at),step.attempts??1,step.detail??null,at);break;
    case 'recordReceipt':out.recordReceipt(step.key??'operation',step.status??'succeeded',step.attempts??1,step.detail??null,at);break;
    case 'retry':out.retry(step.id??1,step.error??'error',new Date(step.nextAt??at));break;
    case 'deadLetter':out.deadLetter(step.id??1,step.error??'error');break;
    case 'recordConflict':out.recordConflict(step.id??1,step.diagnostic);break;
    case 'listConflicts':value=out.listConflicts();break;
    case 'resolveConflict':value=out.resolveConflict(step.id??1,step.resolution);break;
    case 'counts':value={conflict:out.conflictCount(),pending:out.pendingCount(),terminal:out.terminalCount()};break;
    case 'dropReceipts':db.exec('DROP TABLE projection_receipt');break;
    case 'corruptPayload':db.prepare("UPDATE projection_outbox SET payload_json='[invalid' WHERE id=?").run(step.id);break;
    case 'upgrade':ProjectionOutbox.upgrade(db,step.previousVersion??4);break;
    case 'seedLegacyConflict':db.prepare("INSERT INTO projection_outbox(idempotency_key,coalesce_key,operation,payload_json,priority,status,attempts,last_error,created_at,updated_at) VALUES(?,'legacy','append_plan','{}',0,'dead',2,'already exists with a different definition',?,?)").run(step.key,at,at);break;
    default:throw Error('unknown action '+step.action);
   } output={ok:true,value};}catch(e){output={ok:false,error:e.message};}
   try{output.snapshot=snapshot();}catch{}
   results.push(output);
  }
  db.close();return JSON.parse(JSON.stringify(results));
}
const exe=resolve(repo,'rust/target/debug/examples/projection_outbox_parity');
const build=spawnSync('cargo',['build','--offline','--example','projection_outbox_parity','--manifest-path','rust/Cargo.toml'],{cwd:repo,encoding:'utf8'});assert.equal(build.status,0,build.stderr);
test('Node/Rust isolated in-memory outbox transactions, order, scoped identity, rollback and v4 upgrade',()=>{
 for(const scenario of cases){const expected=nodeScenario(scenario);const child=spawnSync(exe,[],{input:JSON.stringify(scenario)+'\n',encoding:'utf8',maxBuffer:10*1024*1024});assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout.trim());assert.equal(result.ok,true,JSON.stringify(result));try{assert.deepStrictEqual(result.value,expected)}catch(e){let mismatch=-1;for(let k=0;k<expected.length;k++){try{assert.deepStrictEqual(result.value[k],expected[k])}catch{mismatch=k;break;}}throw new Error(`${scenario.name} step ${mismatch} (${scenario.steps[mismatch]?.action}): ${e.message}`)}
 }console.log(`PASS ${cases.length} strict in-memory scenarios, ${cases.reduce((n,c)=>n+c.steps.length,0)} SQLite operations`);
});
