// Node/Rust direct differential for src/unified-relay-schema.ts: every SQLite table/index/constraint and startup migration metadata, entirely in-memory.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
import {resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {migrateUnifiedRelaySchema} from '../../dist/unified-relay-schema.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let built=false;
function rust(req){if(!built){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);built=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify({op:'unifiedRelaySchemaScenario',...req})+'\n',encoding:'utf8',timeout:14000,maxBuffer:7*1024*1024});assert.equal(r.status,0,`${r.error}: ${r.stderr}`);return JSON.parse(r.stdout.trim());}
function cleanError(text){return String(text).replace(/^(?:Error: )?/,'').replace(/^(?:SQLITE_CONSTRAINT[^:]*: )?/,'');}
function node(req){try{
 const db=new DatabaseSync(':memory:');if(req.foreignKeys)db.exec('PRAGMA foreign_keys=ON');
 const outcomes=[];
 for(let i=0;i<(req.migrateCount??1);i++)try{migrateUnifiedRelaySchema(db);outcomes.push({ok:true})}catch(error){outcomes.push({ok:false,error:cleanError(error.message)})}
 for(const statement of req.statements??[])try{db.exec(statement);outcomes.push({ok:true})}catch(error){outcomes.push({ok:false,error:cleanError(error.message)})}
 const objects=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all().map(row=>({type:row.type,name:row.name,tbl_name:row.tbl_name,sql:row.sql}));
 const metadata=db.prepare('SELECT key,value FROM migration_metadata ORDER BY key').all().map(row=>({key:row.key,value:row.value}));
 db.close();return {ok:true,value:{outcomes,objects,metadata}};
 }catch(error){return {ok:false,error:cleanError(error.message)}}}
function normalize(result){if(!result.ok)return {ok:false,error:cleanError(result.error)};
 const object={...result.value};object.outcomes=object.outcomes.map(row=>row.ok?row:{ok:false,error:cleanError(row.error)});
 return {ok:true,value:object};
}
const schemaCases=[
 {migrateCount:1},
 {migrateCount:2},
 {migrateCount:3,foreignKeys:true},
 {migrateCount:1,statements:["INSERT INTO source_registry VALUES ('j','file','repo',0)","INSERT INTO source_registry VALUES ('j','different','repo',0)"]},
 {migrateCount:1,statements:["INSERT INTO source_registry VALUES ('j','file','repo',0)","INSERT INTO pull_request_facts VALUES ('j',1,'OPEN','head','sha','2026-11-16')","INSERT INTO pull_request_facts VALUES ('j',2,'OPEN','head','sha','2026-11-16')"]},
 {migrateCount:1,foreignKeys:true,statements:["INSERT INTO source_registry VALUES ('j','file','repo',0)","INSERT INTO projection_outbox(scope_job_id,id,idempotency_key,operation,payload_json,created_at,updated_at) VALUES ('j',1,'k','push','{}','now','now')"]},
 {migrateCount:1,foreignKeys:true,statements:["INSERT INTO pull_request_facts VALUES ('missing',1,'OPEN',null,null,'now')"]},
 {migrateCount:1,statements:["INSERT INTO host_invocation_event VALUES ('j','t','e','i','x','1','approved','accepted','hash','now')","INSERT INTO host_invocation_event VALUES ('j','t','e2','i','x','1','invalid','accepted','hash','now')"]},
];
let seed=0x39141531;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};const pick=items=>items[rand(items.length)];
const mutations=[
 "INSERT INTO source_registry VALUES ('j1','file1','repo',0)",
 "INSERT INTO source_registry VALUES ('j2','file2','repo',0)",
 "INSERT INTO source_registry VALUES ('j1','file3','repo',0)",
 "INSERT INTO migration_metadata VALUES ('schema','another')",
 "INSERT INTO migration_metadata VALUES ('custom','yes')",
 "UPDATE migration_metadata SET value='custom' WHERE key='schema'",
 "INSERT INTO sequences VALUES ('*','task',12)",
 "INSERT INTO idempotency VALUES ('*','task','key','17')",
 "INSERT INTO source_registry VALUES ('j3','file1','newrepo',0)",
 "INSERT INTO pull_request_facts VALUES ('j1',1,'OPEN',null,null,'2026-11-16')",
 "INSERT INTO pull_request_facts VALUES ('j1',1,'MERGED',null,null,'2026-11-17')",
 "INSERT INTO pull_request_facts VALUES ('j1',2,'OPEN',null,null,'2026-11-17')",
 "INSERT INTO pull_request_facts VALUES ('j1',1,'INVALID',null,null,'2026-11-18')",
 "INSERT INTO event_receipt VALUES ('j1','e1','s',1,'now')",
 "INSERT INTO projection_receipt VALUES ('j1','key','succeeded',1,null,'now')",
 "INSERT INTO projection_receipt VALUES ('j1','key2','pending',1,null,'now')",
 "INSERT INTO publication_state VALUES ('j1','{}')",
 "INSERT INTO host_invocation_decision VALUES ('j1','t1','i1','x1','r1','approved',null,'fp','e1','now')",
 "INSERT INTO host_invocation_decision VALUES ('j1','t1','i2','x1','r1','invalid',null,'fp','e2','now')",
];
for(let i=0;i<250;i++){
 schemaCases.push({migrateCount:1+rand(3),foreignKeys:rand(2)===0,
  statements:Array.from({length:rand(11)},()=>pick(mutations))});
}
test('full SQLite master schema and SQL constraint behavior reproduce Node exactly',()=>{
 for(const [i,req] of schemaCases.entries()){
  const expected=normalize(node(req)),actual=normalize(rust(req));
  assert.deepEqual(actual,expected,`schema case ${i}, statements: ${JSON.stringify(req).slice(0,500)}`);
 }
 console.log(`Verified ${schemaCases.length} full SQLite schema and constraint histories`);
});
