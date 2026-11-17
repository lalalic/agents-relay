// Direct Node/Rust differential for src/legacy-blocked-task-migration.ts and src/job-pr-number-migration.ts, against real in-memory SQLite and exact record serialization.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {normalizeLegacyTaskLifecycle} from '../../dist/types.js';
import {normalizeLegacyJobPrNumber,migrateLegacyJobPrNumbers} from '../../dist/job-pr-number-migration.js';
import {migrateLegacyBlockedTasks} from '../../dist/legacy-blocked-task-migration.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let built=false;
function rust(req){if(!built){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);built=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:15000,maxBuffer:7*1024*1024});assert.equal(r.status,0,`${r.error}: ${r.stderr}`);return JSON.parse(r.stdout.trim());}
function node(req){try{
 let value;
 if(req.op==='normalizeLegacyTaskLifecycle')value=normalizeLegacyTaskLifecycle(structuredClone(req.task));
 if(req.op==='normalizeLegacyJobPrNumber')value=normalizeLegacyJobPrNumber(structuredClone(req.job));
 if(req.op==='legacyMigrationsScenario'){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);
     CREATE TABLE changed_rows(job_id TEXT);CREATE TRIGGER job_updates AFTER UPDATE ON job_snapshot BEGIN INSERT INTO changed_rows VALUES(new.job_id);END;`);
  for(const job of req.jobs)db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run(job.id,JSON.stringify(job),'ORIGINAL');
  let status;try{if(req.migration==='blocked')migrateLegacyBlockedTasks(db);else migrateLegacyJobPrNumbers(db);status={ok:true}}
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
const jobs=[];
for(let i=0;i<1000;i++){
 const oldPr=choice([undefined,null,0,7,15,22,-1,1.5]);const newPr=choice([undefined,null,0,-1,1,3,1.5]);
 const newTasks=Array.from({length:rand(6)},(_,j)=>({id:`t${i}_${j}`,agentName:choice(['editor','reviewer','troubleshooter',undefined,'']),
  title:choice([undefined,null,'','   ','Existing Title',' \u00a0 ']),
  input:choice(['hello','  # A new task \nSecond','- First line','   ','\n\n','中文 Task 描述','🎬 Scene '.repeat(22)])}));
 jobs.push({id:String(i),repository:'repo',prNumber:newPr,externalPrNumber:oldPr,state:'COMPLETED',tasks:newTasks});
}
jobs.push({id:'surrogate-boundary',repository:'repo',prNumber:0,externalPrNumber:12,state:'COMPLETED',
 tasks:[{id:'s1',agentName:'editor',input:'A'.repeat(92)+'🙂'+('more'.repeat(8))}]});
test('Node/Rust direct normalization of historical Task state and PR number/title fields',()=>{
 let checked=0;
 for(const task of tasks){const req={op:'normalizeLegacyTaskLifecycle',task};assert.deepEqual(rust(req),node(req),`Task normalization ${checked}`);checked++;}
 for(const job of jobs){const req={op:'normalizeLegacyJobPrNumber',job};assert.deepEqual(rust(req),node(req),`Job normalization ${checked}`);checked++;}
 console.log(`Verified ${checked} direct Node/Rust historical normalization fixtures`);
});
test('SQLite migrations rewrite only changed job snapshots, preserving all other durable fields',()=>{
 let checked=0;
 for(let i=0;i<190;i++){
  const migration=choice(['blocked','pr']);
  const selected=Array.from({length:1+rand(12)},(_,index)=>{
    const id=`${i}-${index}`;
    if(migration==='blocked')return {id,state:'COMPLETED',repository:'repo',prNumber:0,metadata:{keep:'unchanged'},
       tasks:Array.from({length:rand(7)},()=>choice(tasks))};
    const template=choice(jobs);return {...structuredClone(template),id,metadata:{keep:'unchanged'}};
  });
  if(migration==='pr' && i%10===0){
   selected.push({id:`${i}-surrogate`,repository:'repo',prNumber:0,externalPrNumber:7,
    tasks:[{id:'t-surrogate',agentName:'editor',input:'A'.repeat(92)+'🙂'+('more'.repeat(8))}]});
  }
  const req={op:'legacyMigrationsScenario',migration,jobs:selected};
  const expected=node(req),actual=rust(req);
  assert.deepEqual(actual,expected,`SQLite migration ${i}: ${JSON.stringify(req).slice(0,450)}`);checked++;
 }
 console.log(`Verified ${checked} real in-memory SQLite historical migration/unchanged-record histories`);
});
