// Node/Rust differential for src/job-task-id-sequence.ts: real disposable SQLite files, atomic global ID allocation and repository-scoped idempotency.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {allocateEntityId,isGeneratedEntityId} from '../../dist/job-task-id-sequence.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let compiled=false;
function rust(req){if(!compiled){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);compiled=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:15000,maxBuffer:5*1024*1024});assert.equal(r.status,0,`${r.error}: ${r.stderr}`);return JSON.parse(r.stdout.trim());}
const temp=()=>mkdtempSync(join(tmpdir(),'rust2-numeric-ids-'));
function initialize(database,snapshots,sequence){
 const db=new DatabaseSync(database);
 db.exec('CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE sequences(repository TEXT NOT NULL,kind TEXT NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(repository,kind)); CREATE TABLE idempotency(repository TEXT NOT NULL,kind TEXT NOT NULL,request_key TEXT NOT NULL,entity_id TEXT NOT NULL,PRIMARY KEY(repository,kind,request_key));');
 for(const job of snapshots)db.prepare('INSERT INTO job_snapshot VALUES (?,?)').run(job.id,JSON.stringify(job));
 for(const [kind,value] of Object.entries(sequence))db.prepare("INSERT INTO sequences VALUES('*',?,?)").run(kind,value);
 db.close();
}
function state(database){const db=new DatabaseSync(database,{readOnly:true});try{
 const query=(sql)=>db.prepare(sql).all().map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='bigint'?Number(v):v])));
 return {sequences:query('SELECT * FROM sequences ORDER BY repository,kind'),idempotency:query('SELECT * FROM idempotency ORDER BY repository,kind,request_key'),snapshots:query('SELECT * FROM job_snapshot ORDER BY job_id')};
 }finally{db.close()}}
function node(ops,directory){return ops.map(op=>{try{
  return {ok:true,id:allocateEntityId(directory,op.repository,op.kind,op.requestKey,new Set(op.occupied??[]))};
 }catch(error){return {ok:false,error:error.message}}
})}
let seed=0x9a8845ef;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};const pick=xs=>xs[rand(xs.length)];
const names=['1','007','-1','0','12','99999','٣','3','1.0','abc','٩٩','NaN','+1','Infinity','10\n','5 ','99999999999999999'];
test('numeric entity ID grammar matches Node including leading zeros and non-ASCII digits',()=>{
 for(let i=0;i<240;i++){
  const id=pick(names),repository=pick(['a','b','']),kind=pick(['job','task']);
  const req={op:'isGeneratedEntityId',id,repository,kind};
  assert.deepEqual(rust(req),{ok:true,value:isGeneratedEntityId(id,repository,kind)},`grammar ${i}`);
 }
 console.log('Verified 240 numeric entity identifier grammar fixtures');
});
test('Node/Rust allocator produces identical durable sequence and idempotency rows across real SQLite stores',()=>{
 let checked=0;
 for(let i=0;i<170;i++){
  const dir=temp();try{
   const nodeDir=join(dir,'node'),rustDir=join(dir,'rust');mkdirSync(nodeDir);mkdirSync(rustDir);
   const initial=[];
   for(let j=0;j<rand(5);j++){
    const id=String(101+j);
    initial.push({id,repository:pick(['a','b','c']),state:'COMPLETED',tasks:Array.from({length:rand(5)},(_,t)=>({id:String(100+t+j*5)}))});
   }
   const sequence=pick([{}, {task:300},{job:120},{job:200,task:500}]);
   initialize(join(nodeDir,'relay.sqlite'),initial,sequence);initialize(join(rustDir,'relay.sqlite'),initial,sequence);
   const ops=[];
   const count=5+rand(20);
   for(let j=0;j<count;j++){
    const repository=pick(['a','b','c','']);const kind=pick(['job','task']);
    const requestKey=pick([undefined,undefined,'idempotent','job:a','same-value',`unique-${j}`,'', 'one:two']);
    const occupied=pick([[],['1','2','3'],['301','302','303'],['125','126'],[]]);
    ops.push({repository,kind,requestKey,occupied});
   }
   const expected=node(ops,join(nodeDir,'jobs'));
   const actual=rust({op:'jobTaskIdSequenceScenario',directory:join(rustDir,'jobs'),operations:ops});
   assert.deepEqual(actual,{ok:true,value:expected},`allocation ${i}: ${JSON.stringify(ops).slice(0,500)}`);
   assert.deepEqual(state(join(rustDir,'relay.sqlite')),state(join(nodeDir,'relay.sqlite')),`SQLite state ${i}`);
   checked++;
  }finally{rmSync(dir,{recursive:true,force:true})}
 }
 console.log(`Verified ${checked} complete SQLite Job/Task ID allocation histories`);
});
