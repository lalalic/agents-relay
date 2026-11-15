import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'../..');
const target=process.env.CARGO_TARGET_DIR??join(root,'rust/target');
const rust=join(target,'debug/relay-native-job');
const node=join(root,'dist/cli.js');
assert.ok(existsSync(node),'Build Node reference output before differential workflow test: npm run build');
function run(program,args,expected=0){
 const p=spawnSync(program,args,{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
 assert.equal(p.status,expected,p.stderr||p.stdout);
 return expected===0?JSON.parse(p.stdout):p.stderr;
}
function reference(args){return run(process.execPath,[node,...args]);}
function native(args){return run(rust,args);}
test('workflow discover/actions output equals Node, including symbol and Graph order',()=>{
 const discovered=reference(['workflow','discover']);
 assert.deepEqual(native(['workflow','discover']),discovered);
 assert.equal(discovered.graphs.length,19);
 const actions=reference(['workflow','actions']);
 assert.deepEqual(native(['workflow','actions']),actions);
 assert.equal(actions.count,75);
});
test('workflow inspect JSON equals Node for every production Graph (19 files)',()=>{
 const {graphs}=reference(['workflow','discover']);
 for(const graph of graphs){
  const args=['workflow','inspect','--graph',graph];
  assert.deepEqual(native(args),reference(args),graph);
 }
});
test('workflow where reverse index equals Node for edge/node semantic IDs',()=>{
 for(const id of ['effect.cancelActiveTasks','activate','DRAFT','localCompletionAllowed',
  'task.started','task.completed','effect.launchTask','cancel','UNKNOWN','']){
  const args=['workflow','where','--id',id];
  assert.deepEqual(native(args),reference(args),'where '+id);
 }
});
test('workflow evaluate Graph dry-run equals Node for true/false/missing facts and unknown event',()=>{
 const cases=[
  ['job-lifecycle.mmd','DRAFT','activate','{}'],
  ['job-lifecycle.mmd','ACTIVE','cancel','{}'],
  ['job-lifecycle.mmd','ACTIVE','local.completed','{"localCompletionAllowed":true}'],
  ['job-lifecycle.mmd','ACTIVE','local.completed','{"localCompletionAllowed":false}'],
  ['job-lifecycle.mmd','ACTIVE','local.completed','{}'],
  ['task-lifecycle.mmd','DRAFT','start','{}'],
  ['job-lifecycle.mmd','ACTIVE','UNKNOWN','{}'],
 ];
 for(const [graph,state,event,facts] of cases){
  const args=['workflow','evaluate','--graph',graph,'--state',state,'--event',event,'--facts',facts];
  assert.deepEqual(native(args),reference(args),graph+'/'+state+'/'+event+'/'+facts);
 }
});

test('workflow trace matches Node on absent and populated canonical SQLite ledger rows',()=>{
 const folder=mkdtempSync(join(tmpdir(),'rust-workflow-trace-'));
 const db=join(folder,'trace.sqlite');
 try {
  const store=new DatabaseSync(db);
  let args=['workflow','trace','--sqlite',db,'--attempt-key','test-attempt'];
  assert.deepEqual(native(args),reference(args),'no ledger table');
  store.exec('CREATE TABLE workflow_action_trace(attempt_key TEXT PRIMARY KEY,execution_id TEXT NOT NULL,generation INTEGER NOT NULL,graph TEXT NOT NULL,action_id TEXT NOT NULL,condition_id TEXT NOT NULL,outcome TEXT NOT NULL,observed_at TEXT NOT NULL)');
  assert.deepEqual(native(args),reference(args),'empty ledger table');
  store.prepare('INSERT INTO workflow_action_trace VALUES(?,?,?,?,?,?,?,?)')
    .run('test-attempt','execution-3',4,'task-lifecycle','effect.launchTask','task.queued','Verified','2026-11-15T15:00:00Z');
  assert.deepEqual(native(args),reference(args),'populated ledger trace');
  assert.equal(native(args).trace.generation,4);
  assert.deepEqual(native(['workflow','trace','--sqlite',db,'--attempt-key','not-found']),
    reference(['workflow','trace','--sqlite',db,'--attempt-key','not-found']));
  store.close();
 } finally { rmSync(folder,{recursive:true,force:true}); }
});

test('workflow verify matches Node on every authoritative condition and process-stop proof',()=>{
 const folder=mkdtempSync(join(tmpdir(),'rust-workflow-verify-'));
 const db=join(folder,'verify.sqlite');
 try{
  const store=new DatabaseSync(db);
  store.exec('CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL)');
  store.exec('CREATE TABLE execution_process(job_id TEXT NOT NULL,task_id TEXT NOT NULL,execution_id TEXT NOT NULL,ended_at TEXT)');
  const job={
   id:'9',state:'COMPLETED',reviewEnabled:false,plans:[],repository:'test',title:'Calculator',
   tasks:[
    {id:'1',title:'Coordinator',kind:'work',agentGraph:'flowchart TD',state:'SUCCEEDED',agentName:'coordinator',executionId:null,leaseOwner:null},
    {id:'2',title:'Build',kind:'work',state:'SUCCEEDED',agentName:'builder',executionId:null,leaseOwner:null,executionHistory:[{id:'old-exec'}]}
   ]
  };
  const stmt=store.prepare('INSERT INTO job_snapshot VALUES(?,?,?)');
  stmt.run('9',JSON.stringify(job),'2026-11-15T15:00:00Z');
  store.prepare('INSERT INTO execution_process VALUES(?,?,?,?)')
   .run('9','2','old-exec','2026-11-15T15:00:00Z');
  const base=['workflow','verify','--sqlite',db,'--job','9'];
  const verify=(tail)=>assert.deepEqual(native([...base,...tail]),reference([...base,...tail]));
  for(const condition of ['job.completed','job.objective-verified','task.queued',
    'task.succeeded','task.failed','task.routing-cleared','task.execution-stopped']){
   const tail=['--condition',condition];
   if(condition.startsWith('task.'))tail.push('--task','2');
   if(condition==='task.execution-stopped')tail.push('--execution','old-exec');
   verify(tail);
  }
  assert.equal(native([...base,'--condition','job.completed']).outcome,'Verified');
  assert.equal(native([...base,'--condition','task.execution-stopped','--task','2','--execution','old-exec']).outcome,'Verified');
  verify(['--condition','task.execution-stopped','--task','2','--execution','unrecorded']);
  verify(['--condition','task.succeeded','--task','missing']);
  assert.deepEqual(native(['workflow','verify','--sqlite',db,'--job','missing','--condition','job.completed']),
    reference(['workflow','verify','--sqlite',db,'--job','missing','--condition','job.completed']));
  job.tasks[1].state='FAILED';
  store.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(job),'9');
  verify(['--condition','task.failed','--task','2']);
  verify(['--condition','job.objective-verified']);
  verify(['--condition','job.completed']);
  store.close();
 } finally {rmSync(folder,{recursive:true,force:true});}
});
test('workflow evaluate Node parity over every direct canonical state-event transition',()=>{
 const {graphs}=reference(['workflow','discover']);
 let evaluated=0;
 for(const graphName of graphs){
  const graph=reference(['workflow','inspect','--graph',graphName]);
  const nodes=new Map(graph.nodes.map(n=>[n.id,n]));
  const guards=Object.fromEntries(graph.nodes.filter(n=>n.kind==='guard').map(n=>[n.semanticId,true]));
  for(const edge of graph.edges.filter(e=>e.kind==='on')){
   const source=nodes.get(edge.from);
   if(!source || source.kind!=='state')continue;
   for(const facts of ['{}',JSON.stringify(guards)]){
    const args=['workflow','evaluate','--graph',graphName,'--state',source.semanticId,
      '--event',edge.semanticId,'--facts',facts];
    assert.deepEqual(native(args),reference(args),
      graphName+': '+source.semanticId+' '+edge.semanticId+' with '+facts);
    evaluated++;
   }
  }
 }
 assert.ok(evaluated>=150,'expected many Graph transition comparisons, got '+evaluated);
});
test('workflow CLI refuses unsafe action and invalid/unknown options',()=>{
 const action=run(rust,['workflow','action','--graph','job-lifecycle.mmd'],2);
 assert.match(action,/workflow action requires a supported Graph-authorized task Action ID/);
 const nodeAction=run(process.execPath,[node,'workflow','action','--graph','job-lifecycle.mmd'],1);
 assert.match(nodeAction,/workflow action requires a supported Graph-authorized task Action ID/);
 assert.match(run(rust,['workflow','inspect','--graph','../unsafe.mmd'],2),/unknown executable graph/);
 assert.match(run(rust,['workflow','discover','--undocumented'],2),/unknown workflow option/);
 assert.match(run(rust,['workflow','inspect','--graph','job-lifecycle.mmd','--graph','job-lifecycle.mmd'],2),/duplicate workflow option/);
});
