// Node/Rust head-to-head for src/unified-job-registry.ts on disposable in-memory SQLite, including immutable local repository root and atomic Job creation.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
import {resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {ensureUnifiedJobRegistry,createUnifiedJobIfAbsent} from '../../dist/unified-job-registry.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let compiled=false;
function rust(req){if(!compiled){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);compiled=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify({op:'unifiedJobRegistryScenario',...req})+'\n',encoding:'utf8',timeout:10000,maxBuffer:5*1024*1024});assert.equal(r.status,0,`${r.error}: ${r.stderr}`);return JSON.parse(r.stdout.trim());}
function node(req){
 const db=new DatabaseSync(':memory:');
 db.exec('PRAGMA foreign_keys=ON; CREATE TABLE source_registry(job_id TEXT PRIMARY KEY,source_file TEXT NOT NULL UNIQUE,repository TEXT NOT NULL,pr_number INTEGER NOT NULL); CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);');
 for(const job of req.preexisting)db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run(job.id,JSON.stringify(job),'PREEXISTING');
 const operations=[];
 for(const op of req.operations){
  try{
   const value=op.action==='ensure'
    ?(ensureUnifiedJobRegistry(db,op.job,op.expectedJobId),null)
    :createUnifiedJobIfAbsent(db,op.job,now=>{
       if(op.failWrite)throw new Error('injected snapshot write failed');
       db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run(op.job.id,JSON.stringify(op.job),now);
      });
   operations.push({ok:true,value});
  }catch(error){operations.push({ok:false,error:error.message})}
 }
 const bindings=db.prepare('SELECT job_id,source_file,repository,pr_number FROM source_registry ORDER BY job_id').all().map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='bigint'?Number(v):v])));
 const snapshots=db.prepare('SELECT job_id,json FROM job_snapshot ORDER BY job_id').all().map(row=>({job_id:row.job_id,json:JSON.parse(row.json)}));
 db.close();return {ok:true,value:{operations,bindings,snapshots}};
}
let seed=0x71619b32;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};const choice=xs=>xs[rand(xs.length)];
const base=(id,repository='agents-relay',projectRoot='/opt/agents-relay',prNumber=0)=>({id,repository,projectRoot,prNumber,state:'COMPLETED',tasks:[]});
const scenarios=[
 {preexisting:[],operations:[{action:'create',job:base('10')},{action:'create',job:base('10','other','/opt/other')}]},
 {preexisting:[],operations:[{action:'ensure',job:base('10'),expectedJobId:'10'},{action:'ensure',job:base('10','other'),expectedJobId:'10'}]},
 {preexisting:[],operations:[{action:'ensure',job:base('10','a','/a',0),expectedJobId:'10'},{action:'ensure',job:base('10','a','/a',12),expectedJobId:'10'},{action:'ensure',job:base('10','a','/a',15),expectedJobId:'10'}]},
 {preexisting:[],operations:[{action:'create',job:base('10','a','/first')},{action:'create',job:base('11','a','/second')}]},
 {preexisting:[],operations:[{action:'create',job:base('10'),failWrite:true},{action:'create',job:base('10')}]},
];
for(let i=0;i<450;i++){
 const jobs=Array.from({length:1+rand(6)},(_,j)=>base(`job-${i}-${j}`,choice(['a','b','c']),choice(['/repos/a','/repos/b','/repos/c']),choice([0,0,11,12])));
 const preexisting=choice([[],[],jobs.slice(0,rand(jobs.length+1))]);
 const operations=[];for(let j=0;j<2+rand(14);j++){
  const existing=choice(jobs),mutated=choice([{}, {}, {repository:'a'}, {projectRoot:'/other/root'}, {prNumber:choice([0,12,14])}, {id:`new-${i}-${j}`}]);
  const job={...existing,...mutated};
  const action=choice(['ensure','create','create']);
  operations.push({action,job,expectedJobId:choice([job.id,job.id,`other-${i}`]),failWrite:rand(15)===0});
 }
 scenarios.push({preexisting,operations});
}
test('atomic local Job registration and immutable repository identity match Node SQLite',()=>{
 for(const [i,scenario] of scenarios.entries()){
  const expected=node(scenario),actual=rust(scenario);
  assert.deepEqual(actual,expected,`Unified registry case ${i}: ${JSON.stringify(scenario).slice(0,450)}`);
 }
 console.log(`Verified ${scenarios.length} Node/Rust Job registry and transaction histories`);
});
