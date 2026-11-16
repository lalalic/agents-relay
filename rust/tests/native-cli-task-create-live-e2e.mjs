import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createConnection} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';

const target=process.env.CARGO_TARGET_DIR??resolve(import.meta.dirname,'../target');
const cli=join(target,'debug/relay-native-job');
const daemon=join(target,'debug/relay-native-daemon');
const helper=join(target,'debug/relay-worker-helper');
function invoke(env,args,exit=0,input){
 const p=spawnSync(cli,args,{env,input,encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024});
 assert.equal(p.status,exit,p.stderr||p.stdout);
 return exit===0?JSON.parse(p.stdout):p.stderr;
}
function snapshot(db,id){
 const sql=new DatabaseSync(db);
 try{return JSON.parse(sql.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(id).json);}
 finally{sql.close();}
}
const args=(f,extras=[])=>['task','create','--db',f.db,'--id',f.id,'--repo',f.repo,
 '--input','## A bounded, real Task','--output','file','--output-path',join(f.root,'task-output.txt'),
 '--draft',...extras];
async function raw(socket,body){
 return await new Promise((resolveResult,reject)=>{
  const client=createConnection(socket);let data='';
  client.on('connect',()=>client.write(JSON.stringify(body)+'\n'));
  client.on('data',chunk=>{data+=chunk.toString();if(data.includes('\n')){client.end();resolveResult(JSON.parse(data.trim()));}});
  client.on('error',reject);
 });
}
test('Rust live task create is daemon-owned, Graph-activated, globally numbered, validates parent/deps, handles large Markdown and survives restart',async()=>{
 const home=mkdtempSync('/tmp/rr-tcr-');
 const root=join(home,'.local/state/agents-relay/rust-live');
 mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);
 writeFileSync(join(root,'.relay-rust-live-namespace-v1'),'rust-relay-owned-standalone-namespace-v1\n',{mode:0o600});
 writeFileSync(join(root,'manifest.json'),JSON.stringify({agents:{}}));
 const db=join(root,'relay.sqlite'),id='110',repo='create-repo';
 const sql=new DatabaseSync(db);
 sql.exec('PRAGMA journal_mode=WAL; CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE relay_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE agent_snapshot(agent_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);');
 sql.close();chmodSync(db,0o600);
 const env={...process.env,HOME:home,RELAY_RUST_LIVE_MODE:'pilot-live',RELAY_RUST_EXPERIMENTAL_TEST_ONLY:''};
 const f={home,root,db,id,repo,socket:join(root,'.rc.sock')};
 let child;
 function start(){
  const proc=spawn(daemon,['--loop','--db',db,'--manifest',join(root,'manifest.json'),
    '--helper',helper,'--interval-ms','5000'],{env,stdio:['ignore','pipe','pipe']});
  proc.err='';proc.stderr.on('data',data=>proc.err+=data);return proc;
 }
 async function ready(){
  for(let i=0;i<110;i++){
   if(existsSync(f.socket))return;
   if(child.exitCode!==null)throw Error('Rust daemon failed: '+child.err);
   await delay(20);
  }
  throw Error('Rust daemon socket not ready: '+child.err);
 }
 async function stop(){
  if(!child||child.exitCode!==null)return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(ok=>child.once('exit',ok)),delay(3000)]);
  if(child.exitCode===null){child.kill('SIGKILL');await new Promise(ok=>child.once('exit',ok));}
 }
 try{
  assert.match(invoke(env,args(f),2),/control socket unavailable/);
  child=start();await ready();
  const created=invoke(env,['job','create','--db',db,'--id',id,'--repo',repo,
   '--title','Live Task creation','--objective','Create real native Task',
   '--project-root',root,'--no-review']);
  assert.equal(created.created,true);
  const first=invoke(env,args(f,['--title','Native Task One','--priority','P1','--story-size','L']));
  assert.equal(first.created,true);
  assert.match(first.taskId,/^[1-9]\d*$/);
  assert.equal(first.task.state,'DRAFT');
  assert.equal(first.task.title,'Native Task One');
  assert.equal(first.task.priority,'P1');
  assert.equal(first.task.storySize,'L');
  assert.equal(first.task.input,'## A bounded, real Task');
  assert.equal(snapshot(db,id).state,'ACTIVE','Job Graph activates on Task creation');
  const second=invoke(env,args(f,['--title','Native Dependent Task',
   '--deps',first.taskId,'--parent',first.taskId,
   '--dependency-validity',JSON.stringify({[first.taskId]:'rerun'})]));
  assert.equal(Number(second.taskId),Number(first.taskId)+1);
  assert.equal(second.task.state,'DRAFT');
  assert.deepEqual(second.task.dependencies,[first.taskId]);
  assert.deepEqual(second.task.dependencyValidity,{[first.taskId]:'rerun'});
  assert.equal(second.task.parentTaskId,first.taskId);
  const before=snapshot(db,id);
  const bad=[
   [args(f,['--priority','P99']),/priority/],
   [args(f,['--story-size','XL']),/story-size/],
   [args(f,['--deps','unknown']),/unknown dependency/],
   [args(f,['--parent','unknown']),/unknown parent Task/],
   [args(f,['--deps',first.taskId,'--dependency-validity','{"fake":"rerun"}']),/must identify a declared dependency/],
   [args(f,['--input','duplicate']),/duplicate option/],
   [args(f,['--output','task-pr']),/duplicate option/],
   [args(f,['--task-id','made-up']),/unrecognized/],
   [args(f).map((v,i,a)=>a[i-1]==='--repo'?'forged':v),/repository identity mismatch/],
   [args(f).filter((v,i,a)=>v!=='--repo'&&a[i-1]!=='--repo'),/requires --repo/],
   [args(f).filter((v,i,a)=>v!=='--input'&&a[i-1]!=='--input').concat(['--input-file','/etc/hosts']),/input file must be inside Rust store root|input file/],
  ];
  for(const [a,error] of bad){
   assert.match(invoke(env,a,2),error);
   assert.deepEqual(snapshot(db,id),before,'invalid create consumed Task ID or changed Job');
  }
  const injected=await raw(f.socket,{
    version:1,operation:'task.create',repository:repo,id,
    title:'',objective:'',project_root:'',project_path:null,priority:'',
    review_enabled:false,auto_merge:false,
    task_create:{input:'Injected',outputKind:'file',outputPath:join(root,'file.txt'),
      priority:'P2',storySize:'M',dependencies:[],draft:true,extra:'unsafe'}
  });
  assert.equal(injected.ok,false);assert.match(injected.error,/unsupported Task creation property extra/);
  assert.deepEqual(snapshot(db,id),before);
  const giant='Large input for Rust socket\n'+('Task body. '.repeat(15000));
  assert.ok(Buffer.byteLength(giant)>64*1024);
  const big=invoke(env,args(f).map((v,i,a)=>a[i-1]==='--input'?giant:v));
  assert.equal(big.task.input,giant);
  assert.equal(Number(big.taskId),Number(second.taskId)+1,'oversized input must not break global Task sequence');
  const textPath=join(root,'real-task-input.md');
  writeFileSync(textPath,'# Real UTF-8 input\n这是模型任务内容');
  const file=invoke(env,args(f).filter((v,i,a)=>v!=='--input'&&a[i-1]!=='--input')
    .concat(['--input-file',textPath]));
  assert.equal(file.task.input,'# Real UTF-8 input\n这是模型任务内容');
  const stdin=invoke(env,args(f).filter((v,i,a)=>v!=='--input'&&a[i-1]!=='--input')
    .concat(['--input-file','-']),0,'## Provided through standard input\n');
  assert.equal(stdin.task.input,'## Provided through standard input\n');
  assert.equal(Number(stdin.taskId),Number(file.taskId)+1);
  const durable=snapshot(db,id);
  assert.equal(durable.tasks.length,5);
  assert.equal(durable.tasks.at(-1).id,stdin.taskId);
  await stop();child=null;
  child=start();await ready();
  const reread=invoke(env,['task','show','--db',db,'--id',id,'--repo',repo,'--task-id',stdin.taskId]);
  assert.equal(reread.input,stdin.task.input);
  assert.equal(snapshot(db,id).tasks.length,5);
  const next=invoke(env,args(f,['--title','After Daemon restart']));
  assert.equal(Number(next.taskId),Number(stdin.taskId)+1);
  assert.equal(snapshot(db,id).tasks.length,6);
 }finally{if(child)await stop();rmSync(home,{recursive:true,force:true});}
});
