// Direct Node/Rust differential for blocked Task migration with disposable SQLite.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {normalizeLegacyTaskLifecycle} from '../../dist/types.js';
import {migrateLegacyBlockedTasks} from '../../dist/legacy-blocked-task-migration.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let built=false;
function rust(req){if(!built){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);built=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:15000,maxBuffer:7*1024*1024});assert.equal(r.status,0,`${r.error}: ${r.stderr}`);return JSON.parse(r.stdout.trim());}
function node(req){try{
 let value;
 if(req.op==='normalizeLegacyTaskLifecycle')value=normalizeLegacyTaskLifecycle(structuredClone(req.task));
 if(req.op==='legacyMigrationsScenario'){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);
     CREATE TABLE changed_rows(job_id TEXT);CREATE TRIGGER job_updates AFTER UPDATE ON job_snapshot BEGIN INSERT INTO changed_rows VALUES(new.job_id);END;`);
  for(const job of req.jobs)db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run(job.id,JSON.stringify(job),'ORIGINAL');
  let status;try{migrateLegacyBlockedTasks(db);status={ok:true}}
  catch(error){status={ok:false,error:error.message}}
  const rows=db.prepare('SELECT job_id,json,updated_at FROM job_snapshot ORDER BY job_id').all()
    .map(row=>({job_id:row.job_id,json:JSON.parse(row.json),updated_at:row.updated_at}));
  const changed=db.prepare('SELECT job_id FROM changed_rows ORDER BY job_id').all().map(row=>row.job_id);
  db.close();value={status,rows,changed};
 }
 return {ok:true,value:JSON.parse(JSON.stringify(value))};
 }catch(error){return {ok:false,error:error.message}}
}
let seed=0xbaccc097;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};const choice=xs=>xs[rand(xs.length)];
const tasks=[];
for(let i=0;i<1400;i++){
 const state=choice(['BLOCKED','UNBLOCKED','DRAFT','QUEUED','FAILED','RUNNING','AWAITING_DECISION']);
 const task={id:String(i),state,agentName:choice(['worker','reviewer','troubleshooter','planner','']),kind:choice(['task','planner','worker']),
   input:choice(['hello world','# Hi\nTask','- Review','中文页面\n这里是第二行']),updatedAt:choice(['2026-11-16T21:00:00.000Z','2026-11-16T19:00:00Z','invalid']),
   attempt:choice([0,1,2,3,10]),maxAttempts:choice([undefined,0,1,2,3,7]),
   failureReason:choice([undefined,null,'','worker_outcome_unknown','existing']),
   error:choice([undefined,null,'','Failed with error']),
   executionId:choice([undefined,null,'',`exec-${i}`]),
   unblock:choice([undefined,null,{event:'old',at:'2026-11-15T00:00:00Z'}]),
   interactiveInvocation:choice([undefined,{status:'awaiting_decision',boundAt:'2026-11-16T18:00:00Z'},
        {status:'decided',boundAt:'2026-11-16T18:00:00Z',decidedAt:'2026-11-16T21:01:00Z'},
        {status:'decided',boundAt:'2026-11-16T18:00:00Z',decidedAt:'2026-11-16T17:00:00Z'},
        {status:'ready',boundAt:null}])};
 tasks.push(task);
}
test('Node/Rust direct normalization of historical Task state',()=>{
 for(let i=0;i<tasks.length;i++){
  const req={op:'normalizeLegacyTaskLifecycle',task:tasks[i]};
  assert.deepEqual(rust(req),node(req),`Task normalization ${i}`);
 }
});
test('SQLite migrations rewrite only changed job snapshots, preserving all other durable fields',()=>{
 let checked=0;
 for(let i=0;i<190;i++){
  const migration='blocked';
  const selected=Array.from({length:1+rand(12)},(_,index)=>{
    const id=`${i}-${index}`;
    return {id,state:'COMPLETED',repository:'repo',metadata:{keep:'unchanged'},
       tasks:Array.from({length:rand(7)},()=>choice(tasks))};
  });
  const req={op:'legacyMigrationsScenario',migration,jobs:selected};
  const expected=node(req),actual=rust(req);
  assert.deepEqual(actual,expected,`SQLite migration ${i}: ${JSON.stringify(req).slice(0,450)}`);checked++;
 }
 console.log(`Verified ${checked} real in-memory SQLite historical migration/unchanged-record histories`);
});
