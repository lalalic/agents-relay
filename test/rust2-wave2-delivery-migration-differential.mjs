// Offline Node/Rust migration parity: disposable Git roots, SQLite, backup and
// negative preflight. No existing projects, credentials or live stores.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
const tmp=mkdtempSync(join(tmpdir(),'rust2-wave2-migration-'));
process.env.AGENTS_RELAY_STORE_DIR=join(tmp,'stores');
const {migrateJobLocalRepositories,migrationBackupPath}=await import('../dist/job-local-repository-migration.js');
const rust=resolve('rust/target/debug/relay-rust2-parity');
let count=0;
function rustCall(req){
  const p=spawnSync(rust,[],{input:JSON.stringify({op:'deliveryWave2',...req})+'\n',encoding:'utf8',timeout:30000});
  assert.equal(p.status,0,p.stderr);
  const result=JSON.parse(p.stdout.trim());
  if(!result.ok)throw new Error(result.error);
  return result.value;
}
function git(cwd,...args){execFileSync('git',['-C',cwd,...args],{stdio:'ignore'});}
function fixture(name,variation='positive'){
  const root=join(tmp,name);mkdirSync(root);
  const first=join(root,'neo','vlog'),second=join(root,'other-root');
  mkdirSync(first,{recursive:true});mkdirSync(second);
  git(root,'init','-q',first);git(root,'init','-q',second);
  const dbPath=join(root,'relay.sqlite'),mapping=join(root,'mapping.json');
  const db=new DatabaseSync(dbPath);
  db.exec('CREATE TABLE source_registry(job_id TEXT PRIMARY KEY,source_file TEXT,repository TEXT,pr_number INTEGER); CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT,updated_at TEXT); CREATE TABLE event_receipt(job_id TEXT,event_id TEXT,body TEXT); CREATE TABLE migration_metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE projection_outbox(scope_job_id TEXT,id INTEGER,operation TEXT,payload_json TEXT,conflict_definition_json TEXT,conflict_evidence_json TEXT,conflict_resolution_json TEXT);');
  const a={id:'91',title:'historical',repository:'local/neo-vlog',githubRepo:'old/repo',
    tasks:[{id:'a',input:'keep',nested:{repository:'old/dependent'}}],unblocks:[{repository:'old/dependent'}]};
  const b={id:'92',title:'dependent',repository:'old/dependent',tasks:[]};
  for(const row of [a,b]){
    db.prepare('INSERT INTO source_registry VALUES(?,?,?,?)').run(row.id,'unified:'+row.id,row.repository,0);
    db.prepare('INSERT INTO job_snapshot VALUES(?,?,?)').run(row.id,JSON.stringify(row),'2026-01-01');
  }
  db.prepare('INSERT INTO event_receipt VALUES(?,?,?)').run('91','event-1','unchanged');
  const op=variation==='remote-missing'?'create_pull_request':
    variation==='external'?'close_pull_request':'append_task';
  db.prepare('INSERT INTO projection_outbox VALUES(?,?,?,?,?,?,?)').run('91',1,op,
    JSON.stringify({repository:'local/neo-vlog',ref:{repository:'old/dependent'}}),
    JSON.stringify({repository:'old/dependent'}),null,null);
  if(variation==='missing-registry')db.prepare('DELETE FROM source_registry WHERE job_id=?').run('92');
  db.close();
  let jobs=[{jobId:'91',projectRoot:first},{jobId:'92',projectRoot:second}];
  if(variation==='missing-mapping')jobs.pop();
  if(variation==='bad-remote')jobs[0].githubRepo='invalid/no/more';
  if(variation==='external')jobs[0].githubRepo='owner/external';
  if(variation==='collision') {
    const collision=join(root,'elsewhere','vlog');
    mkdirSync(collision,{recursive:true});git(root,'init','-q',collision);
    jobs[1].projectRoot=collision;
  }
  writeFileSync(mapping,JSON.stringify({version:1,jobs}));
  return {root,dbPath,mapping};
}
function snapshot(f){
  const db=new DatabaseSync(f.dbPath,{readOnly:true});
  try{
    return {
      jobs:db.prepare('SELECT job_id,json FROM job_snapshot ORDER BY job_id').all().map(row=>[row.job_id,JSON.parse(row.json)]),
      registry:db.prepare('SELECT job_id,repository FROM source_registry ORDER BY job_id').all(),
      receipts:db.prepare('SELECT * FROM event_receipt ORDER BY event_id').all(),
      outbox:db.prepare('SELECT operation,payload_json,conflict_definition_json,conflict_evidence_json FROM projection_outbox').all()
        .map(x=>({...x,payload_json:JSON.parse(x.payload_json),conflict_definition_json:JSON.parse(x.conflict_definition_json)})),
      metadata:db.prepare('SELECT key FROM migration_metadata ORDER BY key').all()
    };
  }finally{db.close();}
}
function normalize(value,root){return JSON.parse(JSON.stringify(value).replaceAll(root,'<ROOT>'));}
async function comparison(variation){
  const n=fixture('node-'+variation,variation),r=fixture('rust-'+variation,variation);
  const oldN=snapshot(n),oldR=snapshot(r);
  assert.deepStrictEqual(normalize(oldN,n.root),normalize(oldR,r.root));count++;
  let ne,re;
  try{ne=await migrateJobLocalRepositories(n.dbPath,n.mapping);}catch(e){ne={error:String(e.message)};}
  try{re=rustCall({case:'migration',database:r.dbPath,mapping:r.mapping});}catch(e){re={error:String(e.message)};}
  assert.equal(Boolean(ne.error),Boolean(re.error),'outcome '+variation+' '+JSON.stringify({ne,re}));count++;
  if(!ne.error) {
    assert.equal(ne.migrated,re.migrated);
    assert.equal(ne.backupPath.replace(n.root,'<ROOT>'),re.backupPath.replace(r.root,'<ROOT>'));count++;
    assert.deepStrictEqual(normalize(snapshot(n),n.root),normalize(snapshot(r),r.root),'migrated '+variation);count++;
    const backN=new DatabaseSync(ne.backupPath,{readOnly:true});
    const backR=new DatabaseSync(re.backupPath,{readOnly:true});
    try{
      assert.equal(backN.prepare('SELECT COUNT(*) AS n FROM job_snapshot').get().n,2);
      assert.equal(backR.prepare('SELECT COUNT(*) AS n FROM job_snapshot').get().n,2);
      assert.equal(JSON.parse(backR.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get('91').json).repository,'local/neo-vlog');
      count++;
    }finally{backN.close();backR.close();}
    const secondNode=await migrateJobLocalRepositories(n.dbPath,n.mapping);
    const secondRust=rustCall({case:'migration',database:r.dbPath,mapping:r.mapping});
    assert.equal(secondNode.migrated,secondRust.migrated);count++;
    assert.deepStrictEqual(normalize(snapshot(n),n.root),normalize(snapshot(r),r.root));count++;
  }else{
    assert.deepStrictEqual(normalize(snapshot(n),n.root),normalize(oldN,n.root),'node preflight intact');
    assert.deepStrictEqual(normalize(snapshot(r),r.root),normalize(oldR,r.root),'Rust preflight intact');count+=2;
  }
  console.log('PASS migration',variation,ne.error?'negative':'positive');
}
try {
  for(const variation of ['positive','external','missing-mapping','bad-remote','collision','missing-registry','remote-missing']){
    await comparison(variation);
  }
  console.log('PASS Rust2 worker C migration differential assertions='+count);
}finally{rmSync(tmp,{recursive:true,force:true});}
