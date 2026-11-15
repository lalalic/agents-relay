import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const cli=resolve(process.env.CARGO_TARGET_DIR ?? resolve(import.meta.dirname,'../target'),'debug/relay-native-job');
const nodeCli=resolve(import.meta.dirname,'../../dist/cli.js');
const nodeReferenceAvailable=existsSync(nodeCli)&&existsSync(resolve(import.meta.dirname,'../../node_modules/nats/package.json'));
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'relay-rust-authority-task-update-'));mkdirSync(join(root,'project/output'),{recursive:true});writeFileSync(join(root,'.relay-rust-authority-isolated-test'),'test-only');
 const db=join(root,'relay.sqlite'),store=join(root,'node-store');mkdirSync(store);const env={...process.env,AGENTS_RELAY_STORE_DIR:store,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'};
 const call=(args,expected=0,input)=>{const r=spawnSync(cli,args,{env,encoding:'utf8',timeout:12000,input});assert.equal(r.status,expected,r.stderr||r.stdout);return expected?`${r.stderr}${r.stdout}`:JSON.parse(r.stdout.trim())};
 const inputFile=join(root,'project/input.md'),graphFile=join(root,'project/graph.mmd');writeFileSync(inputFile,'Coordinator input');writeFileSync(graphFile,'flowchart TD\nbuilder[agent:builder]\n');
 call(['init','--db',db]);const job=call(['create','--db',db,'--project-root',join(root,'project'),'--graph-file',graphFile,'--input-file',inputFile,'--output-path',join(root,'project/output/dag.json'),'--title','Task update fixture','--repository','agents-relay','--request-key','task-update-root']);
 return {root,db,env,call,jobId:job.jobId};
}
function close(f){rmSync(f.root,{recursive:true,force:true})}
function create(f,extra=[]){return f.call(['task','create','--db',f.db,'--id',f.jobId,'--repo','agents-relay','--input','durable task input','--output','file','--output-path',join(f.root,'project/output/task.md'),...extra])}
function snapshot(f){const db=new DatabaseSync(f.db);try{return JSON.parse(db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(f.jobId).json)}finally{db.close()}}
function patchTask(f,id,patch){const db=new DatabaseSync(f.db);try{const j=snapshot(f),t=j.tasks.find(x=>x.id===id);Object.assign(t,patch);db.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(j),f.jobId)}finally{db.close()}}
function update(f,id,flags,expected=0){return f.call(['task','update','--db',f.db,'--id',f.jobId,'--repo','agents-relay','--task-id',id,...flags],expected)}

test('native update covers Node task metadata, routing, graph queue/hold, and durable readback',()=>{
 const f=fixture();try{
  const prerequisite=create(f),target=create(f,['--deps',prerequisite.taskId]);
  const graphPath=join(f.root,'node-store/agent-graph.mmd');writeFileSync(graphPath,'flowchart TD\nbuilder[agent:builder]\n');
  const updated=update(f,target.taskId,['--agent','builder','--agent-graph-file',graphPath,'--attachments','a.png,b.txt','--capabilities','rust,testing','--chatgpt-project','project-1','--chatgpt-tab-close-policy','never','--cwd','/workspace','--dependency-validity',JSON.stringify({[prerequisite.taskId]:'rerun'}),'--max-attempts','4','--model','gpt-test','--provider','openai','--profile','fast','--reasoning','high','--project','native','--parent',prerequisite.taskId,'--adapter','z','--input-file',join(f.root,'project/input.md'),'--store-dir',f.root,'--timeout','12345']);
  assert.equal(updated.task.agentName,'builder');assert.match(updated.task.agentGraph,/agent:builder/);assert.deepEqual(updated.task.attachments,['a.png','b.txt']);assert.deepEqual(updated.task.capabilities,['rust','testing']);assert.equal(updated.task.adapter,'z');assert.equal(updated.task.chatgptProject,undefined);assert.equal(updated.task.routing.projectId,'project-1');assert.equal(updated.task.chatgptTabClosePolicy,'never');assert.equal(updated.task.routing.cwd,'/workspace');assert.equal(updated.task.dependencyValidity[prerequisite.taskId],'rerun');assert.equal(updated.task.maxAttempts,4);assert.equal(updated.task.timeoutMs,12345);assert.equal(updated.task.projectName,'native');assert.equal(updated.task.parentTaskId,prerequisite.taskId);assert.equal(updated.task.input,'Coordinator input');
  update(f,prerequisite.taskId,['--model','gpt-test']);const held=update(f,prerequisite.taskId,['--draft']);assert.equal(held.task.state,'DRAFT');const queued=update(f,prerequisite.taskId,['--queue']);assert.equal(queued.task.state,'QUEUED');const cleared=update(f,prerequisite.taskId,['--clear-routing']);assert.equal(Object.hasOwn(cleared.task,'routing'),false);
  const onDisk=f.call(['task','show','--db',f.db,'--id',f.jobId,'--task-id',target.taskId]);assert.equal(onDisk.updatedAt,updated.task.updatedAt);
 }finally{close(f)}
});

test('update rejects invalid combinations, duplicate/stale dependencies, and unsafe files without mutation',()=>{
 const f=fixture();try{const base=create(f),target=create(f);const source=join(f.root,'project/input.md'),outside='/etc/hosts',oversized=join(f.root,'node-store/oversized.md');writeFileSync(oversized,Buffer.alloc(1_048_577,97));
  for(const flags of [['--draft','--queue'],['--model','x','--clear-routing'],['--agent-graph','inline','--agent-graph-file',source],['--chatgpt-tab-close-policy','sometimes'],['--max-attempts','0'],['--dependency-validity','[]']]){const before=snapshot(f);assert.notEqual(update(f,target.taskId,flags,2).length,0);assert.deepEqual(snapshot(f),before);}
  for(const flags of [['--deps',`${base.taskId},${base.taskId}`],['--deps','999999'],['--input-file',outside],['--agent-graph-file',outside],['--input-file',oversized],['--agent-graph-file',oversized],['--agent-graph','not a graph']]){const before=snapshot(f);assert.notEqual(update(f,target.taskId,flags,2).length,0);assert.deepEqual(snapshot(f),before);}
 }finally{close(f)}
});

test('update works after Graph-authorized retry and retry state identity remains intact',()=>{
 const f=fixture();try{const made=create(f);patchTask(f,made.taskId,{state:'FAILED',attempt:2,maxAttempts:2,error:'failure',failureReason:'task_failure',executionId:null,leaseOwner:null,leaseExpiresAt:null});
  const retried=f.call(['task','retry','--db',f.db,'--id',f.jobId,'--task-id',made.taskId]);assert.equal(retried.task.state,'QUEUED');assert.equal(retried.task.attempt,2);const before=snapshot(f);assert.match(update(f,made.taskId,['--adapter','chatgpt'],2),/Cannot replace adapter after an execution attempt/);assert.deepEqual(snapshot(f),before);const changed=update(f,made.taskId,['--title','After retry','--max-attempts','5']);assert.equal(changed.task.title,'After retry');assert.equal(changed.task.attempt,2);assert.equal(changed.task.maxAttempts,5);
 }finally{close(f)}
});

test('Node CLI reference matches native update field semantics',{skip:!nodeReferenceAvailable?'Node reference build or optional nats dependency unavailable':false},()=>{
 const f=fixture();try{const prerequisite=create(f),target=create(f,['--deps',prerequisite.taskId]);const graphPath=join(f.root,'node-store/agent-graph.mmd');writeFileSync(graphPath,'flowchart TD\nbuilder[agent:builder]\n');
  const flags=['--agent','builder','--agent-graph-file',graphPath,'--attachments','a.png,b.txt','--capabilities','rust,testing','--chatgpt-project','project-1','--chatgpt-tab-close-policy','never','--cwd','/workspace','--dependency-validity',JSON.stringify({[prerequisite.taskId]:'rerun'}),'--max-attempts','4','--model','gpt-test','--provider','openai','--profile','fast','--reasoning','high','--project','native','--parent',prerequisite.taskId,'--adapter','z','--input-file',join(f.root,'project/input.md'),'--timeout','12345'];
  const nodeFile=join(f.root,'node-job.json'),nodeJob=snapshot(f);writeFileSync(nodeFile,JSON.stringify(nodeJob));
  const node=spawnSync(process.execPath,[nodeCli,'task','update','--file',nodeFile,'--task-id',target.taskId,...flags],{env:f.env,encoding:'utf8',timeout:12000});assert.equal(node.status,0,node.stderr||node.stdout);const reference=JSON.parse(node.stdout.trim());const native=update(f,target.taskId,[...flags,'--store-dir',f.root]).task;
  for(const field of ['agentName','agentGraph','attachments','capabilities','adapter','chatgptTabClosePolicy','dependencyValidity','maxAttempts','projectName','parentTaskId','input','timeoutMs'])assert.deepEqual(native[field],reference[field],`Task field ${field}`);
  assert.deepEqual(native.dependencies,reference.dependencies);for(const key of ['provider','model','profile','reasoning','cwd','projectId','decidedBy'])assert.equal(native.routing[key],reference.routing[key],`routing.${key}`);
 }finally{close(f)}
});
