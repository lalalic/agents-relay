import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '../dist/job-task-id-sequence.js';
import { ensureManagedGitHubJob } from '../dist/cli-job-create.js';

test('Job IDs are repository-scoped while Task IDs use one global increasing sequence and remain idempotent', async () => {
  const dir=await mkdtemp(join(tmpdir(),'relay-ids-'));
  try {
    const jobs=await Promise.all(Array.from({length:16},()=>Promise.resolve().then(()=>allocateEntityId(dir,'lalalic/neo','job'))));
    assert.equal(new Set(jobs).size,16);
    assert.equal(jobs[0],'j-7-lalalic-neo-1');
    assert.equal(jobs[15],'j-7-lalalic-neo-16');
    assert.equal(allocateEntityId(dir,'lalalic/neo','task'),'1');
    assert.equal(allocateEntityId(dir,'other/repo','task'),'2');
    const neoTask=allocateEntityId(dir,'lalalic/neo','task','same-key');
    const otherTask=allocateEntityId(dir,'other/repo','task','same-key');
    assert.notEqual(neoTask,otherTask);
    assert.equal(allocateEntityId(dir,'lalalic/agents-relay','job'),'j-7-lalalic-agents-relay-1');
    const a=allocateEntityId(dir,'lalalic/neo','job','batch-123');
    assert.equal(a,allocateEntityId(dir,'lalalic/neo','job','batch-123'));
    assert.equal(allocateEntityId(dir,'lalalic/neo','job'),'j-7-lalalic-neo-18');
    assert.equal(allocateEntityId(dir,'lalalic/neo','job',undefined,new Set(['j-7-lalalic-neo-19'])), 'j-7-lalalic-neo-20');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('job bootstrap can omit id and retry same submission key', async () => {
  const dir=await mkdtemp(join(tmpdir(),'relay-job-autonum-'));
  try {
    const client={request:async()=>{throw new Error('no GitHub')},graphql:async()=>{throw new Error('no GitHub')}};
    const options={title:'Test Vlog',objective:'Create a private video',projectPath:'vlog',storeDirectory:dir,idempotencyKey:'vlog-submission-123'};
    const first=await ensureManagedGitHubJob(client,'lalalic/neo',new Set(),options);
    const second=await ensureManagedGitHubJob(client,'lalalic/neo',new Set(),options);
    assert.equal(first.job.id,'j-7-lalalic-neo-1');
    assert.equal(first.job.id,second.job.id);
    assert.equal(first.job.projectPath,'vlog');
    await assert.rejects(ensureManagedGitHubJob(client,'lalalic/neo',new Set(),{...options,objective:'Different objective'}),/idempotency key reused/);
    const third=await ensureManagedGitHubJob(client,'lalalic/neo',new Set(),{...options,idempotencyKey:'vlog-submission-124'});
    assert.equal(third.job.id,'j-7-lalalic-neo-2');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('planner Task aliases resolve to durable repository IDs without losing DAG edges', async () => {
  const {assignPlannerTaskIds}=await import('../dist/planner-task-ids.js');
  const dir=await mkdtemp(join(tmpdir(),'relay-planner-ids-'));
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
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('daemon allocates Task IDs, returns the created ID, and does not duplicate an idempotent retry', async () => {
  const { createDashboardActions } = await import('../dist/relayd-dashboard-actions.js');
  const { InMemoryStore } = await import('../dist/store.js');
  const dir=await mkdtemp(join(tmpdir(),'relay-daemon-task-ids-'));
  try {
    const job={id:'episode-1', repository:'lalalic/neo',prNumber:0, title:'Vlog Episode', objective:'Private content', executionMode:'fixed', state:'ACTIVE', tasks:[],plans:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
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
  } finally { await rm(dir,{recursive:true,force:true}); }
});
