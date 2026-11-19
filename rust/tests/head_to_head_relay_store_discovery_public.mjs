// Three original Node src/relay-store-discovery.ts exports vs native Rust
// read-only local SQLite inventory and immutable Job scopes. Disposable DBs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import * as source from '../../dist/relay-store-discovery.js';
const root=resolve(import.meta.dirname,'../..');
const bin=resolve(root,'rust/target/debug/relay-rust2-parity');
const base=mkdtempSync(join(tmpdir(),'rust2-store-discovery-'));
test.after(()=>rmSync(base,{recursive:true,force:true}));
function dirs(name){const path=join(base,name);mkdirSync(join(path,'stores'),{recursive:true});return join(path,'stores');}
const noDb=dirs('missing'),legacy=dirs('legacy'),empty=dirs('empty'),populated=dirs('populated');
writeFileSync(join(base,'legacy','old.db'),'not a SQLite DB');
function seed(path,withRegistry=true,withRows=false){
 const db=new DatabaseSync(source.relayUnifiedStorePath(path));
 db.exec('CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE publication_state(job_id TEXT NOT NULL PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE pull_request_facts(scope_job_id TEXT NOT NULL,id INTEGER NOT NULL,state TEXT NOT NULL,head_ref TEXT,head_sha TEXT,observed_at TEXT);');
 if(withRegistry)db.exec('CREATE TABLE source_registry(job_id TEXT PRIMARY KEY,repository TEXT NOT NULL,pr_number INTEGER NOT NULL);');
 if(withRows){
  const job=id=>({id,repository:'repo',title:'Local '+id,state:'ACTIVE',prNumber:0,createdAt:'2026-11-18T00:00:00.000Z',updatedAt:'2026-11-18T00:00:00.000Z',tasks:[],plans:[]});
  db.prepare('INSERT INTO source_registry VALUES(?,?,?)').run('17','repo',7);
  db.prepare('INSERT INTO source_registry VALUES(?,?,?)').run('18','repo',7);
  db.prepare('INSERT INTO source_registry VALUES(?,?,?)').run('20','other',19);
  for(const id of ['20','17','18'])db.prepare('INSERT INTO job_snapshot(job_id,json) VALUES(?,?)').run(id,JSON.stringify(job(id)));
  db.prepare('INSERT INTO publication_state(job_id,json) VALUES(?,?)').run('17',JSON.stringify({status:'succeeded',audit:'fixture'}));
  db.prepare('INSERT INTO pull_request_facts(scope_job_id,id,state,head_ref,head_sha,observed_at) VALUES(?,?,?,?,?,?)')
    .run('17',1,'OPEN','refs/heads/feature','a'.repeat(40),'2026-11-18T00:00:00.000Z');
 }
 db.close();
}
seed(empty,false);seed(populated,true,true);
const fixtures=[];
for(const directory of [noDb,legacy,empty,populated])fixtures.push({op:'certRelayStoreDiscovery',action:'path',directory},{op:'certRelayStoreDiscovery',action:'inventory',directory});
for(const [directory,repository,prNumber,hintId] of [
 [noDb,'repo',7,'arbitrary'],[empty,'repo',7,'17'],
 [empty,'repo',7,null],[populated,'repo',7,null],[populated,'repo',7,'17'],
 [populated,'repo',7,'999'],[populated,'repo',19,'17'],
 [populated,'other',19,null],[populated,'other',19,'20'],
 [populated,'missing',3,null],[populated,'repo',0,'17'],
 ])fixtures.push({op:'certRelayStoreDiscovery',action:'scope',directory,repository,prNumber,hintId});
async function node(q){try{let value;
 if(q.action==='path')value=source.relayUnifiedStorePath(q.directory);
 else if(q.action==='scope')value=source.resolveUnifiedJobScope(q.directory,q.repository,q.prNumber,q.hintId??undefined);
 else value=await source.discoverLocalRelayStoreSnapshots(q.directory);
 return {ok:true,value};
 }catch(error){return {ok:false,error:error.message}}
}
test('19 Node/Rust public SQLite inventory, immutable scopes, no-store and legacy errors',async()=>{
 const expected=await Promise.all(fixtures.map(node));
 const result=spawnSync(bin,[],{input:fixtures.map(JSON.stringify).join('\n')+'\n',cwd:root,encoding:'utf8',timeout:45000});
 assert.equal(result.status,0,result.stderr||result.error?.message);
 const actual=result.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,fixtures.length);
 for(let i=0;i<fixtures.length;i++)assert.deepEqual(actual[i],expected[i],`Original Node/Rust inventory fixture ${i}: ${JSON.stringify(fixtures[i])}`);
 console.log(`${fixtures.length} direct SQLite Node/Rust discovery operations verified`);
});
