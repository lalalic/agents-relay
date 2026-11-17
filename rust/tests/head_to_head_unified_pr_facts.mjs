// Direct Node/Rust SQLite differential for src/unified-pr-facts.ts: isolated in-memory PR facts, monotonic observed_at and Job scope.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';import {resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {saveUnifiedPullRequestFacts} from '../../dist/unified-pr-facts.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let compiled=false;
function rust(req){if(!compiled){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);compiled=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify({op:'unifiedPullRequestFactsScenario',...req})+'\n',encoding:'utf8',timeout:20000,maxBuffer:4*1024*1024});assert.equal(r.status,0,`${r.error}: ${r.stderr}`);return JSON.parse(r.stdout.trim());}
function normalizedFailure(msg){if(/CHECK constraint failed|FOREIGN KEY constraint failed|NOT NULL constraint failed/i.test(msg))return msg.replace(/^.*?((?:CHECK|FOREIGN KEY|NOT NULL) constraint failed).*$/i,'$1');return msg;}
function node(req){
 try{
 const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE source_registry(job_id TEXT PRIMARY KEY);
 CREATE TABLE pull_request_facts(scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id),id INTEGER NOT NULL CHECK(id=1),state TEXT NOT NULL CHECK(state IN ('OPEN','MERGED','CLOSED')),head_ref TEXT,head_sha TEXT,observed_at TEXT NOT NULL,PRIMARY KEY(scope_job_id,id));`);
 for(const job of req.jobs)db.prepare('INSERT INTO source_registry VALUES(?)').run(job);
 const operations=[];
 for(const op of req.operations){
  try{saveUnifiedPullRequestFacts(db,op.jobId,op.facts);operations.push({ok:true})}
  catch(error){operations.push({ok:false,error:normalizedFailure(error.message)})}
 }
 const rows=db.prepare('SELECT scope_job_id,id,state,head_ref,head_sha,observed_at FROM pull_request_facts ORDER BY scope_job_id,id').all().map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,typeof value==='bigint'?Number(value):value])));
 db.close();return {ok:true,value:{operations,rows}};
 }catch(error){return {ok:false,error:normalizedFailure(error.message)}}
}
function norm(result){return result.ok?{ok:true,value:{...result.value,operations:result.value.operations.map(item=>item.ok?item:{ok:false,error:normalizedFailure(item.error)})}}:{ok:false,error:normalizedFailure(result.error)}};
let seed=0x51ff23a9;function rand(n){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;}const choice=xs=>xs[rand(xs.length)];
const scenarios=[
 {jobs:['1'],operations:[{jobId:'1',facts:{state:'OPEN',head:{ref:'feature',sha:'111'},observedAt:'2026-01-01T00:00:00Z'}}]},
 {jobs:['1'],operations:[{jobId:'1',facts:{state:'MERGED',head:{ref:'main',sha:'111'},observedAt:'2026-01-01T00:00:00Z'}},{jobId:'1',facts:{state:'OPEN',head:{ref:'feature',sha:'222'},observedAt:'2026-01-02T00:00:00Z'}}]},
 {jobs:['1','2'],operations:[{jobId:'1',facts:{state:'CLOSED',observedAt:'2026-01-01T00:00:00Z'}},{jobId:'2',facts:{state:'OPEN',observedAt:'2026-01-01T00:00:00Z'}}]},
 {jobs:['1'],operations:[{jobId:'missing',facts:{state:'OPEN',observedAt:'2026-01-01T00:00:00Z'}}]},
];
for(let i=0;i<360;i++){
 const jobs=Array.from({length:1+rand(5)},(_,j)=>`job-${i}-${j}`);
 const ops=[];
 const n=1+rand(15);
 for(let j=0;j<n;j++){
  const day=1+rand(20),hour=rand(24),minute=rand(60);
  const observedAt=`2026-11-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00.000Z`;
  const facts={state:choice(['OPEN','CLOSED','MERGED']),observedAt,head:choice([null,undefined,{ref:`branch-${i}-${j}`,sha:`sha-${j}`},{ref:'main'},{}])};
  ops.push({jobId:choice([...jobs,...jobs,'unknown']),facts});
 }
 scenarios.push({jobs,operations:ops});
}
test('in-memory SQLite PR projection is monotonic, same-time deterministic and Job-scoped as Node',()=>{
 for(const [i,req] of scenarios.entries())assert.deepEqual(norm(rust(req)),node(req),`PR SQLite case ${i}: ${JSON.stringify(req).slice(0,550)}`);
 console.log(`Verified ${scenarios.length} Node/Rust in-memory SQLite PR facts scenarios`);
});
