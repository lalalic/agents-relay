// SQLite outbox direct Node/Rust differential. Both sides use only :memory: connections.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ProjectionOutbox} from '../../dist/projection-outbox.js';
const repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
let seed=0x63f0a;function next(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;}function choose(a){return a[next()%a.length]}
const NOW=['2026-11-17T12:00:00.000Z','2026-11-17T12:00:01.000Z','2026-11-17T12:02:03.000Z','2026-11-17T12:06:00.000Z'];
function scenario(){const scope=choose([null,null,'job-1']);const steps=scope?[]:[{action:'upgrade',previousVersion:6}];for(let i=0;i<60;i++){
  const action=choose(['enqueue','enqueue','enqueue','claimDue','snapshot','recordConflict','complete','retryWithReceipt','completeWithReceipt','checkReceipt','recordReceipt','pendingCount','conflictCount','terminalCount','resetProcessing','listConflicts']);
  const id=1+next()%19,key=choose(['a','b','c','d','e','z','a:queued:2','z:lost:3']);const now=choose(NOW);
  const common={action,now,id,operationKey:key,attempts:1+next()%5,detail:{code:next()%3,nested:{p:true}},error:choose(['temporary','already exists with a different definition']),status:choose(['succeeded','failed','bogus'])};
  if(action==='enqueue')common.request={idempotencyKey:key,operation:choose(['save_task','save_plan','save_job','append_plan']),coalesceKey:choose(['group','another','',undefined]),priority:next()%6,payload:{name:key,seq:i,attrs:[i,i+1]}};
  if(action==='claimDue')common.limit=choose([1,2,3,5,0,12]);
  if(action==='retryWithReceipt')common.nextAttemptAt=choose(NOW);
  if(action==='recordConflict')common.diagnostic={kind:choose(['task','plan']),jobId:'job1',subjectId:'task1',operation:'save_task',operationKey:key,localDefinition:{v:1},remoteDefinition:{v:2},divergingFields:['v'],detectedAt:now,message:'different definition'};
  steps.push(common);
  if(i%7===0)steps.push({action:'snapshot'});
 }
 steps.push({action:'snapshot'});return {steps,scope};}
function nodeOutput(input){const db=new DatabaseSync(':memory:');try{
 let table=ProjectionOutbox.createTableSql(),receipt=ProjectionOutbox.createReceiptTableSql();
 if(input.scope){table=table.replace('id INTEGER PRIMARY KEY AUTOINCREMENT','scope_job_id TEXT NOT NULL, id INTEGER NOT NULL').replace('idempotency_key TEXT NOT NULL UNIQUE','idempotency_key TEXT NOT NULL').replace('\n      );',',PRIMARY KEY(scope_job_id,id),UNIQUE(scope_job_id,idempotency_key)\n      );');receipt=receipt.replace('operation_key TEXT PRIMARY KEY','scope_job_id TEXT NOT NULL,operation_key TEXT NOT NULL').replace('\n    );',',PRIMARY KEY(scope_job_id,operation_key)\n    );');}
 db.exec(table);db.exec(ProjectionOutbox.createIndexSql());db.exec(receipt);
 const outbox=new ProjectionOutbox(db,input.scope??undefined);const results=[];
 for(const step of input.steps){const now=step.now??NOW[0];let value;try{
  switch(step.action){
   case 'upgrade':value=ProjectionOutbox.upgrade(db,step.previousVersion);break;
   case 'enqueue':value=outbox.enqueue(step.request,now);break;
   case 'claimDue':value=outbox.claimDue(step.limit,new Date(now));break;
   case 'complete':value=outbox.complete(step.id);break;
   case 'recordConflict':value=outbox.recordConflict(step.id,step.diagnostic);break;
   case 'retryWithReceipt':value=outbox.retryWithReceipt(step.id,step.operationKey,step.error,new Date(step.nextAttemptAt),step.attempts,step.detail,now);break;
   case 'completeWithReceipt':value=outbox.completeWithReceipt(step.id,step.operationKey,step.status,step.attempts,step.detail,now);break;
   case 'recordReceipt':value=outbox.recordReceipt(step.operationKey,step.status,step.attempts,step.detail,now);break;
   case 'resetProcessing':value=outbox.resetProcessing(now);break;
   case 'listConflicts':value=outbox.listConflicts();break;
   case 'pendingCount':value=outbox.pendingCount();break;
   case 'terminalCount':value=outbox.terminalCount();break;
   case 'conflictCount':value=outbox.conflictCount();break;
   case 'checkReceipt':value=db.prepare('SELECT status FROM projection_receipt WHERE operation_key=?').get(step.operationKey)?.status??null;break;
   case 'snapshot':value={rows:db.prepare('SELECT id,idempotency_key,operation_key,coalesce_key,operation,payload_json,priority,status,attempts,next_attempt_at,last_error,created_at,updated_at,conflict_definition_json,conflict_evidence_json,conflict_detected_at,conflict_disposition,conflict_resolution_json FROM projection_outbox ORDER BY id').all(),receipts:db.prepare('SELECT operation_key,status,attempts,detail_json,recorded_at FROM projection_receipt ORDER BY operation_key').all()};break;
   default:throw new Error('unknown action '+step.action);
  }
  results.push(JSON.parse(JSON.stringify({ok:true,value:value??null})));
 }catch(_){results.push({ok:false});}
 }
 return results;
}finally{db.close()}}
const cases=Array.from({length:52},scenario);
const compile=spawnSync('cargo',['build','--offline','--example','worker_c_outbox_parity','--manifest-path','rust/Cargo.toml'],{cwd:repo,encoding:'utf8',maxBuffer:5e6});assert.equal(compile.status,0,compile.stderr);
const exe=resolve(repo,'rust/target/debug/examples/worker_c_outbox_parity');
test('projection outbox deterministic differential with in-memory SQLite and transaction rollback',()=>{
 const proc=spawnSync(exe,[],{input:cases.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',maxBuffer:32*1024*1024});assert.equal(proc.status,0,proc.stderr);
 const actual=proc.stdout.trimEnd().split('\n').map(JSON.parse);assert.equal(actual.length,cases.length);
 const differences=[];let pass=0;
 for(let i=0;i<cases.length;i++){
  const expected=nodeOutput(cases[i]);const rust=actual[i];try{assert.deepStrictEqual(rust,{ok:true,value:expected});pass+=expected.length;}catch(e){
    let ix=-1;if(rust.ok){ix=expected.findIndex((v,j)=>{try{assert.deepStrictEqual(rust.value[j],v);return false}catch{return true}})}
    differences.push({scenario:i,firstStep:ix,action:cases[i].steps[ix]?.action,expected:JSON.stringify(expected[ix]).slice(0,1200),actual:JSON.stringify(rust.value?.[ix]).slice(0,1200),error:e.message.slice(0,350)});
  }
 }
 for(const bad of differences.slice(0,12))console.log(JSON.stringify(bad));
 assert.equal(differences.length,0,`${differences.length} scenarios diverged`);
 console.log(`PASS ${pass} SQL transition/receipt/rollback observations across ${cases.length} seeded scenarios`);
});
