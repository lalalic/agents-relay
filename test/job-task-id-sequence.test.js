import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { allocateEntityId } from '../dist/job-task-id-sequence.js';
import { ensureManagedGitHubJob } from '../dist/cli-job-create.js';
import { SQLiteRelayStore } from '../dist/relay-store.js';
// Offline migration fixture paths only; live Relay has no per-PR database mode.
const relayStorePath = (directory, repository, pr) => join(directory, repository.replace('/', '_') + '-' + pr + '.db');
const relayJobStorePath = (directory, id) => join(directory, 'job-' + id + '.db');

test('Job and Task IDs each use a global increasing sequence and remain idempotent', async () => {
  const root=await mkdtemp(join(tmpdir(),'relay-ids-'));
  const dir=join(root,'stores');
  try {
    const jobs=await Promise.all(Array.from({length:16},()=>Promise.resolve().then(()=>allocateEntityId(dir,'lalalic/neo','job'))));
    assert.equal(new Set(jobs).size,16);
    assert.equal(jobs[0],'1');
    assert.equal(jobs[15],'16');
    assert.equal(allocateEntityId(dir,'lalalic/neo','task'),'1');
    assert.equal(allocateEntityId(dir,'other/repo','task'),'2');
    const neoTask=allocateEntityId(dir,'lalalic/neo','task','same-key');
    const otherTask=allocateEntityId(dir,'other/repo','task','same-key');
    assert.notEqual(neoTask,otherTask);
    assert.equal(allocateEntityId(dir,'lalalic/agents-relay','job'),'17');
    const a=allocateEntityId(dir,'lalalic/neo','job','batch-123');
    assert.equal(a,allocateEntityId(dir,'lalalic/neo','job','batch-123'));
    assert.equal(allocateEntityId(dir,'lalalic/neo','job'),'19');
    assert.equal(allocateEntityId(dir,'lalalic/neo','job',undefined,new Set(['20'])), '21');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('numeric Job IDs are globally unique across repositories, reserve historic IDs, and keep keyed retries scoped', async () => {
  const root=await mkdtemp(join(tmpdir(),'relay-global-job-'));
  const dir=join(root,'stores');
  try {
    assert.equal(allocateEntityId(dir,'first/repo','job','key'), '1');
    assert.equal(allocateEntityId(dir,'other/repo','job','key'), '2');
    assert.equal(allocateEntityId(dir,'first/repo','job','key'), '1');
    assert.equal(allocateEntityId(dir,'third/repo','job',undefined,new Set(['3','4'])), '5');
    assert.equal(allocateEntityId(dir,'first/repo','job'), '6');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('job bootstrap can omit id and retry same submission key', async () => {
  const root=await mkdtemp(join(tmpdir(),'relay-job-autonum-'));
  const dir=join(root,'stores');
  try {
    const client={request:async()=>{throw new Error('no GitHub')},graphql:async()=>{throw new Error('no GitHub')}};
    const options={title:'Test Vlog',objective:'Create a private video',projectPath:'vlog',storeDirectory:dir,idempotencyKey:'vlog-submission-123'};
    const first=await ensureManagedGitHubJob(client,'lalalic/neo',new Set(),options);
    const second=await ensureManagedGitHubJob(client,'lalalic/neo',new Set(),options);
    assert.equal(first.job.id,'1');
    assert.equal(first.job.id,second.job.id);
    assert.equal(first.job.projectPath,'vlog');
    await assert.rejects(ensureManagedGitHubJob(client,'lalalic/neo',new Set(),{...options,objective:'Different objective'}),/idempotency key reused/);
    const third=await ensureManagedGitHubJob(client,'lalalic/neo',new Set(),{...options,idempotencyKey:'vlog-submission-124'});
    assert.equal(third.job.id,'2');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('planner Task aliases resolve to durable repository IDs without losing DAG edges', async () => {
  const {assignPlannerTaskIds}=await import('../dist/planner-task-ids.js');
  const root=await mkdtemp(join(tmpdir(),'relay-planner-ids-'));
  const dir=join(root,'stores');
  try {
    const raw={objective_status:'in_progress',assessment:'graph',unblocks:[],next_tasks:[
      {title: 'Implement and verify durable task outputs', id:'story',input:'produce story',output:{kind:'task_pr'},dependencies:[]},
      {title: 'Implement and verify durable task outputs', id:'direction',input:'direct',output:{kind:'task_pr'},parentTaskId:'story',dependencies:['story','external-task']},
    ]};
    const result=assignPlannerTaskIds(raw,'lalalic/neo','episode-1','plan-1',dir);
    const [story,direction]=result.next_tasks;
    assert.equal(story.id,'1');
    assert.equal(direction.id,'2');
    assert.equal(direction.parentTaskId,story.id);
    assert.deepEqual(direction.dependencies,[story.id,'external-task']);
    assert.deepEqual(assignPlannerTaskIds(raw,'lalalic/neo','episode-1','plan-1',dir),result);
    assert.equal(raw.next_tasks[0].id,'story');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('daemon allocates Task IDs, returns the created ID, and does not duplicate an idempotent retry', async () => {
  const { createDashboardActions } = await import('../dist/relayd-dashboard-actions.js');
  const { InMemoryStore } = await import('../dist/store.js');
  const root=await mkdtemp(join(tmpdir(),'relay-daemon-task-ids-'));
  const dir=join(root,'stores');
  try {
    const job={id:'episode-1', repository:'lalalic/neo',prNumber:0, title:'Vlog Episode', objective:'Private content', state:'ACTIVE', tasks:[],plans:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    const store=new InMemoryStore(job);
    let wakes=0;
    const actions=createDashboardActions({
      getOverviews:()=>[{job}],storeDirectory:dir,
      requireLocalJobBinding:async()=>({store}),
      pool:{reconcileLocalJob:async()=>{wakes++;}},
    });
    const task={jobId:job.id,id:'',kind:'work',state:'QUEUED',priority:'P2',parentTaskId:null,dependencies:[],capabilities:[],adapter:'codex',input:'Draft storyboard',output:{kind:'file',path:'story.md'},attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:null,timeoutMs:1000,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    const created=await actions.workspaceTaskCreate(job.id,structuredClone(task),'batch-123');
    assert.equal(created.createdTaskId,'1');
    assert.equal(created.tasks.length,1);
    assert.equal(wakes,1);
    const repeated=await actions.workspaceTaskCreate(job.id,structuredClone(task),'batch-123');
    assert.equal(repeated.createdTaskId,created.createdTaskId);
    assert.equal(repeated.tasks.length,1);
    assert.equal(wakes,1);
    await assert.rejects(actions.workspaceTaskCreate(job.id,{...structuredClone(task),input:'Different Task'},'batch-123'),/different definition/);
    await assert.rejects(actions.workspaceTaskCreate(job.id,{...structuredClone(task),id:'99'}),/Reserved auto-generated Task ID/);
    const second=await actions.workspaceTaskCreate(job.id,structuredClone(task),'batch-124');
    assert.equal(second.createdTaskId,'2');
    assert.equal(second.tasks.length,2);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('new Job creation refuses nonnumeric explicitly supplied IDs', async () => {
  const root=await mkdtemp(join(tmpdir(),'relay-numeric-only-'));
  const dir=join(root,'stores');
  try {
    const client={request:async()=>{throw new Error('unexpected GitHub')},graphql:async()=>{throw new Error('unexpected GitHub')}};
    await assert.rejects(ensureManagedGitHubJob(client,'owner/repo',new Set(),{id:'legacy-slug',objective:'invalid',storeDirectory:dir}),/positive decimal integer/);
    const {adoptExistingPullRequestJob}=await import('../dist/cli-job-create.js');
    await assert.rejects(adoptExistingPullRequestJob(client,'owner/repo',new Set(),{id:'legacy-pr-id',prNumber:12,storeDirectory:dir}),/positive decimal integer/);
    const adopted=await adoptExistingPullRequestJob(client,'owner/repo',new Set(),{prNumber:12,storeDirectory:dir});
    assert.equal(adopted.job.id,'1');
    assert.equal((await adoptExistingPullRequestJob(client,'owner/repo',new Set(),{prNumber:12,storeDirectory:dir})).job.id,'1');
    assert.equal(allocateEntityId(dir,'other/repo','job'),'2');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('one-time offline migration rewrites Job snapshots and file identities, preserves a rollback, and advances allocation', async () => {
  const root=await mkdtemp(join(tmpdir(),'relay-numeric-migration-'));
  const dir=join(root,'stores');
  await mkdir(dir);
  const timestamp='2026-01-01T00:00:00.000Z';
  const job=(id,prNumber,repository)=>({id,title:id,repository,prNumber,createdAt:timestamp,updatedAt:timestamp,state:'COMPLETED',continuation:null,tasks:[{id:'task',jobId:id,state:'SUCCEEDED',dependencies:[]}],plans:[{id:'plan-1',jobId:id,round:1,createdAt:timestamp,updatedAt:timestamp}]});
  try {
    const a=new SQLiteRelayStore(relayStorePath(dir,'owner/repo',7));
    await a.saveJob(job('old-repo-seven',7,'owner/repo'));a.close();
    const b=new SQLiteRelayStore(relayJobStorePath(dir,'old-local-job'));
    await b.saveJob(job('old-local-job',0,'other/repo'));b.close();
    const legacySequences = new DatabaseSync(join(dir, 'entity-id-sequences.sqlite'));
    legacySequences.exec('CREATE TABLE sequences (repository TEXT NOT NULL,kind TEXT NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(repository,kind)); CREATE TABLE idempotency (repository TEXT NOT NULL,kind TEXT NOT NULL,request_key TEXT NOT NULL,entity_id TEXT NOT NULL,PRIMARY KEY(repository,kind,request_key))');
    legacySequences.prepare('INSERT INTO sequences VALUES (?,?,?)').run('*','task',1);
    legacySequences.close();
    const command=spawnSync('python3',['scripts/migrate-numeric-job-ids.py',dir],{encoding:'utf8'});
    assert.equal(command.status,0,command.stderr);
    assert.match(command.stdout,/MIGRATION_COMMITTED/);
    const old=await import('node:fs/promises').then(x=>x.readdir(root));
    assert.ok(old.some(x=>x.startsWith('stores.pre-numeric-')));
    const first=new SQLiteRelayStore(relayStorePath(dir,'owner/repo',7));
    const one=(await first.listJobs())[0];first.close();
    assert.equal(one.id,'2');
    assert.equal(one.tasks[0].jobId,'2');
    assert.equal(one.plans[0].jobId,'2');
    const second=new SQLiteRelayStore(join(dir,'job-'+createHash('sha256').update('1').digest('hex')+'.db'));
    const other=(await second.listJobs())[0];second.close();
    assert.equal(other.id,'1');
    assert.equal(other.tasks[0].jobId,'1');
    assert.equal(allocateEntityId(dir,'next/repo','job',undefined,new Set(['1','2'])),'3');
    const repeated=spawnSync('python3',['scripts/migrate-numeric-job-ids.py',dir],{encoding:'utf8'});
    assert.notEqual(repeated.status,0);
    assert.match(repeated.stderr,/already exist/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
