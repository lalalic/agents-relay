import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createConnection} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';

const bin=process.env.CARGO_TARGET_DIR??resolve(import.meta.dirname,'../target');
const cli=join(bin,'debug/relay-native-job');
const daemon=join(bin,'debug/relay-native-daemon');
const helper=join(bin,'debug/relay-worker-helper');
const isolated={...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test',RELAY_RUST_LIVE_MODE:''};
const run=(env,args,stdin)=>spawnSync(cli,args,{env,input:stdin,encoding:'utf8',timeout:8000});
const ok=(env,args,stdin)=>{
  const p=run(env,args,stdin);
  assert.equal(p.status,0,p.stderr||p.stdout);
  return JSON.parse(p.stdout);
};
function readJob(db,id){
 const sql=new DatabaseSync(db);
 try{
   const r=sql.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(id);
   return r?JSON.parse(r.json):null;
 }finally{sql.close();}
}
function setupIsolated(){
 const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-comment-'));
 mkdirSync(join(root,'project'));
 writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'isolated-test');
 const db=join(root,'relay.sqlite');
 ok(isolated,['init','--db',db]);
 const created=ok(isolated,['job','create','--db',db,'--id','53',
   '--repo','comments-project','--objective','Test Task comments',
   '--project-root',join(root,'project'),'--no-review']);
 assert.equal(created.created,true);
 const task=ok(isolated,['task','create','--db',db,'--id','53','--repo','comments-project',
   '--input','Work sample','--output','file','--output-path',join(root,'project','output.txt')]);
 return {root,db,id:'53',taskId:task.taskId};
}
function args(f,options=['--message','First comment']){
 return ['task','comment','--db',f.db,'--id',f.id,'--repo','comments-project',
   '--task-id',f.taskId,...options];
}
function comments(f){return ok(isolated,['task','comments','--db',f.db,
 '--id',f.id,'--repo','comments-project','--task-id',f.taskId]);}

test('task comment CLI writes immutable append-only UTF-8 history and comments/context reflect it',()=>{
 const f=setupIsolated();
 try{
  const before=readJob(f.db,f.id),task=before.tasks.find(t=>t.id===f.taskId);
  const first=ok(isolated,args(f,['--message','  First line\nSecond line  ']));
  assert.equal(first.text,'First line\nSecond line');
  assert.equal(first.author,'cli');
  assert.equal(first.jobId,f.id);
  assert.equal(first.taskId,f.taskId);
  assert.match(first.id,/^[0-9a-f-]{36}$/);
  assert.ok(first.createdAt);
  const file=join(f.root,'comment.md');
  writeFileSync(file,'  文件内容 with English \n 第二行  ');
  const second=ok(isolated,args(f,['--message-file',file]));
  assert.equal(second.text,'文件内容 with English \n 第二行');
  const third=ok(isolated,args(f,['--message-file','-']),'  stdin comment\n');
  assert.equal(third.text,'stdin comment');
  const history=comments(f);
  assert.deepEqual(history,[first,second,third]);
  assert.equal(new Set(history.map(c=>c.id)).size,3);
  const after=readJob(f.db,f.id),taskAfter=after.tasks.find(t=>t.id===f.taskId);
  assert.deepEqual({...taskAfter,comments:undefined},{...task,comments:undefined},
   'append must not change Task state, generation, attempt, result, timestamps or leases');
  assert.deepEqual(taskAfter.comments,history);
  assert.equal(after.state,before.state);
  assert.notEqual(after.updatedAt,before.updatedAt);
  assert.deepEqual(comments(f),history,'history survives fresh process read');
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('task comment fail-closed validation prevents any mutation for missing identity/invalid text/file',()=>{
 const f=setupIsolated();
 try{
  const original=JSON.stringify(readJob(f.db,f.id));
  const tooLong=join(f.root,'too-long.md');writeFileSync(tooLong,'a'.repeat(60_001));
  const binary=join(f.root,'bad-utf8.md');writeFileSync(binary,Buffer.from([0xff,0xfe]));
  const cases=[
   [args(f,['--message',' ']),/nonempty message/],
   [args(f,['--message','a'.repeat(60_001)]),/at most 60000 bytes/],
   [args(f,['--message-file',tooLong]),/at most 60000 bytes/],
   [args(f,['--message-file',binary]),/must be UTF-8/],
   [args(f,['--message-file',join(f.root,'does-not-exist')]),/message file/],
   [args(f,['--message','x','--message-file','-']),/exactly one/],
   [args(f,['--message','x','--message','y']),/duplicate option/],
   [args(f,['--reason','not-a-comment']),/unrecognized/],
   [args(f,['--message','x']).filter((x,i,a)=>x!=='--repo'&&a[i-1]!=='--repo'),/requires --repo/],
   [args(f,['--message','x']).map((x,i,a)=>a[i-1]==='--repo'?'spoof':x),/repository identity mismatch/],
   [args(f,['--message','x']).map((x,i,a)=>a[i-1]==='--id'?'other':x),/unknown Job/],
   [args(f,['--message','x']).map((x,i,a)=>a[i-1]==='--task-id'?'unknown':x),/Task unknown not found/],
  ];
  for(const [argv,pattern] of cases){
   const p=run(isolated,argv);
   assert.equal(p.status,2,p.stderr);
   assert.match(p.stderr,pattern);
   assert.equal(JSON.stringify(readJob(f.db,f.id)),original,argv.join(' '));
  }
  assert.deepEqual(comments(f),[]);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

function liveFixture(){
 // macOS AF_UNIX SUN_LEN needs a short disposable HOME.
 const home=mkdtempSync('/tmp/rr-cmt-');
 const root=join(home,'.local/state/agents-relay/rust-live');
 mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);
 writeFileSync(join(root,'.relay-rust-live-namespace-v1'),'rust-relay-owned-standalone-namespace-v1\n',{mode:0o600});
 writeFileSync(join(root,'manifest.json'),JSON.stringify({agents:{}}));
 const db=join(root,'relay.sqlite'),socket=join(root,'.rc.sock');
 const sql=new DatabaseSync(db);
 sql.exec('PRAGMA journal_mode=WAL; CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE relay_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE agent_snapshot(agent_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);');
 sql.close();chmodSync(db,0o600);
 const env={...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'pilot-live',
   RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'',AGENTS_RELAY_STORE_DIR:join(home,'not-node-relay')};
 return {root,db,socket,env,home,id:'861',taskId:'task-one'};
}
function start(f){
 const child=spawn(daemon,['--loop','--db',f.db,'--manifest',join(f.root,'manifest.json'),
 '--helper',helper,'--interval-ms','100'],{env:f.env,stdio:['ignore','pipe','pipe']});
 child.stderrText='';
 child.stderr.on('data',data=>child.stderrText+=data);
 return child;
}
async function ready(f,child){
 for(let i=0;i<100;i++){
  if(existsSync(f.socket))return;
  if(child.exitCode!==null)throw Error('Rust daemon exited: '+child.stderrText);
  await delay(20);
 }
 throw Error('Rust daemon socket unavailable: '+child.stderrText);
}
async function stop(child){
 if(!child||child.exitCode!==null)return;
 child.kill('SIGTERM');
 await Promise.race([new Promise(resolveExit=>child.once('exit',resolveExit)),delay(3000)]);
 if(child.exitCode===null){child.kill('SIGKILL');await new Promise(resolveExit=>child.once('exit',resolveExit));}
}
async function raw(socket,body){
 return await new Promise((resolveAnswer,reject)=>{
  const c=createConnection(socket);let data='';
  c.on('connect',()=>c.write(JSON.stringify(body)+'\n'));
  c.on('data',buffer=>{data+=buffer;if(data.includes('\n')){c.end();resolveAnswer(JSON.parse(data.trim()));}});
  c.on('error',reject);
 });
}
test('live task comment uses only the daemon Unix socket single writer, survives restart, preserves active execution lease',async()=>{
 const f=liveFixture();let child;
 try{
  const commentArgs=['task','comment','--db',f.db,'--id',f.id,'--repo','comments-project',
    '--task-id',f.taskId,'--message','Keep existing worker lease'];
  const noDaemon=run(f.env,commentArgs);
  assert.equal(noDaemon.status,2);assert.match(noDaemon.stderr,/control socket unavailable/);
  child=start(f);await ready(f,child);
  const created=ok(f.env,['job','create','--db',f.db,'--id',f.id,'--repo','comments-project',
    '--objective','Live comment test','--project-root',f.root,'--no-review']);
  assert.equal(created.created,true);
  await stop(child);child=null;
  const sql=new DatabaseSync(f.db);
  const j=readJob(f.db,f.id);
  j.tasks=[{id:f.taskId,jobId:f.id,title:'worker',kind:'work',state:'RUNNING',
    attempt:2,executionId:'active-execution-1',leaseOwner:'rust-worker-1',
    leaseExpiresAt:'2099-01-01T00:00:00Z',updatedAt:'2026-11-15T10:00:00Z'}];
  sql.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(j),f.id);
  sql.close();
  const original=readJob(f.db,f.id).tasks[0];
  child=start(f);await ready(f,child);
  const appended=ok(f.env,commentArgs);
  assert.equal(appended.text,'Keep existing worker lease');
  const read=ok(f.env,['task','comments','--db',f.db,'--id',f.id,'--repo','comments-project',
    '--task-id',f.taskId]);
  assert.deepEqual(read,[appended]);
  assert.deepEqual({...readJob(f.db,f.id).tasks[0],comments:undefined},{...original,comments:undefined});
  const denied=run(f.env,commentArgs.map((x,i,a)=>a[i-1]==='--repo'?'forged':x));
  assert.equal(denied.status,2);assert.match(denied.stderr,/repository identity mismatch/);
  const request={
   version:1,operation:'task.comment',repository:'comments-project',id:f.id,
   title:'forged title',objective:'',project_root:'',project_path:null,priority:'',
   review_enabled:false,auto_merge:false,task_id:f.taskId,message:'injected'
  };
  const forged=await raw(f.socket,request);
  assert.equal(forged.ok,false);assert.match(forged.error,/does not accept Job mutation fields/);
  assert.equal(readJob(f.db,f.id).tasks[0].comments.length,1);
  await stop(child);child=null;
  child=start(f);await ready(f,child);
  assert.deepEqual(ok(f.env,['task','comments','--db',f.db,'--id',f.id,
    '--repo','comments-project','--task-id',f.taskId]),[appended]);
  assert.equal(run(f.env,['task','comment','--db',f.db,'--id',f.id,'--repo','comments-project',
    '--task-id','missing','--message','bad']).status,2);
 }finally{if(child)await stop(child);rmSync(f.home,{recursive:true,force:true});}
});
