import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const cli=resolve(import.meta.dirname,'../target/debug/relay-native-job');
const nodeCli=resolve(import.meta.dirname,'../../dist/cli.js');
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-'));
 mkdirSync(join(root,'project/output'),{recursive:true});
 writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'test-only');
 const db=join(root,'relay.sqlite');
 const env={...process.env,AGENTS_RELAY_STORE_DIR:join(root,'node-store'),RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'};
 mkdirSync(env.AGENTS_RELAY_STORE_DIR);
 const call=(args,expected=0)=>{
  const result=spawnSync(cli,args,{env,encoding:'utf8',timeout:12000});
  assert.equal(result.status,expected,result.stderr||result.stdout);
  return expected===0?JSON.parse(result.stdout.trim()):result.stderr;
 };
 const input=join(root,'project/input.md'),graph=join(root,'project/graph.mmd'),output=join(root,'project/output/dag.json');
 writeFileSync(input,'Coordinator input');writeFileSync(graph,'flowchart TD\nbuilder[agent:builder]\n');
 call(['init','--db',db]);
 const created=call(['create','--db',db,'--project-root',join(root,'project'),'--graph-file',graph,
   '--input-file',input,'--output-path',output,'--title','Task creation fixture','--repository','agents-relay','--request-key','root-job']);
 const sql=new DatabaseSync(db);
 try {
  sql.prepare('INSERT INTO job_snapshot(job_id,json,updated_at) VALUES(?,?,?)').run('77',JSON.stringify({
   id:'77',title:'Unrelated fixture',repository:'other',projectRoot:root,state:'ACTIVE',runtimeStatus:'RUNNING',
   updatedAt:'2026-11-14T00:00:00.000Z',tasks:[],plans:[]}),'2026-11-14T00:00:00.000Z');
 }finally{sql.close();}
 return {root,db,env,call,jobId:created.jobId,coordinatorId:created.coordinatorTaskId,input,output};
}
function close(f){rmSync(f.root,{recursive:true,force:true});}
function taskArgs(f,extra=[]){
 return ['task','create','--db',f.db,'--job-id',f.jobId,'--input','## Durable Task\nDetailed work.',
  '--output','file','--output-path',join(f.root,'project/output/task.md'),...extra];
}
function jobSnapshot(f){
 const db=new DatabaseSync(f.db);
 try{return JSON.parse(db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(f.jobId).json);}
 finally{db.close();}
}
function unrelatedSnapshot(f){
 const db=new DatabaseSync(f.db);
 try{return JSON.parse(db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get('77').json);}
 finally{db.close();}
}

test('native task create allocates, Graph-selects state, and reads back from the same SQLite authority',()=>{
 const f=fixture();try{
  const created=f.call(taskArgs(f,['--title','Bounded native Task','--priority','P1','--story-size','L',
   '--parent',f.coordinatorId,'--deps',f.coordinatorId,'--dependency-validity',JSON.stringify({[f.coordinatorId]:'rerun'})]));
  assert.equal(created.created,true);
  assert.match(created.taskId,/^[1-9]\d*$/);
  assert.equal(created.task.id,created.taskId);
  assert.equal(created.task.title,'Bounded native Task');
  assert.equal(created.task.priority,'P1');
  assert.equal(created.task.storySize,'L');
  assert.equal(created.task.parentTaskId,f.coordinatorId);
  assert.deepEqual(created.task.dependencies,[f.coordinatorId]);
  assert.deepEqual(created.task.dependencyValidity,{[f.coordinatorId]:'rerun'});
  assert.equal(created.task.state,'DRAFT','queued predecessor keeps the Task dependency-gated');
  const read=f.call(['show','--db',f.db,'--job-id',f.jobId]);
  assert.deepEqual(read.job.tasks.find(task=>task.id===created.taskId),created.task);
  assert.equal(read.job.state,'ACTIVE','Job activation follows the canonical Job Graph');
 }finally{close(f);}
});

test('native task IDs remain globally increasing after process restart',()=>{
 const f=fixture();try{
  const first=f.call(taskArgs(f));
  const secondArgs=taskArgs(f);secondArgs[secondArgs.indexOf('--output-path')+1]=join(f.root,'project/output/task-2.md');
  const second=f.call(secondArgs);
  assert.equal(Number(second.taskId),Number(first.taskId)+1);
  const read=f.call(['show','--db',f.db,'--job-id',f.jobId]);
  assert.ok(read.job.tasks.some(task=>task.id===first.taskId));
  assert.ok(read.job.tasks.some(task=>task.id===second.taskId));
 }finally{close(f);}
});

test('invalid task requests reject atomically without consuming IDs or changing the Job',()=>{
 const f=fixture();try{
  const before=jobSnapshot(f);
  const unrelatedBefore=unrelatedSnapshot(f);
  for(const extra of [
   ['--story-size','XL'],
   ['--dependency-validity','{bad-json}'],
   ['--deps',f.coordinatorId,'--dependency-validity',JSON.stringify({missing:'rerun'})],
   ['--parent','missing-parent'],
   ['--deps','missing-dependency'],
  ]) assert.notEqual(f.call(taskArgs(f,extra),2).trim(),'');
  assert.notEqual(f.call(['task','create','--db',f.db,'--job-id',f.jobId,'--input','work','--output','file'],2).trim(),'');
  const unguarded=spawnSync(cli,taskArgs(f),{env:{...f.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'',RELAY_RUST_LIVE_MODE:''},encoding:'utf8'});
  assert.equal(unguarded.status,2);
  const live=spawnSync(cli,taskArgs(f),{env:{...f.env,RELAY_RUST_LIVE_MODE:'pilot-live'},encoding:'utf8'});
  assert.equal(live.status,2);
  assert.deepEqual(jobSnapshot(f),before);
  assert.deepEqual(unrelatedSnapshot(f),unrelatedBefore);
  const accepted=f.call(taskArgs(f));
  assert.equal(Number(accepted.taskId),Number(f.coordinatorId)+1);
  const after=jobSnapshot(f);
  assert.equal(after.tasks.length,before.tasks.length+1);
  assert.equal(after.tasks[1].id,accepted.taskId);
 }finally{close(f);}
});

test('native Task cancel follows the lifecycle Graph for unleased work and cannot falsely complete the Job',()=>{
 const f=fixture();try{
  const created=f.call(taskArgs(f,['--title','Dependency-gated Task','--parent',f.coordinatorId,'--deps',f.coordinatorId]));
  f.call(['activate','--db',f.db,'--job-id',f.jobId]);
  const cancel=['task','cancel','--db',f.db,'--job-id',f.jobId,'--task-id',created.taskId,'--reason','No longer needed'];
  const result=f.call(cancel);
  assert.equal(result.task.state,'CANCELLED');
  assert.equal(result.task.error,'No longer needed');
  assert.equal(result.task.executionId,null);
  assert.equal(result.task.leaseOwner,null);

  const persisted=f.call(['show','--db',f.db,'--job-id',f.jobId]);
  assert.equal(persisted.job.tasks.find(task=>task.id===created.taskId).state,'CANCELLED');
  const before=jobSnapshot(f);
  assert.notEqual(f.call(cancel,2).trim(),'','terminal Task cannot be cancelled twice');
  assert.deepEqual(jobSnapshot(f),before,'rejected duplicate cancellation leaves SQLite unchanged');

  const completion=f.call(['complete','--db',f.db,'--job-id',f.jobId]);
  assert.equal(completion.completed,false,'cancelled work is not successful completion evidence');
  assert.equal(f.call(['show','--db',f.db,'--job-id',f.jobId]).job.state,'ACTIVE');
 }finally{close(f);}
});

test('native Task cancel rejects a leased Worker generation without changing durable state',()=>{
 const f=fixture();try{
  const created=f.call(taskArgs(f,['--title','Leased Task']));
  const db=new DatabaseSync(f.db);
  try{
   db.prepare('UPDATE job_snapshot SET json=json_set(json,\'$.tasks[1].state\',\'RUNNING\',\'$.tasks[1].executionId\',\'exec-12345678\',\'$.tasks[1].leaseOwner\',\'worker\',\'$.tasks[1].leaseExpiresAt\',\'2099-01-01T00:00:00.000Z\') WHERE job_id=?').run(f.jobId);
  }finally{db.close();}
  const before=jobSnapshot(f);
  const unknown=f.call(['task','cancel','--db',f.db,'--job-id',f.jobId,'--task-id',created.taskId,'--reason','reason','--surprise','ignored'],2);
  assert.match(unknown,/unrecognized task cancel option/);
  const duplicate=f.call(['task','cancel','--db',f.db,'--job-id',f.jobId,'--task-id',created.taskId,'--reason','one','--reason','two'],2);
  assert.match(duplicate,/duplicate option --reason/);
  const result=f.call(['task','cancel','--db',f.db,'--job-id',f.jobId,'--task-id',created.taskId,'--reason','Unsafe live cancel'],2);
  assert.match(result,/unleased DRAFT or QUEUED/);
  assert.deepEqual(jobSnapshot(f),before,'invalid requests and leased execution leave the isolated SQLite snapshot unchanged');
 }finally{close(f);}
});

test('native Task retry follows the lifecycle Graph, survives restart, and cannot falsely complete the Job',()=>{
 const f=fixture();try{
  const created=f.call(taskArgs(f,['--title','Failed Task']));
  const db=new DatabaseSync(f.db);
  try{
   db.prepare('UPDATE job_snapshot SET json=json_set(json,\'$.tasks[1].state\',\'FAILED\',\'$.tasks[1].error\',\'verified failure\',\'$.tasks[1].failureReason\',\'script_error\',\'$.tasks[1].attempt\',3,\'$.tasks[1].maxAttempts\',3,\'$.tasks[1].routing\',json(\'{"provider":"fixture","model":"old"}\'),\'$.tasks[1].workerSelection\',json(\'{"workerId":"old"}\')) WHERE job_id=?').run(f.jobId);
  }finally{db.close();}
  const retry=['task','retry','--db',f.db,'--job-id',f.jobId,'--task-id',created.taskId];
  const result=f.call(retry);
  assert.equal(result.task.state,'QUEUED');
  assert.equal(result.task.error,null);
  assert.equal(Object.hasOwn(result.task,'failureReason'),false);
  assert.equal(result.task.maxAttempts,6,'manual retry extends the bounded retry window like the Node action');
  assert.equal(Object.hasOwn(result.task,'routing'),false,'retry clears the stale provider route');
  assert.equal(Object.hasOwn(result.task,'workerSelection'),false,'retry clears the stale Worker selection');
  const persisted=f.call(['show','--db',f.db,'--job-id',f.jobId]);
  assert.equal(persisted.job.tasks.find(task=>task.id===created.taskId).state,'QUEUED');
  const before=jobSnapshot(f);
  assert.match(f.call(retry,2),/inactive FAILED Task/);
  assert.deepEqual(jobSnapshot(f),before,'duplicate retry cannot mutate the already requeued Task');
  assert.equal(f.call(['complete','--db',f.db,'--job-id',f.jobId]).completed,false,
   'a queued retry is not successful completion evidence');
 }finally{close(f);}
});

test('native Task retry rejects recovery-owned failure without changing durable state',()=>{
 const f=fixture();try{
  const created=f.call(taskArgs(f,['--title','Recovery-owned Task']));
  const db=new DatabaseSync(f.db);
  try{
   db.prepare('UPDATE job_snapshot SET json=json_set(json,\'$.tasks[1].state\',\'FAILED\',\'$.tasks[1].resolution\',json(\'{"status":"active"}\')) WHERE job_id=?').run(f.jobId);
  }finally{db.close();}
  const before=jobSnapshot(f);
  const result=f.call(['task','retry','--db',f.db,'--job-id',f.jobId,'--task-id',created.taskId],2);
  assert.match(result,/without recovery ownership/);
  assert.deepEqual(jobSnapshot(f),before);
 }finally{close(f);}
});

test('supported native Task shape matches Node CLI creation semantics',()=>{
 const f=fixture();try{
  const root={id:'node-job',title:'Node parity fixture',repository:'agents-relay',state:'DRAFT',runtimeStatus:'DRAFT',
   priority:'P2',prNumber:0,reviewEnabled:false,autoMerge:false,createdAt:'2026-11-14T00:00:00.000Z',
   updatedAt:'2026-11-14T00:00:00.000Z',tasks:[],plans:[]};
  const file=join(f.root,'node-job.json');writeFileSync(file,JSON.stringify(root));
  const common=['--priority','P1','--story-size','l','--parent','1','--deps','1',
   '--dependency-validity','{"1":"rerun"}','--output','file','--output-path',join(f.root,'project/output/task.md'),
   '--input','## Durable Task\nDetailed work.'];
  const node=spawnSync(process.execPath,[nodeCli,'task','create','--file',file,...common],
    {env:f.env,encoding:'utf8',timeout:12000});
  assert.equal(node.status,0,node.stderr||node.stdout);
  const nodeTask=JSON.parse(node.stdout.trim());
  const native=f.call(taskArgs(f,['--priority','P1','--story-size','l','--parent',f.coordinatorId,
   '--deps',f.coordinatorId,'--dependency-validity',JSON.stringify({[f.coordinatorId]:'rerun'})]));
  const fields=['title','kind','priority','storySize','dependencies','dependencyValidity','capabilities','workerRequirements',
   'adapter','input','output','state','attempt','maxAttempts','timeoutMs'];
  for(const field of fields) assert.deepEqual(native.task[field],nodeTask[field],`Task field ${field}`);
 }finally{close(f);}
});
