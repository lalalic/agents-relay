import test, { managedReconciler } from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { InMemoryStore } from '../dist/store.js';
import { createTaskEntity } from '../dist/workflow/entity-creation.js';
import { createWorkspaceControl } from '../dist/relayd-control.js';
import { sourceCommitSha, verifySourceCommit, sourceCompletionVerified } from '../dist/git-delivery.js';
import { tryTransitionTaskEvent } from '../dist/task-transitions.js';
import { eventFor } from '../dist/events.js';
import { executionEventSource } from '../dist/execution-event-identity.js';

const run=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const now=()=>new Date().toISOString();

async function fixture() {
  const temp=await mkdtemp(join(tmpdir(),'relay-commit-gate-'));
  const root=join(temp,'project');
  const worktree=join(temp,'job-worktree');
  await import('node:fs/promises').then(fs=>fs.mkdir(root));
  run(root,'init','-b','main');
  run(root,'config','user.name','Relay Test Worker');
  run(root,'config','user.email','relay-test@example.invalid');
  await writeFile(join(root,'source.txt'),'baseline\n');
  run(root,'add','source.txt');run(root,'commit','-m','Initial repository commit');
  const baseline=run(root,'rev-parse','HEAD');
  run(root,'worktree','add','-b','relay/job-658-test',worktree,'main');
  const id='658-test',taskId='1946-test',executionId='exec-658-a';
  const job={id,repository:basename(root),projectRoot:root,title:'Source worker completion',state:'ACTIVE',prNumber:0,
    priority:'P2',reviewEnabled:false,autoMerge:false,headSha:baseline,localMerge:{sourceRef:'refs/heads/relay/job-658-test',targetRef:'refs/heads/main',status:'pending'},
    tasks:[],plans:[],createdAt:now(),updatedAt:now(),continuation:null};
  const task=createTaskEntity(job,{
    jobId:id,id:taskId,kind:'work',agentName:'implementation',adapter:'chatgpt',title:'Deliver source change',
    input:'Make a verified source commit',output:{kind:'task_pr'},parentTaskId:null,dependencies:[],capabilities:[],
    attempt:1,maxAttempts:3,leaseOwner:'worker',leaseExpiresAt:'2099-01-01T00:00:00.000Z',executionId,
    executionHistory:[{id:executionId,attempt:1,startedAt:now()}],threadId:null,result:null,error:null,timeoutMs:600000,createdAt:now(),updatedAt:now(),
  });
  task.state='QUEUED'; job.tasks.push(task);
  const store=new InMemoryStore(job);
  const source={id:executionEventSource(id,taskId,executionId),agent:'worker',component:'fixture'};
  const completion=()=>eventFor(id,taskId,null,'task.completed','succeeded','I completed source work','worker',{},source);
  const started=()=>eventFor(id,taskId,null,'task.started','running','Worker started','worker',{},source);
  const runtime=managedReconciler(store,{owner:'commit-test',maxConcurrent:0,adapters:[],noGitHub:true,
    headShaProvider:()=>baseline});
  const change=async()=>{await appendFile(join(worktree,'source.txt'),'change by 1946\n');run(worktree,'add','source.txt');};
  const commit=(trailers=true)=>{
    const args=['commit','-m','Implement source task'];
    if(trailers)args.push('-m',`Relay-Task: ${taskId}`,'-m',`Relay-Execution: ${executionId}`);
    run(worktree,...args);return run(worktree,'rev-parse','HEAD');
  };
  return {temp,root,worktree,id,taskId,executionId,job,store,runtime,baseline,completion,started,change,commit};
}

async function withFixture(fn){const f=await fixture();try{return await fn(f);}finally{await f.runtime.close();await rm(f.temp,{recursive:true,force:true});}}

test('new source task requires CLI delivery; file, Reviewer, Troubleshooter and historical tasks do not', async()=>{
  await withFixture(async f=>{
    assert.equal(f.job.tasks[0].gitDeliveryRequired,true);
    assert.equal(tryTransitionTaskEvent({...f.job.tasks[0],state:'RUNNING'},'task.completed').accepted,false, 'canonical Graph refuses source success without verified evidence');
    for(const [agentName,output,expected] of [
      ['job-acceptance-reviewer',{kind:'task_pr'},false],['troubleshooter',{kind:'task_pr'},false],
      ['designer',{kind:'file',path:'run/output.json'},false],['implementation',{kind:'task_pr'},true]
    ]) {
      const template=f.job.tasks[0];
      const task=createTaskEntity(f.job,{...template,id:'other',agentName,output,gitDeliveryRequired:undefined});
      assert.equal(task.gitDeliveryRequired,expected,agentName);
    }
    const legacy={...f.job.tasks[0],gitDeliveryRequired:undefined};
    assert.equal(sourceCompletionVerified(f.job,legacy,f.executionId),true,'historical Task compatibility');
  });
});

test('real Task Graph rejects direct completion and uncommitted, incorrect or dirty Git delivery', async()=>{
  await withFixture(async f=>{
    let outcome=await f.runtime.applyEvent(f.started());
    assert.equal(outcome.applied,true);
    let task=(await f.store.load(f.id)).tasks[0];
    assert.equal(task.gitDeliveryBaseline.sha,f.baseline);
    assert.equal(task.gitDeliveryBaseline.executionId,f.executionId);
    assert.equal(sourceCommitSha(f.job),f.baseline);
    outcome=await f.runtime.applyEvent(f.completion());
    assert.equal(outcome.applied,false,'a fabricated generic completed event is rejected');
    assert.equal((await f.store.load(f.id)).tasks[0].state,'RUNNING');
    assert.throws(()=>verifySourceCommit(f.job,task,f.executionId,f.baseline),/new committed source branch HEAD/);
    await f.change();
    assert.throws(()=>verifySourceCommit(f.job,task,f.executionId,'f'.repeat(40)),/uncommitted or untracked/);
    const sha=f.commit(false);
    assert.throws(()=>verifySourceCommit(f.job,task,f.executionId,sha),/exact Relay-Task and Relay-Execution trailers/);
    await f.change();
    assert.throws(()=>verifySourceCommit(f.job,task,f.executionId,sha),/uncommitted or untracked/);
    assert.equal((await f.store.load(f.id)).tasks[0].state,'RUNNING');
  });
});

test('task complete CLI through real control + Task Graph durably accepts exact current commit; duplicate is idempotent', async()=>{
  await withFixture(async f=>{
    assert.equal((await f.runtime.applyEvent(f.started())).applied,true);
    await f.change();
    const sha=f.commit();
    // Another Worker may append a separate source commit before this Task completes.
    await f.change();
    run(f.worktree,'commit','-m','Unrelated parallel Worker B changes', '-m','Relay-Task: other', '-m','Relay-Execution: exec-other');
    assert.notEqual(run(f.worktree,'rev-parse','HEAD'),sha);
    const unchanged=(await f.store.load(f.id)).tasks[0];
    assert.equal(sourceCompletionVerified(f.job,unchanged,f.executionId),false,'commit alone is not a delivery receipt');
    assert.equal((await f.runtime.applyEvent(f.completion())).applied,false,'NATS cannot bypass CLI even after a real commit');
    let emitted=0, reconciles=0;
    const control=createWorkspaceControl({
      requireLocalJobBinding:async()=>({store:f.store}),concurrency:0,
      makeReconciler:(store)=>managedReconciler(store,{owner:'commit-control',maxConcurrent:0,adapters:[],noGitHub:true,headShaProvider:()=>sha}),
      pool:{reconcileLocalJob:async()=>{reconciles++;}},bus:{publish:async()=>{emitted++;}},
    });
    const server=createServer(async(req,res)=>{
      try{
        if(req.url!=='/api/control'||req.method!=='POST')throw Error('unexpected route');
        let body='';for await(const chunk of req)body+=chunk;
        const result=await control(JSON.parse(body));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
      }catch(error){res.writeHead(400);res.end(String(error));}
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const port=server.address().port;
    const command=(overrides=[])=>new Promise((resolve,reject)=>{
      const args=['dist/cli.js','task','complete','--repo',f.job.repository,'--id',f.id,
        '--task-id',f.taskId,'--execution-id',f.executionId,'--commit-sha',sha,'--summary','verified source', '--port',String(port),...overrides];
      const child=spawn('node',args,{cwd:process.cwd(),env:process.env});
      let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
      child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
    });
    try{
      await assert.rejects(()=>control({command:'task.complete',jobId:f.id,taskId:f.taskId,executionId:f.executionId,commitSha:'f'.repeat(40),repository:f.job.repository,summary:'bad'}),/does not descend from execution baseline/);
      assert.equal((await f.store.load(f.id)).tasks[0].state,'RUNNING');
      const good=await command();
      assert.equal(good.code,0,good.stderr||good.stdout);
      assert.equal(JSON.parse(good.stdout).accepted,true);
      const task=(await f.store.load(f.id)).tasks[0];
      assert.equal(task.state,'SUCCEEDED');
      assert.equal(task.gitDelivery.commitSha,sha);
      assert.equal(task.gitDelivery.baseSha,f.baseline);
      assert.equal(task.executionId,null);
      assert.equal(emitted,1);assert.equal(reconciles,1);
      const repeated=await command();
      assert.equal(repeated.code,0,repeated.stderr||repeated.stdout);
      assert.equal(JSON.parse(repeated.stdout).idempotent,true);
      assert.equal(emitted,1,'duplicate CLI must not duplicate completion event');
    } finally {server.close();await once(server,'close');}
  });
});
