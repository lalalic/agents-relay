import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync,statSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createConnection} from 'node:net';
import {DatabaseSync} from 'node:sqlite';

const target=process.env.CARGO_TARGET_DIR ?? resolve(import.meta.dirname,'../target');
const cli=join(target,'debug/relay-native-job');
const daemon=join(target,'debug/relay-native-daemon');
const helper=join(target,'debug/relay-worker-helper');
const marker='rust-relay-owned-standalone-namespace-v1\n';
function fixture(){
 const home=mkdtempSync('/tmp/rr-');
 const root=join(home,'.local/state/agents-relay/rust-live');
 mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);
 writeFileSync(join(root,'.relay-rust-live-namespace-v1'),marker,{mode:0o600});
 writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'isolated-test',{mode:0o600});
 writeFileSync(join(root,'manifest.json'),JSON.stringify({agents:{}}),{mode:0o600});
 const db=join(root,'relay.sqlite');
 const env={...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'pilot-live',RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'',AGENTS_RELAY_STORE_DIR:join(home,'node-store')};
 mkdirSync(env.AGENTS_RELAY_STORE_DIR,{recursive:true});
 // Native production CLI deliberately does not expose live database bootstrap.
 // Provision the exact canonical isolated schema in this disposable fixture.
 const sqlite=new DatabaseSync(db);
 sqlite.exec('PRAGMA journal_mode=WAL; CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE relay_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE agent_snapshot(agent_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);');
 sqlite.close();chmodSync(db,0o600);
 return {home,root,db,env,socket:join(root,'.rc.sock')};
}
function start(f){
 const child=spawn(daemon,['--loop','--db',f.db,'--manifest',join(f.root,'manifest.json'),'--helper',helper,'--interval-ms','100'],{env:f.env,stdio:['ignore','pipe','pipe']});
 child.stderrText='';child.stderr.on('data',chunk=>child.stderrText+=chunk.toString());return child;
}
async function waitForSocket(f,child){
 for(let i=0;i<100;i++){
  if(existsSync(f.socket)) return;
  if(child.exitCode!==null) throw new Error(`daemon exited: ${child.exitCode}: ${child.stderrText}`);
  await delay(20);
 }
 throw new Error('daemon control socket did not start');
}
function createArgs(f,extra=[]){return ['job','create','--db',f.db,'--repo','agents-relay','--id','861','--objective','A native daemon controlled Job','--project-root',f.root,...extra];}
function invoke(f,args){return spawnSync(cli,args,{env:{...f.env,PATH:'/no-native-fallback'},encoding:'utf8',timeout:8000});}
async function rawRequest(socket,request){
 return await new Promise((resolvePromise,reject)=>{
  const client=createConnection(socket);let data='';
  client.on('connect',()=>client.write(`${JSON.stringify(request)}\n`));
  client.on('data',chunk=>{data+=chunk.toString();if(data.includes('\n')){client.end();resolvePromise(JSON.parse(data.trim()));}});
  client.on('error',reject);
 });
}
function readJob(db){
 const sql=new DatabaseSync(db);try{return JSON.parse(sql.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get('861').json);}finally{sql.close();}
}
async function stop(child){
 if(child.exitCode!==null)return;
 child.kill('SIGTERM');
 await Promise.race([new Promise(resolvePromise=>child.once('exit',resolvePromise)),delay(3000)]);
 if(child.exitCode===null){child.kill('SIGKILL');await new Promise(resolvePromise=>child.once('exit',resolvePromise));}
}

test('native control socket is single-writer, authenticated, allowlisted, and restart-deduplicated', {concurrency:false}, async()=>{
 const f=fixture();let child;
 try{
  child=start(f);await waitForSocket(f,child);
  assert.equal(statSync(f.socket).mode & 0o777,0o600,'socket is private');
  const rejected=await rawRequest(f.socket,{version:1,operation:'job.delete',repository:'agents-relay',id:'861',title:'x',objective:'x',project_root:f.root,project_path:null,priority:'P2',review_enabled:false,auto_merge:false});
  assert.equal(rejected.ok,false);assert.match(rejected.error,/unsupported native control operation/);
  assert.equal(statSync(f.socket).isSocket(),true,'private endpoint is a Unix socket');
  const oversized=await rawRequest(f.socket,{version:1,operation:'job.create',repository:'agents-relay',id:'861',title:'x',objective:'x'.repeat(70000),project_root:f.root,project_path:null,priority:'P2',review_enabled:false,auto_merge:false});
  assert.equal(oversized.ok,false);assert.match(oversized.error,/exceeds 64 KiB/);
  const invalid=invoke(f,createArgs(f,['--priority','P8']));
  assert.equal(invalid.status,2,invalid.stderr);assert.match(invalid.stderr,/priority must be P0, P1, P2, or P3/);
  const blocked=invoke(f,['job','update','--db',f.db,'--job-id','861','--title','No direct writes']);
  assert.equal(blocked.status,2);assert.match(blocked.stderr,/only job create through the daemon control socket/);
  const sql=new DatabaseSync(f.db);assert.equal(sql.prepare('SELECT count(*) AS n FROM job_snapshot').get().n,0);sql.close();
  const created=invoke(f,createArgs(f));assert.equal(created.status,0,created.stderr);assert.equal(JSON.parse(created.stdout).created,true);
  assert.deepEqual(readJob(f.db).repository,'agents-relay');
  await stop(child);child=null;assert.equal(existsSync(f.socket),false,'daemon removes socket on shutdown');
  child=start(f);await waitForSocket(f,child);
  const duplicate=invoke(f,createArgs(f));assert.equal(duplicate.status,0,duplicate.stderr);
  assert.equal(JSON.parse(duplicate.stdout).created,false);assert.equal(JSON.parse(duplicate.stdout).deduplicated,true);
  const mismatch=invoke(f,createArgs(f,['--title','different']));
  assert.equal(mismatch.status,2);assert.match(mismatch.stderr,/different immutable create identity/);
  const check=new DatabaseSync(f.db);assert.equal(check.prepare('SELECT count(*) AS n FROM job_snapshot').get().n,1);check.close();
  assert.equal(readJob(f.db).title,'Agents Relay job');
 }finally{if(child)await stop(child);rmSync(f.home,{recursive:true,force:true});}
});

test('native live mutation fails closed without daemon socket and never falls back to Node',()=>{
 const f=fixture();try{
  const result=invoke(f,createArgs(f));assert.equal(result.status,2);assert.match(result.stderr,/control socket unavailable/);
  const sql=new DatabaseSync(f.db);assert.equal(sql.prepare('SELECT count(*) AS n FROM job_snapshot').get().n,0);sql.close();
 }finally{rmSync(f.home,{recursive:true,force:true});}
});
