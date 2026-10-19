import test, { managedDashboard, managedReconciler } from './test-runtime.js';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTask, marker, renderJobBody, TASK_MARKER } from '../dist/markers.js';
import { detectCycles, dependencyReady, extendRetryBudget, schedule, transitionTaskEvent } from '../dist/scheduler.js';
import { CodexAdapter, ChatGptAdapter, LaunchFailure } from '../dist/adapters.js';
import { InMemoryStore, GitHubStore } from '../dist/store.js';
import { PreSubmissionRejection } from '../dist/worker-rejection.js';
import { Reconciler, compareTaskPriority, executionEventSource } from '../dist/reconciler.js';
import { MemoryEventBus, eventFor, subjectToken } from '../dist/events.js';
import { serveDashboard, dashboardHtml } from '../dist/dashboard.js';
import { discoverAgents } from '../dist/registry.js';
import { compareJobPriority, needsLifecycleReconciliation, runnableManagedJobs, terminalManagedJobs, RepositoryWorkerPool } from '../dist/pool.js';
import { deriveJobRuntimeStatus } from '../dist/runtime-status.js';
import { dashboardJobSetState, dashboardTaskAction, dashboardTaskSetState, runtimeReviewer } from '../dist/cli.js';
import { relayControlJob, relayJobStateCommand } from '../dist/cli-support.js';
import { dispatchTaskAction } from '../dist/task-actions.js';
import { bindPlannedReviewHead } from '../dist/planned-review-head.js';

const now = () => new Date().toISOString();
const task = (id, state='QUEUED', dependencies=[]) => ({jobId:'j',id,parentTaskId:null,dependencies,capabilities:[],adapter:'codex',input:'do the described work',output:{kind:'task_pr'},routing:{provider:'openai',model:'gpt-test',decidedBy:'test',decidedAt:now()},state,attempt:0,maxAttempts:2,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:null,timeoutMs:1000,createdAt:now(),updatedAt:now(),continuation:null,continuationDeliveredAt:null});
const job = (tasks=[]) => ({id:'j',title:'x',prNumber:1,repository:'owner/repo',state:'ACTIVE',continuation:null,createdAt:now(),updatedAt:now(),tasks});
const eventSource = (jobId, taskId, executionId) => ({ id: executionEventSource(jobId, taskId, executionId) });
const activeEventSource = async (store, taskId, jobId='j') => {
  // Fixed polling attempts avoid wall-clock jumps on CI hosts while still
  // bounding the wait for the durable execution claim.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const current = (await store.load(jobId)).tasks.find(item => item.id === taskId);
    if (current?.executionId) return eventSource(jobId, taskId, current.executionId);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const current = (await store.load(jobId)).tasks.find(item => item.id === taskId);
  assert.ok(current?.executionId, `missing executionId for ${jobId}/${taskId}`);
  return eventSource(jobId, taskId, current.executionId);
};
const graphCommentClient = (comments, prNumber=1, prState='OPEN') => {
  let prBody = '';
  return {
  get body() { return prBody; },
  request: async (path, init={}) => {
    if (path.includes('/pulls?')) return [{number:prNumber,state:prState.toLowerCase(),merged_at:prState==='MERGED'?now():null,closed_at:prState!=='OPEN'?now():null,body:prBody,head:{ref:'fix'},base:{ref:'main'}}];
    if (path === 'repos/owner/repo/pulls/'+prNumber && init.method === 'PATCH') { prBody = JSON.parse(String(init.body)).body; return {body:prBody}; }
    throw new Error('unexpected REST '+path);
  },
  graphql: async (query, variables={}) => {
    if (query.includes('pullRequest(number:$number){id state merged mergedAt closedAt')) return {repository:{pullRequest:{id:'PR_'+prNumber,state:prState==='MERGED'?'CLOSED':prState,merged:prState==='MERGED',mergedAt:prState==='MERGED'?now():null,closedAt:prState!=='OPEN'?now():null,body:prBody}}};
    if (query.includes('open:pullRequests(first:50')) {
      const node={number:prNumber,body:prBody,state:prState==='MERGED'?'CLOSED':prState,isDraft:false,merged:prState==='MERGED',mergedAt:prState==='MERGED'?now():null,closedAt:prState!=='OPEN'?now():null,comments:{nodes:comments.map(c=>({body:c.body,author:{login:c.user.login}}))}};
      return {repository:{open:{nodes:prState==='OPEN'?[node]:[],pageInfo:{hasNextPage:false,endCursor:null}},recentClosed:{nodes:prState==='OPEN'?[]:[node]}}};
    }
    if (query.includes('comments(first:100')) return {repository:{pullRequest:{comments:{nodes:comments.map(c=>({id:'IC_'+c.id,databaseId:c.id,body:c.body,updatedAt:c.updated_at,author:{login:c.user.login}})),pageInfo:{hasNextPage:false,endCursor:null}}}}};
    if (query.includes('addComment')) {const c={id:comments.length+1,body:variables.body,updated_at:now(),user:{login:'bot'}};comments.push(c);return {addComment:{commentEdge:{node:{id:'IC_'+c.id}}}};}
    if (query.includes('updateIssueComment')) {const id=Number(String(variables.id).replace('IC_',''));const c=comments.find(x=>x.id===id);c.body=variables.body;return {updateIssueComment:{issueComment:{id:variables.id}}};}
    if (query.includes('deleteIssueComment')) {const id=Number(String(variables.id).replace('IC_',''));const i=comments.findIndex(x=>x.id===id);if(i>=0)comments.splice(i,1);return {deleteIssueComment:{clientMutationId:null}};}
    throw new Error('unexpected GraphQL '+query);
  }
  };
};
class FakeAdapter { name='codex'; id='fake-codex'; capabilities=['model','codex']; launches=0; cancelled=0; resolvers=[]; launch(t, signal) { this.launches += 1; let resolvePromise; let rejectPromise; const promise = new Promise((resolve,reject) => { resolvePromise=resolve; rejectPromise=reject; }); this.resolvers.push({resolve:resolvePromise,reject:rejectPromise}); signal.addEventListener('abort', () => { this.cancelled += 1; rejectPromise(new Error('aborted')); }, {once:true}); return {id:`exec-${this.launches}`,promise,cancel:() => {this.cancelled += 1; rejectPromise(new Error('cancelled'));}}; } }
class FakeChatGptAdapter extends FakeAdapter { name='chatgpt'; id='fake-chatgpt'; capabilities=['model','chatgpt']; }
class DelayedTerminalStore extends InMemoryStore {
  constructor(initialJob) {
    super(initialJob);
    this.terminalSaveStarted = new Promise(resolve => { this.resolveTerminalSaveStarted = resolve; });
    this.terminalSaveRelease = new Promise(resolve => { this.resolveTerminalSaveRelease = resolve; });
  }
  async saveTask(item) {
    if (item.state === 'SUCCEEDED') {
      this.resolveTerminalSaveStarted();
      await this.terminalSaveRelease;
    }
    return super.saveTask(item);
  }
  releaseTerminalSave() { this.resolveTerminalSaveRelease(); }
}

test('dashboard task action retries failed work and cancels queued work durably', async () => {
  const failed=task('retry-me','FAILED'); failed.attempt=3; failed.maxAttempts=3; failed.error='boom';
  const queued=task('cancel-me','QUEUED');
  const store=new InMemoryStore(job([failed,queued]));
  const reconciler={wake:async jobId=>store.load(jobId)};
  let durable=await dashboardTaskAction(store,reconciler,'retry')('j','retry-me');
  const retried=durable.tasks.find(item=>item.id==='retry-me'); assert.equal(retried.state,'QUEUED'); assert.equal(retried.error,null); assert.equal(retried.maxAttempts,6);
  durable=await dashboardTaskAction(store,reconciler,'cancel')('j','cancel-me');
  const cancelled=durable.tasks.find(item=>item.id==='cancel-me'); assert.equal(cancelled.state,'CANCELLED'); assert.equal(cancelled.error,'Cancelled by user');
  await assert.rejects(()=>dashboardTaskAction(store,reconciler,'retry')('j','cancel-me'),/not restartable/);
});

test('internal task.retry preserves retry budget while manual dispatch extends it', async () => {
  const internal = { ...task('internal-retry', 'FAILED'), attempt: 2, maxAttempts: 3, error: 'transient' };
  const store = new InMemoryStore(job([internal]));
  const { applyTaskRetryAction } = await import('../dist/task-actions.js');
  await applyTaskRetryAction(internal);
  assert.equal(internal.state, 'QUEUED');
  assert.equal(internal.maxAttempts, 3);

  const manual = { ...task('manual-retry', 'FAILED'), attempt: 3, maxAttempts: 3, error: 'manual', routing: {provider:'openai',model:'old-model',decidedBy:'test',decidedAt:new Date().toISOString()}, workerSelection: {workerId:'codex',adapter:'codex',capabilities:['model','codex'],selectedBy:'test',selectedAt:new Date().toISOString()} };
  const manualStore = new InMemoryStore(job([manual]));
  const result = await dispatchTaskAction(manualStore, { id: 'task.retry', jobId: 'j', taskId: 'manual-retry' });
  assert.equal(result.task.maxAttempts, 6);
  assert.equal(result.task.routing, undefined);
  assert.equal(result.task.workerSelection, undefined);
});

test('task.queue uses one graph/action dependency gate for draft and failed work', async () => {
  const done = task('done', 'SUCCEEDED');
  const draft = task('draft', 'DRAFT', ['done']);
  const failed = { ...task('failed', 'FAILED', ['done']), error: 'boom', executionId: 'old-exec', leaseOwner: 'old-owner' };
  const blockedByDep = task('waiting', 'DRAFT', ['missing']);
  const store = new InMemoryStore(job([done, draft, failed, blockedByDep]));

  assert.equal((await dispatchTaskAction(store, { id: 'task.queue', jobId: 'j', taskId: 'draft' })).task.state, 'QUEUED');
  const failedResult = await dispatchTaskAction(store, { id: 'task.queue', jobId: 'j', taskId: 'failed' });
  assert.equal(failedResult.task.state, 'QUEUED');
  assert.equal(failedResult.task.error, null);
  assert.equal(failedResult.task.executionId, null);
  assert.equal(failedResult.task.leaseOwner, null);
  await assert.rejects(
    () => dispatchTaskAction(store, { id: 'task.queue', jobId: 'j', taskId: 'waiting' }),
    /not queueable/,
  );
  assert.equal((await store.load('j')).tasks.find(item => item.id === 'waiting').state, 'DRAFT');
});

test('manual task.retry supersedes active automatic troubleshooter recovery for the same task', async () => {
  const failed={...task('root','FAILED'),error:'boom'};
  const recovery={...task('troubleshoot-root-a0','RUNNING'),agentName:'troubleshooter',parentTaskId:'root',executionId:'recovery-exec',leaseOwner:'relay',error:null};
  const store=new InMemoryStore(job([failed,recovery]));
  await dispatchTaskAction(store,{id:'task.retry',jobId:'j',taskId:'root'});
  const saved=await store.load('j');
  const root=saved.tasks.find(item=>item.id==='root');
  const superseded=saved.tasks.find(item=>item.id==='troubleshoot-root-a0');
  assert.equal(root.state,'QUEUED');
  assert.equal(superseded.state,'CANCELLED');
  assert.equal(superseded.executionId,null);
  assert.match(superseded.error,/Superseded by manual retry of root/);
});



test('troubleshooter task.recover retries original task without cancelling itself', async () => {
  const failed={...task('root','FAILED'),error:'recoverable blocker',attempt:1,maxAttempts:3};
  const recovery={...task('troubleshoot-root-a1','RUNNING'),agentName:'troubleshooter',parentTaskId:'root',executionId:'recovery-exec',leaseOwner:'relay',error:null};
  const store=new InMemoryStore(job([failed,recovery]));
  await dispatchTaskAction(store,{id:'task.recover',jobId:'j',taskId:'root',recoveryTaskId:'troubleshoot-root-a1'});
  const saved=await store.load('j');
  const root=saved.tasks.find(item=>item.id==='root');
  const activeRecovery=saved.tasks.find(item=>item.id==='troubleshoot-root-a1');
  assert.equal(root.state,'QUEUED');
  assert.equal(activeRecovery.state,'RUNNING');
  assert.equal(activeRecovery.executionId,'recovery-exec');
});

test('troubleshooter recovery retains diagnostic evidence and triggers a fresh route', async () => {
  const oldRouting={provider:'chatgpt',model:'account-defaults',decidedBy:'test',decidedAt:now()};
  const failed={...task('root','FAILED'),attempt:1,maxAttempts:3,routing:oldRouting,error:'worker_start_timeout'};
  const recovery={...task('troubleshoot-root','RUNNING'),agentName:'troubleshooter',parentTaskId:'root',executionId:'recovery-exec'};
  const store=new InMemoryStore(job([failed,recovery]));
  await dispatchTaskAction(store,{id:'task.recover',jobId:'j',taskId:'root',recoveryTaskId:'troubleshoot-root',recoveryDiagnosis:{failureKind:'adapter_failure',reason:'worker_start_timeout',evidence:'adapter never emitted task.started',reroute:true,excludeCurrentRoute:true}});
  const current=(await store.load('j')).tasks.find(x=>x.id==='root');
  assert.equal(current.state,'QUEUED');
  assert.equal(current.routing,undefined);
  assert.equal(current.workerSelection,undefined);
  assert.equal(current.recoveryContext.failureKind,'adapter_failure');
  assert.match(current.recoveryContext.evidence,/task.started/);
  assert.equal(current.routingExclusions[0].model,'account-defaults');
});

test('semantic failure recovery preserves the original routing', async () => {
  const failed={...task('root','FAILED'),attempt:1,maxAttempts:3,error:'test failure'};
  const recovery={...task('troubleshoot-root','RUNNING'),agentName:'troubleshooter',parentTaskId:'root',executionId:'recovery-exec'};
  const store=new InMemoryStore(job([failed,recovery]));
  await dispatchTaskAction(store,{id:'task.recover',jobId:'j',taskId:'root',recoveryTaskId:'troubleshoot-root',recoveryDiagnosis:{failureKind:'task_failure',reason:'validation failed',reroute:false,excludeCurrentRoute:false}});
  const current=(await store.load('j')).tasks.find(x=>x.id==='root');
  assert.equal(current.routing.model,'gpt-test');
  assert.equal(current.recoveryContext.reason,'validation failed');
  assert.equal(current.routingExclusions,undefined);
});

test('task.recover rejects unrelated or inactive recovery tasks', async () => {
  const failed={...task('root','FAILED'),error:'recoverable blocker',attempt:1,maxAttempts:3};
  const unrelated={...task('troubleshoot-other-a1','RUNNING'),agentName:'troubleshooter',parentTaskId:'other',executionId:'recovery-exec',leaseOwner:'relay',error:null};
  const store=new InMemoryStore(job([failed,unrelated]));
  await assert.rejects(()=>dispatchTaskAction(store,{id:'task.recover',jobId:'j',taskId:'root',recoveryTaskId:'troubleshoot-other-a1'}),/active Troubleshooter recovery/);
});

test('legacy planner Task is read-only under shared task.retry action', async () => {
  const failed = { ...task('planner-retry', 'FAILED'), kind: 'planner', error: 'invalid planner output', attempt: 3, maxAttempts: 3, executionId: 'old-execution', leaseOwner: 'old-owner', leaseExpiresAt: new Date(Date.now() + 1000).toISOString() };
  const store = new InMemoryStore(job([failed]));
  await assert.rejects(() => dispatchTaskAction(store, { id: 'task.retry', jobId: 'j', taskId: 'planner-retry' }), /read-only/);
  const persisted = (await store.load('j')).tasks[0];
  assert.equal(persisted.state, 'FAILED');
  assert.equal(persisted.error, 'invalid planner output');
});

test('dashboard CANCELLED state uses job cancel semantics and closes the PR idempotently', async () => {
  class ClosingStore extends InMemoryStore {
    closes = 0;
    async closePullRequest() { this.closes += 1; }
  }
  const queued = task('queued', 'QUEUED');
  const store = new ClosingStore(job([queued]));
  let durable = await dashboardJobSetState(store)('j', 'CANCELLED');
  assert.equal(durable.state, 'CANCELLED');
  assert.equal(durable.tasks[0].state, 'CANCELLED');
  assert.equal(store.closes, 1);
  durable = await dashboardJobSetState(store)('j', 'CANCELLED');
  assert.equal(durable.state, 'CANCELLED');
  assert.equal(store.closes, 2);
});

test('local Job cancellation never closes its projected GitHub PR', async () => {
  class ClosingStore extends InMemoryStore { closes = 0; async closePullRequest() { this.closes += 1; } }
  const local={...job([task('queued')]),localMerge:{sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',status:'pending'}};
  const store=new ClosingStore(local);
  const durable=await dashboardJobSetState(store)('j','CANCELLED');
  assert.equal(durable.state,'CANCELLED');
  assert.equal(store.closes,0);
});

test('dashboard direct job lifecycle state override persists without changing runtime status semantics', async () => {
  const store = new InMemoryStore(job([]));
  const durable = await dashboardJobSetState(store)('j', 'COMPLETED');
  assert.equal(durable.state, 'COMPLETED');
  assert.equal((await store.load('j')).state, 'COMPLETED');
  assert.equal(deriveJobRuntimeStatus(durable, 'OPEN'), 'COMPLETED');
});

test('dashboard job lifecycle override cannot invent a transition absent from the canonical graph', async () => {
  const store = new InMemoryStore(job([]));
  await assert.rejects(() => dashboardJobSetState(store)('j', 'DRAFT'), /Invalid job transition ACTIVE -> DRAFT/);
  assert.equal((await store.load('j')).state, 'ACTIVE');
});

test('dashboard direct task state override is durable, audited, and does not reconcile', async () => {
  const manual = task('manual', 'FAILED');
  manual.error = 'historical failure';
  manual.executionId = 'old-execution';
  manual.leaseOwner = 'old-owner';
  manual.leaseExpiresAt = new Date(Date.now() + 10000).toISOString();
  const store = new InMemoryStore(job([manual]));
  const durable = await dashboardTaskSetState(store)('j', 'manual', 'SUCCEEDED');
  const updatedTask = durable.tasks.find(item => item.id === 'manual');
  assert.equal(updatedTask.state, 'SUCCEEDED');
  assert.equal(updatedTask.executionId, null);
  assert.equal(updatedTask.leaseOwner, null);
  assert.equal(updatedTask.leaseExpiresAt, null);
  assert.equal(updatedTask.manualStateOverrides.length, 1);
  assert.equal(updatedTask.manualStateOverrides[0].from, 'FAILED');
  assert.equal(updatedTask.manualStateOverrides[0].to, 'SUCCEEDED');
  assert.equal(updatedTask.manualStateOverrides[0].actor, 'dashboard-user');
  assert.equal(updatedTask.error, 'historical failure');
});

test('dashboard task state override cannot invent a transition absent from the canonical graph', async () => {
  const manual = task('manual-invalid', 'SUCCEEDED');
  const store = new InMemoryStore(job([manual]));
  await assert.rejects(() => dashboardTaskSetState(store)('j', 'manual-invalid', 'RUNNING'), /Invalid task transition SUCCEEDED -> RUNNING/);
  assert.equal((await store.load('j')).tasks[0].state, 'SUCCEEDED');
});

test('dashboard cancel transitions RUNNING through task.cancelled and clears execution identity', async () => {
  const running=task('running-cancel','RUNNING'); running.executionId='exec-running'; running.leaseOwner='relay'; running.leaseExpiresAt=new Date(Date.now()+60000).toISOString();
  const store=new InMemoryStore(job([running]));
  const reconciler={wake:async jobId=>store.load(jobId)};
  const durable=await dashboardTaskAction(store,reconciler,'cancel')('j','running-cancel');
  const cancelled=durable.tasks[0];
  assert.equal(cancelled.state,'CANCELLED');
  assert.equal(cancelled.executionId,null);
  assert.equal(cancelled.leaseOwner,null);
  assert.equal(cancelled.leaseExpiresAt,null);
  assert.equal(cancelled.error,'Cancelled by user');
});

test('parses task marker JSON', () => { const t=task('a'); assert.equal(parseTask(marker(TASK_MARKER,t)).id,'a'); });
test('discovers by hard requirements and keeps evidence explainable', () => {
  const base = { id:'a', name:'A', responsibility:'research', role:'researcher', capabilities:['research'], boundaries:['no credentials'], endpoint:{kind:'adapter',target:'codex'}, runtime:{adapter:'codex'}, availability:'available', routing:{trustDomains:['public']}, evidence:{evaluations:[],outcomes:{succeeded:0,failed:0,timedOut:0},lastObservedAt:null}, registeredAt:now(), updatedAt:now() };
  const proven = { ...base, id:'proven', evidence:{...base.evidence, evaluations:[{taskKind:'research',outcome:'success',observedAt:now()}], outcomes:{succeeded:3,failed:1,timedOut:0}} };
  assert.deepEqual(discoverAgents([base, proven], { capabilities:['research'], runtime:'codex', trustDomain:'public', taskKind:'research' }).map(item => item.agent.id), ['proven','a']);
  assert.equal(discoverAgents([base], { capabilities:['missing'] }).length, 0);
  assert.equal(discoverAgents([base], { explore:true })[0].exploratory, true);
});
test('task marker metadata round-trips while legacy markers remain compatible', () => {
  const legacy = task('legacy');
  assert.equal(parseTask(marker(TASK_MARKER, legacy)).projectName, undefined);
  assert.equal(parseTask(marker(TASK_MARKER, legacy)).agentName, undefined);
  const metadata = { ...task('metadata'), projectName: 'Agents Relay', agentName: 'codex', parentTaskId: 'orchestrator' };
  const parsed = parseTask(marker(TASK_MARKER, metadata));
  assert.equal(parsed.projectName, 'Agents Relay');
  assert.equal(parsed.agentName, 'codex');
  assert.equal(parsed.parentTaskId, 'orchestrator');
});
test('CLI plan accepts prompt-file on a zero-task DRAFT job and persists plan-1', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-plan-cli-'));
  const file = join(directory, 'job.json');
  const promptFile = join(directory, 'prompt.md');
  const plannerCommand = join(directory, 'planner.mjs');
  const descendantFile = join(directory, 'planner-descendant.pid');
  const root = { ...job([]), objective: 'durable objective', executionMode: 'fixed', state: 'DRAFT' };
  await writeFile(file, JSON.stringify(root));
  await writeFile(promptFile, 'additional planning guidance');
  await writeFile(plannerCommand, `#!/usr/bin/env node
import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
let input="";for await (const chunk of process.stdin) input+=chunk;const value=JSON.parse(input);if(value.objective!=="durable objective"||value.caller_prompt!=="additional planning guidance") process.exit(7);
const nested=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,'ignore']});nested.unref();writeFileSync(${JSON.stringify(descendantFile)},String(nested.pid));
process.stdout.write(JSON.stringify({objective_status:"satisfied",assessment:"complete",next_tasks:[]}));
`);
  await chmod(plannerCommand, 0o755);
  const result = spawn(process.execPath, [join('dist','cli.js'),'plan','--file',file,'--project-path',process.cwd(),'--prompt-file',promptFile,'--planner-command',plannerCommand], { cwd: process.cwd() });
  const [code] = await once(result, 'exit');
  assert.equal(code, 0);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.state, 'ACTIVE');
  assert.equal(saved.tasks.some(item => item.kind === 'planner'), false);
  assert.equal(saved.plans[0].id, 'plan-1');
  assert.equal(saved.plans[0].guidance, 'additional planning guidance');
  assert.equal(saved.plans[0].plannerResult.objective_status, 'satisfied');
  const descendantPid = Number(await readFile(descendantFile, 'utf8'));
  assert.throws(() => process.kill(descendantPid, 0), error => error?.code === 'ESRCH');
});
test('CLI task create stores optional project and agent metadata with parent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-task-metadata-'));
  const file = join(directory, 'job.json');
  await writeFile(file, JSON.stringify(job([])));
  const result = spawn(process.execPath, [join('dist', 'cli.js'), 'task','create', '--file', file, '--task-id', 'child', '--parent', 'orchestrator', '--project', 'Agents Relay', '--agent', 'codex', '--provider','openai','--model','gpt-test','--output','task-pr','--input', 'build metadata'], { cwd: process.cwd() });
  const [code] = await once(result, 'exit');
  assert.equal(code, 0);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.tasks[0].projectName, 'Agents Relay');
  assert.equal(saved.tasks[0].agentName, 'codex');
  assert.equal(saved.tasks[0].parentTaskId, 'orchestrator');
  assert.equal(saved.tasks[0].planningDecisionId, undefined);
  assert.equal(saved.tasks[0].planningSource, undefined);
  assert.equal(saved.tasks.length, 1);
});
test('CLI direct task creation can omit routing and reconciler selects one complete execution route', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-direct-auto-route-'));
  const file = join(directory, 'job.json');
  const root = { ...job([]), executionMode: 'fixed', state: 'ACTIVE', reviewEnabled: false, autoMerge: false };
  await writeFile(file, JSON.stringify(root));
  const child = spawn(process.execPath, [join('dist','cli.js'),'task','create','--file',file,'--task-id','auto-route','--output','task-pr','--input','route this task'], {cwd:process.cwd()});
  assert.equal(await new Promise(resolve=>child.on('close',resolve)),0);
  const createdJob = JSON.parse(await readFile(file,'utf8'));
  const created = createdJob.tasks.find(item=>item.id==='auto-route');
  assert.equal(created.routing,undefined);
  assert.equal(created.workerSelection,undefined);
  assert.deepEqual(created.workerRequirements,{capabilities:[]});
  assert.equal(created.timeoutMs,0);

  const store = new InMemoryStore(createdJob);
  const events = [];
  const reconciler = managedReconciler(store,{owner:'test',adapters:[new FakeChatGptAdapter()],maxConcurrent:1,eventBus:new MemoryEventBus(),emit:event=>events.push(event)});
  await reconciler.reconcile('j');
  const routed = (await store.load('j')).tasks.find(item=>item.id==='auto-route');
  assert.equal(routed.adapter,'chatgpt');
  assert.equal(routed.workerSelection?.adapter,'chatgpt');
  assert.equal(routed.routing?.provider,'chatgpt');
  assert.equal(routed.routing?.model,'account-defaults');
  assert.equal(routed.routing?.decidedBy,'execution-router:fallback');
  assert.equal(routed.timeoutMs,900000);
  const workerIndex = events.findIndex(event=>event.type==='worker.selected');
  const modelIndex = events.findIndex(event=>event.type==='model.selected');
  assert.ok(workerIndex >= 0 && modelIndex > workerIndex);
  await rm(directory,{recursive:true,force:true});
});

test('CLI explicit worker/model routing remains a supported compatibility constraint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-direct-explicit-route-'));
  const file = join(directory, 'job.json');
  await writeFile(file, JSON.stringify(job([])));
  const child = spawn(process.execPath, [join('dist','cli.js'),'task','create','--file',file,'--task-id','explicit','--adapter','codex','--provider','openai','--model','gpt-test','--output','task-pr','--input','explicit route'], {cwd:process.cwd()});
  assert.equal(await new Promise(resolve=>child.on('close',resolve)),0);
  const created = JSON.parse(await readFile(file,'utf8')).tasks.find(item=>item.id==='explicit');
  assert.equal(created.workerRequirements,undefined);
  assert.equal(created.routing?.provider,'openai');
  assert.equal(created.routing?.model,'gpt-test');
  assert.equal(created.routing?.decidedBy,'cli');
  await rm(directory,{recursive:true,force:true});
});

test('CLI task create persists Mermaid Agent Graph from file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-agent-graph-cli-'));
  const file = join(directory, 'job.json');
  const graphFile = join(directory, 'agent-graph.mmd');
  const graph = 'flowchart TD\nreviewer --> planner\n';
  await writeFile(file, JSON.stringify(job([])));
  await writeFile(graphFile, graph);
  const result = spawn(process.execPath, [join('dist','cli.js'),'task','create','--file',file,'--task-id','graph-task','--provider','openai','--model','gpt-test','--output','task-pr','--input','execute graph','--agent-graph-file',graphFile], {cwd:process.cwd()});
  const [code] = await once(result,'exit');
  assert.equal(code,0);
  const saved=JSON.parse(await readFile(file,'utf8'));
  assert.equal(saved.tasks[0].agentGraph,graph);
  await rm(directory,{recursive:true,force:true});
});

test('CLI task create rejects new Relay-internal orchestrator work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-orchestrator-create-'));
  const file = join(directory, 'job.json');
  await writeFile(file, JSON.stringify(job([])));
  const result = spawn(process.execPath, [join('dist','cli.js'),'task','create','--file',file,'--task-id','self','--adapter','orchestrator','--output','task-pr','--input','handle this in the top-level orchestrator'], {cwd:process.cwd()});
  const [code] = await once(result, 'exit');
  assert.equal(code, 1);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.tasks.length, 0);
  await rm(directory,{recursive:true,force:true});
});

test('reconciler rescues queued legacy orchestrator work for Execution Router', async () => {
  const at = '2026-10-04T06:00:00.000Z';
  const self = task('legacy-queued');
  self.adapter = 'orchestrator'; self.routing = undefined; self.workerSelection = undefined; self.workerRequirements = undefined; self.timeoutMs = 0; self.capabilities = ['implementation'];
  self.createdAt = at; self.updatedAt = at;
  const store = new InMemoryStore({ ...job([self]), executionMode: 'fixed' });
  const events = [];
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [], maxConcurrent: 0, now: new Date(at), emit: event => events.push(event) });
  await reconciler.reconcile('j');
  const durable = (await store.load('j')).tasks[0];
  assert.equal(durable.adapter, 'codex');
  assert.deepEqual(durable.workerRequirements, { capabilities: ['implementation'] });
  assert.equal(durable.routing, undefined); assert.equal(durable.workerSelection, undefined); assert.equal(durable.state, 'QUEUED');
  assert.equal(durable.threadId, null);
  assert.ok(events.some(event => event.type === 'task.orchestrator_rescued'));
});

test('reconciler quarantines RUNNING legacy orphan without an execution identity', async () => {
  const at = '2026-10-04T06:00:00.000Z';
  const self = task('legacy-running', 'RUNNING');
  self.adapter = 'orchestrator';
  self.routing = undefined;
  self.workerSelection = undefined;
  self.workerRequirements = undefined;
  self.timeoutMs = 0;
  self.capabilities = ['implementation'];
  self.createdAt = at;
  self.updatedAt = self.createdAt;
  const store = new InMemoryStore({ ...job([self]), executionMode:'fixed' });
  const events=[];
  const reconciler = managedReconciler(store,{owner:'test',adapters:[],maxConcurrent:0,emit:event=>events.push(event)});
  await reconciler.reconcile('j');
  const durable=(await store.load('j')).tasks[0];
  assert.equal(durable.adapter,'orchestrator');
  assert.equal(durable.workerRequirements,undefined);
  assert.equal(durable.state,'BLOCKED');
  assert.match(durable.error,/automatic replay is unsafe/);
  assert.equal(durable.executionId,null);
  assert.equal(durable.leaseOwner,null);
  assert.equal(durable.threadId,null);
  assert.ok(events.some(event=>event.type==='task.orchestrator_quarantined'));
});

test('reconciler preserves active ownership and terminal legacy records', async () => {
  const at = '2026-10-04T06:00:00.000Z';
  const young = task('active', 'RUNNING'); young.adapter = 'orchestrator'; young.routing = undefined; young.createdAt = at; young.executionId = 'active'; young.leaseOwner = 'other'; young.leaseExpiresAt = '2099-01-01T00:00:00.000Z'; young.threadId = 'thread';
  const running = task('running', 'RUNNING'); running.adapter = 'orchestrator'; running.routing = undefined; running.createdAt = '2026-10-04T04:00:00.000Z'; running.executionId = 'active';
  const done = task('done', 'SUCCEEDED'); done.adapter = 'orchestrator'; done.routing = undefined; done.createdAt = '2026-10-04T04:00:00.000Z';
  const store = new InMemoryStore({ ...job([young, running, done]), executionMode: 'fixed' });
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [], maxConcurrent: 0, now: new Date(at) });
  await reconciler.reconcile('j');
  { const durable=(await store.load('j')).tasks; assert.deepEqual(durable.map(item => item.adapter), ['orchestrator','orchestrator','orchestrator']); assert.deepEqual(durable.map(item=>item.state), ['RUNNING','BLOCKED','SUCCEEDED']); }
});

test('CLI no longer exposes manual orchestrator task start or complete', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-orchestrator-removed-'));
  const file = join(directory, 'job.json');
  const legacy = task('self'); legacy.adapter = 'orchestrator'; legacy.output = {kind:'task_pr'}; legacy.routing = undefined; legacy.timeoutMs = 0;
  await writeFile(file, JSON.stringify(job([legacy])));
  for (const action of ['start','complete']) {
    const args = [join('dist','cli.js'),'task',action,'--file',file,'--task-id','self'];
    if (action === 'complete') args.push('--summary','legacy manual completion');
    const child = spawn(process.execPath, args, {cwd:process.cwd()});
    assert.notEqual(await new Promise(resolve=>child.on('close',resolve)),0);
  }
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.tasks[0].state, 'QUEUED');
  await rm(directory,{recursive:true,force:true});
});

test('active replacement work derives QUEUED despite historical failed tasks', () => {
  const old=task('old','FAILED'); const replacement=task('replacement','QUEUED');
  const value=schedule(job([old,replacement])); assert.equal(value.state,'ACTIVE'); assert.equal(deriveJobRuntimeStatus(value,'OPEN'),'QUEUED');
});
test('CLI no longer records synthetic orchestrator Tasks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-record-removed-'));
  const file = join(directory, 'job.json');
  await writeFile(file, JSON.stringify(job([])));
  const result = spawn(process.execPath, [join('dist', 'cli.js'), 'record', '--file', file, '--task-id', 'truth-fix', '--summary', 'synthetic'], { cwd: process.cwd() });
  const [code] = await once(result, 'exit');
  assert.notEqual(code, 0);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.tasks.length, 0);
  await rm(directory,{recursive:true,force:true});
});
test('healthy task states clear stale current errors without deleting history events', async () => {
  const cases=[['FAILED','retry'],['QUEUED','task.started'],['RUNNING','task.completed']];
  for (const [from,event] of cases) {
    const current=task('state-'+from,from); current.error='old failure';
    await transitionTaskEvent(current,event);
    assert.equal(current.error,null);
  }
  const queued=task('queued-with-old-error','QUEUED'); queued.error='stale dependency error';
  const scheduled=schedule(job([queued]));
  assert.equal(scheduled.tasks[0].state,'QUEUED');
  assert.equal(scheduled.tasks[0].error,null);
});
test('manual retry budget advances in three-attempt windows without resetting history', () => {
  assert.equal(extendRetryBudget({attempt:3,maxAttempts:3}),6);
  assert.equal(extendRetryBudget({attempt:5,maxAttempts:3}),6);
  assert.equal(extendRetryBudget({attempt:6,maxAttempts:6}),9);
  assert.equal(extendRetryBudget({attempt:8,maxAttempts:9}),12);
});
test('schedules dependencies but leaves BLOCKED manual', () => { const a=task('a','SUCCEEDED'); const b=task('b','BLOCKED',['a']); const c=task('c','QUEUED',['a']); const value=schedule(job([a,b,c])); assert.equal(b.state,'BLOCKED'); assert.equal(c.state,'QUEUED'); assert.equal(value.state,'ACTIVE'); assert.equal(deriveJobRuntimeStatus(value,'OPEN'),'QUEUED'); });
test('dependency-backed DRAFT becomes QUEUED only after dependencies succeed', () => { const dep=task('dep','SUCCEEDED'); const child=task('child','DRAFT',['dep']); const value=schedule(job([dep,child])); assert.equal(value.tasks.find(t=>t.id==='child').state,'QUEUED'); });
test('RUNNING tasks cannot return to DRAFT', async () => { const current=task('running','RUNNING'); await assert.rejects(transitionTaskEvent(current,'hold'),/No enabled workflow transition from RUNNING on hold/); });
test('detects cycles and requires successful dependencies', () => { assert.throws(() => detectCycles([task('a','QUEUED',['b']),task('b','QUEUED',['a'])]), /cycle/); assert.equal(dependencyReady(task('b','QUEUED',['a']),new Map([['a',task('a','RUNNING')]])),false); });
test('repository pool orders all locally active jobs regardless of GitHub state', () => { const low={...job([]),id:'low',priority:'P3',createdAt:'2026-01-01T00:00:00.000Z'}; const high={...job([]),id:'high',priority:'P0',createdAt:'2026-02-01T00:00:00.000Z'}; assert.equal(compareJobPriority(high,low)<0,true); assert.deepEqual(runnableManagedJobs([{job:low,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null},{job:high,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null},{job:{...high,id:'merged'},githubState:'MERGED',draft:false,mergedAt:now(),closedAt:now()}]).map(x=>x.id),['high','merged','low']); });
test('startup reconciliation selects expired durable RUNNING leases after daemon restart', () => {
  const expired=task('expired','RUNNING'); expired.executionId='expired-exec'; expired.leaseExpiresAt='2026-09-19T16:46:23.718Z';
  const live=task('live','RUNNING'); live.executionId='live-exec'; live.leaseExpiresAt='2026-09-19T17:10:00.000Z';
  assert.equal(needsLifecycleReconciliation(job([expired]),Date.parse('2026-09-19T16:59:20.000Z')),true);
  assert.equal(needsLifecycleReconciliation(job([live]),Date.parse('2026-09-19T16:59:20.000Z')),false);
});
test('daemon inventory selects RUNNING legacy orchestrator orphans after restart', () => {
  const orphan = task('legacy-orphan', 'RUNNING');
  orphan.adapter = 'orchestrator';
  orphan.executionId = null;
  assert.equal(needsLifecycleReconciliation(job([orphan]), Date.parse('2026-10-04T06:00:00.000Z')), true);
});
test('relay owner change does not reclaim an unexpired durable execution lease', async () => {
  const running=task('owner-still-live','RUNNING');
  running.attempt=1;
  running.executionId='old-execution';
  running.leaseOwner='relayd-old';
  running.leaseExpiresAt='2026-09-25T17:00:00.000Z';
  const store=new InMemoryStore(job([running]));
  const adapter=new FakeAdapter();
  const reconciler=managedReconciler(store,{owner:'relayd-new',now:new Date('2026-09-25T16:45:00.000Z'),adapters:[adapter],eventBus:new MemoryEventBus(),projectPathForJob:()=>process.cwd()});
  await reconciler.reconcile('j');
  const saved=(await store.load('j')).tasks.find(item=>item.id==='owner-still-live');
  assert.equal(saved.state,'RUNNING');
  assert.equal(saved.executionId,'old-execution');
  assert.equal(saved.leaseOwner,'relayd-old');
  assert.equal(saved.attempt,1);
  assert.equal(adapter.launches,0);
});

test('expired durable execution lease is reclaimable after relay owner change', async () => {
  const running=task('expired-owner','RUNNING');
  running.attempt=1;
  running.maxAttempts=3;
  running.executionId='expired-execution';
  running.leaseOwner='relayd-old';
  running.leaseExpiresAt='2026-09-25T16:30:00.000Z';
  const store=new InMemoryStore(job([running]));
  const adapter=new FakeAdapter();
  const reconciler=managedReconciler(store,{owner:'relayd-new',now:new Date('2026-09-25T16:45:00.000Z'),adapters:[adapter],projectPathForJob:()=>process.cwd()});
  await reconciler.reconcile('j');
  const saved=(await store.load('j')).tasks.find(item=>item.id==='expired-owner');
  assert.equal(saved.state,'BLOCKED');
  assert.equal(saved.executionId,null);
  assert.equal(saved.leaseOwner,null);
  assert.equal(saved.attempt,1);
  assert.match(saved.error,/event bus/);
  assert.equal(adapter.launches,0);
});
test('startup recovery graph retries an old-owner Codex execution', async () => {
  const running=task('restart-codex','RUNNING');
  running.attempt=1; running.maxAttempts=3; running.executionId='old-execution'; running.leaseOwner='relayd-old'; running.leaseExpiresAt='2099-09-25T17:00:00.000Z';
  const store=new InMemoryStore(job([running])); const adapter=new FakeAdapter();
  const reconciler=managedReconciler(store,{owner:'relayd-new',now:new Date('2026-09-25T16:45:00.000Z'),adapters:[adapter],eventBus:new MemoryEventBus(),projectPathForJob:()=>process.cwd()});
  await reconciler.recoverStartupOrphans('j');
  const saved=(await store.load('j')).tasks[0];
  assert.equal(saved.state,'QUEUED'); assert.equal(saved.attempt,1); assert.equal(saved.leaseOwner,null); assert.equal(saved.executionId,null); assert.equal(adapter.launches,0);
});
test('startup recovery reclaims a claimed QUEUED execution owned by a previous daemon', async () => {
  const queued=task('orphan-queued','QUEUED');
  queued.attempt=1; queued.maxAttempts=3; queued.executionId='old-queued-execution'; queued.leaseOwner='relayd-old'; queued.leaseExpiresAt='2099-09-25T17:00:00.000Z';
  const store=new InMemoryStore(job([queued]));
  const reconciler=managedReconciler(store,{owner:'relayd-new',now:new Date('2026-09-25T16:45:00.000Z'),adapters:[new FakeAdapter()],eventBus:new MemoryEventBus(),projectPathForJob:()=>process.cwd()});
  await reconciler.recoverStartupOrphans('j');
  const saved=(await store.load('j')).tasks[0];
  assert.equal(saved.state,'QUEUED');
  assert.equal(saved.executionId,null);
  assert.equal(saved.leaseOwner,null);
  assert.equal(saved.attempt,1);
});
test('startup recovery leaves current-owner Codex and ChatGPT async executions untouched', async () => {
  const current=task('current-codex','RUNNING'); current.attempt=1; current.executionId='current'; current.leaseOwner='relayd-new'; current.leaseExpiresAt='2099-09-25T17:00:00.000Z';
  const chat=task('chat-async','RUNNING'); chat.adapter='chatgpt'; chat.attempt=1; chat.executionId='chat'; chat.leaseOwner='relayd-old'; chat.leaseExpiresAt='2099-09-25T17:00:00.000Z';
  const store=new InMemoryStore(job([current,chat]));
  const reconciler=managedReconciler(store,{owner:'relayd-new',now:new Date('2026-09-25T16:45:00.000Z'),adapters:[new FakeAdapter()],eventBus:new MemoryEventBus(),projectPathForJob:()=>process.cwd()});
  await reconciler.recoverStartupOrphans('j');
  const saved=await store.load('j');
  assert.deepEqual(saved.tasks.map(item=>({state:item.state,attempt:item.attempt,executionId:item.executionId,leaseOwner:item.leaseOwner})),[
    {state:'RUNNING',attempt:1,executionId:'current',leaseOwner:'relayd-new'},
    {state:'RUNNING',attempt:1,executionId:'chat',leaseOwner:'relayd-old'},
  ]);
});
test('startup recovery graph terminalizes an exhausted orphan without a new generation', async () => {
  const exhausted=task('exhausted-codex','RUNNING'); exhausted.attempt=3; exhausted.maxAttempts=3; exhausted.executionId='exhausted'; exhausted.leaseOwner='relayd-old'; exhausted.leaseExpiresAt='2099-09-25T17:00:00.000Z';
  const root=job([exhausted]); root.reviewEnabled=false; root.autoMerge=false;
  const store=new InMemoryStore(root);
  const reconciler=managedReconciler(store,{owner:'relayd-new',now:new Date('2026-09-25T16:45:00.000Z'),adapters:[new FakeAdapter()],eventBus:new MemoryEventBus(),projectPathForJob:()=>process.cwd()});
  await reconciler.recoverStartupOrphans('j');
  const saved=(await store.load('j')).tasks[0];
  assert.equal(saved.state,'FAILED'); assert.equal(saved.attempt,3); assert.match(saved.error,/Orphaned after relayd restart after maximum attempts/); assert.equal(saved.executionId,null);
});
test('completed jobs remain behind the runnable gate even if stale task data appears', () => { const review=task('review','QUEUED'); const completed={...job([review]),id:'completed-with-new-work',state:'COMPLETED'}; const item={job:completed,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null}; assert.deepEqual(runnableManagedJobs([item]),[]); });
test('ACTIVE jobs with failed tasks remain eligible for reconciliation', () => { const failedTask=task('failed-task','FAILED'); const failed={...job([failedTask]),id:'failed'}; const item={job:failed,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null}; assert.deepEqual(runnableManagedJobs([item]).map(x=>x.id),['failed']); });
test('GitHub draft PR does not override ACTIVE job execution lifecycle', () => { const held={...job([]),id:'held'}; const item={job:held,githubState:'OPEN',draft:true,mergedAt:null,closedAt:null}; assert.deepEqual(runnableManagedJobs([item]).map(x=>x.id),['held']); });
test('repository pool never selects remote terminal facts as lifecycle transitions', () => {
  const open={...job([]),id:'open'}; const merged={...job([]),id:'merged',state:'ACTIVE'}; const completed={...job([]),id:'done',state:'COMPLETED'}; const closed={...job([]),id:'closed',state:'ACTIVE'};
  const items=[{job:open,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null},{job:merged,githubState:'MERGED',draft:false,mergedAt:now(),closedAt:now()},{job:completed,githubState:'MERGED',draft:false,mergedAt:now(),closedAt:now()},{job:closed,githubState:'CLOSED',draft:false,mergedAt:null,closedAt:now()}];
  assert.deepEqual(terminalManagedJobs(items), []);
  assert.deepEqual(runnableManagedJobs(items).map(item=>item.id).sort(), ['closed','merged','open']);
});

// Test-only adapter: legacy fixture arguments become local-only Job ID resolvers.
// Production RepositoryWorkerPool intentionally has no PR binding or fallback.
function localPoolFixture(_client, _repos, _trusted, concurrency, makeReconciler,
  _rateLimited, _snapshot, makeStore, inventory, resolver) {
  const known = new Map();
  const localInventory = async () => {
    const items = inventory ? await inventory() : [];
    for (const item of items) known.set(item.job.id, item.job);
    return items;
  };
  const localResolver = async jobId => {
    if (resolver) {
      const selected = await resolver(jobId);
      if (selected) return selected;
    }
    if (!known.has(jobId) && inventory) await localInventory();
    const root = known.get(jobId) ?? { ...job([]), id: jobId, repository: 'owner/repo', prNumber: 0 };
    const store = makeStore ? makeStore(root.repository, root.prNumber) : new InMemoryStore(root);
    return { job: root, store };
  };
  const pool = new RepositoryWorkerPool(concurrency, makeReconciler, localInventory, localResolver);
  const reconcileKnown = pool.reconcileKnown.bind(pool);
  pool.reconcileKnown = async items => {
    for (const item of items) known.set(item.job.id, item.job);
    return reconcileKnown(items);
  };
  return pool;
}

test('repository pool reuses startup discovery without another workspace scan', async () => {
  const calls=[];
  const queued=task('startup-task','QUEUED');
  const root={...job([queued]),id:'startup-known',repository:'owner/repo',prNumber:7};
  const overview={job:root,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null};
  const client={request:async()=>{throw new Error('startup known state must not scan REST');},graphql:async()=>{throw new Error('startup known state must not scan GraphQL');}};
  const pool=localPoolFixture(client,['owner/repo'],new Set(['bot']),4,(_store,maxConcurrent)=>({reconcile:async id=>{calls.push({id,maxConcurrent});}}));
  await pool.reconcileKnown([overview]);
  assert.deepEqual(calls,[{id:'startup-known',maxConcurrent:1}]);
});

test('repository pool uses targeted wake metadata without a full workspace scan', async () => {
  const bus=new MemoryEventBus();
  const calls=[];
  const client={request:async()=>{throw new Error('full scan should not run for targeted wake');}};
  const pool=localPoolFixture(client,['owner/repo'],new Set(['bot']),4,(_store,maxConcurrent)=>({reconcile:async id=>{calls.push({id,maxConcurrent});}}));
  const stop=await pool.watch(bus);
  await bus.publish(eventFor('job-1','task-1',null,'job.wake','queued','wake','orchestrator',{repository:'owner/repo',prNumber:42}));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(calls,[{id:'job-1',maxConcurrent:0}]);
  await stop();
});

test('new final-review creation wakes repository pool without relying on polling', async () => {
  const bus = new MemoryEventBus();
  const calls = [];
  const client = { request: async () => { throw new Error('no full scan required'); } };
  const pool = localPoolFixture(client, ['owner/repo'], new Set(['bot']), 4,
    () => ({ reconcile: async id => { calls.push(id); } }));
  const stop = await pool.watch(bus);
  await bus.publish(eventFor('job-review', 'final-review-head', null, 'review.created', 'queued',
    'Review Task created', 'orchestrator', {repository:'owner/repo',prNumber:2}));
  await new Promise(resolve => setTimeout(resolve,0));
  assert.deepEqual(calls, ['job-review']);
  await stop();
});

test('scheduler timer enters through EventBus schedule.tick before scheduled graph reconciliation', async () => {
  const bus=new MemoryEventBus();
  const at=new Date('2026-09-29T18:05:00.000Z');
  const root={...job([]),id:'scheduled-event-job',repository:'owner/repo',prNumber:48,executionMode:'autonomous',schedule:{cron:'0 * * * *',timezone:'UTC',nextRunAt:'2026-09-29T18:00:00.000Z',missedRunPolicy:'run',concurrencyPolicy:'skip',lastScheduledSlot:null,currentRunSlot:null,lastRunAt:null}};
  const store=new InMemoryStore(root);
  const seen=[]; let reconciles=0;
  const client={request:async()=>{throw new Error('unexpected request');}};
  const pool=localPoolFixture(client,['owner/repo'],new Set(['bot']),1,()=>({reconcile:async id=>{reconciles+=1; seen.push('reconcile:'+id);}}),()=>false,undefined,()=>store);
  const stopAudit=await bus.subscribeAll(async event=>{if(event.type==='schedule.tick')seen.push('bus:'+event.type);});
  const stopPool=await pool.watch(bus);
  await pool.scheduleTickSignal(bus,root,at);
  for(let i=0;i<20&&reconciles===0;i+=1) await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(seen[0],'bus:schedule.tick');
  assert.equal(reconciles,1);
  const durable=await store.load(root.id);
  assert.equal(durable.schedule.lastScheduledSlot,'2026-09-29T18:00:00.000Z');
  assert.equal(durable.schedule.lastRunAt,at.toISOString());
  await stopPool(); await stopAudit();
});

test('scheduler timer without EventBus uses the same schedule coordinator path', async () => {
  const at=new Date('2026-09-29T18:05:00.000Z');
  const root={...job([]),id:'scheduled-local-job',repository:'owner/repo',prNumber:49,executionMode:'autonomous',schedule:{cron:'0 * * * *',timezone:'UTC',nextRunAt:'2026-09-29T18:00:00.000Z',missedRunPolicy:'run',concurrencyPolicy:'skip',lastScheduledSlot:null,currentRunSlot:null,lastRunAt:null}};
  const store=new InMemoryStore(root);
  let reconciles=0;
  const client={request:async()=>{throw new Error('unexpected request');}};
  const pool=localPoolFixture(client,['owner/repo'],new Set(['bot']),1,()=>({reconcile:async()=>{reconciles+=1;}}),()=>false,undefined,()=>store);
  await pool.scheduleTickSignal(undefined,root,at);
  assert.equal(reconciles,1);
  const durable=await store.load(root.id);
  assert.equal(durable.schedule.lastScheduledSlot,'2026-09-29T18:00:00.000Z');
  assert.equal(durable.schedule.lastRunAt,at.toISOString());
});

test('repository pool serializes same-job targeted reconcile with discovered reconcile', async () => {
  const queued=task('serialize-task','QUEUED');
  const root={...job([queued]),id:'serialize-job',repository:'owner/repo',prNumber:44};
  const overview={job:root,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null};
  const client={request:async()=>{throw new Error('unexpected request');}};
  let active=0, maxActive=0; const calls=[]; let releaseFirst;
  const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
  const pool=localPoolFixture(client,['owner/repo'],new Set(['bot']),4,(_store,maxConcurrent)=>({reconcile:async id=>{
    calls.push({id,maxConcurrent}); active+=1; maxActive=Math.max(maxActive,active);
    if(calls.length===1) await firstGate;
    active-=1;
  }}));
  const discovered=pool.reconcileKnown([overview]);
  await new Promise(resolve=>setTimeout(resolve,0));
  const targeted=pool.reconcileTarget('owner/repo',44,'serialize-job');
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(calls.length,1);
  releaseFirst();
  await Promise.all([discovered,targeted]);
  assert.equal(maxActive,1);
  assert.equal(calls.length,2);
});

test('GitHub PR snapshots cannot seed or trigger local workflow execution', async () => {
  const root={...job([]),id:'seeded-job',repository:'owner/repo',prNumber:46};
  const store=new InMemoryStore(root);
  let reconciles=0,githubCalls=0;
  const client={request:async()=>{githubCalls++;throw Error('GitHub forbidden');},
    graphql:async()=>{githubCalls++;throw Error('GitHub forbidden');}};
  const pool=localPoolFixture(client,['owner/repo'],new Set(),4,
    ()=>({reconcile:async()=>{reconciles++;}}),()=>false,undefined,
    ()=>{throw Error('PR store used');},
    async()=>[{job:root,githubState:'MERGED',draft:false,mergedAt:now(),closedAt:now()}],
    async id=>id===root.id?{job:root,store}:null);
  await pool.reconcileTarget('owner/repo',46,root.id,'github.webhook:pull_request:closed');
  assert.equal(reconciles,0);
  assert.equal(githubCalls,0);
  await pool.reconcileLocalJob(root.id);
  assert.equal(reconciles,1);
});

test('local runtime event is independent from pending GitHub PR snapshot seed', async () => {
  const root={...job([]),id:'seed-preserved-job',repository:'owner/repo',prNumber:47};
  const store=new InMemoryStore(root), bus=new MemoryEventBus();
  let calls=0,githubCalls=0;
  const pool=localPoolFixture({
      request:async()=>{githubCalls++;throw Error('unexpected GitHub API');},
      graphql:async()=>{githubCalls++;throw Error('unexpected GitHub API');},
    },['owner/repo'],new Set(),4,()=>({
      applyEvent:async()=>({applied:true,reconcile:true}),
      reconcile:async()=>{calls++;},
    }),()=>false,undefined,()=>{throw Error('Remote store forbidden');},
    async()=>[{job:root,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null}],
    async id=>id===root.id?{job:root,store}:null);
  const stop=await pool.watch(bus);
  try {
    await bus.publish(eventFor(root.id,'task-1',null,'task.started','running','started','orchestrator'));
    for(let i=0;i<100&&calls===0;i++)await new Promise(resolve=>setTimeout(resolve,2));
    assert.equal(calls,1);
    assert.equal(githubCalls,0);
    assert.equal((await store.load(root.id)).state,'ACTIVE');
  } finally {await stop();}
});

test('targeted reconcile is not failed by an unrelated discovered Job failure', async () => {
  const targetTask=task('target-task','QUEUED');
  const badTask=task('bad-task','QUEUED');
  const target={...job([targetTask]),id:'target-job',repository:'owner/repo',prNumber:51};
  const bad={...job([badTask]),id:'bad-job',repository:'owner/repo',prNumber:52};
  const items=[target,bad].map(root=>({job:root,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null}));
  const stores=new Map([[target.id,new InMemoryStore(target)],[bad.id,new InMemoryStore(bad)]]);
  const calls=[];
  const pool=localPoolFixture({},['owner/repo'],new Set(),4,()=>({reconcile:async id=>{calls.push(id); if(id==='bad-job') throw new Error('unrelated failure');}}),()=>false,undefined,undefined,async()=>items,async id=>({job:id===target.id?target:bad,store:stores.get(id)}));
  await pool.reconcileLocalJob(target.id,'test.target');
  assert.ok(calls.includes('target-job'));
  assert.ok(calls.includes('bad-job'));
});

test('repository pool coalesces concurrent targeted reconciles for the same job', async () => {
  const calls=[]; let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const client={request:async()=>{throw new Error('unexpected request');}};
  const pool=localPoolFixture(client,['owner/repo'],new Set(['bot']),4,()=>({reconcile:async id=>{calls.push(id); await gate;}}));
  const first=pool.reconcileTarget('owner/repo',45,'burst-job');
  const second=pool.reconcileTarget('owner/repo',45,'burst-job');
  const third=pool.reconcileTarget('owner/repo',45,'burst-job');
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(calls,['burst-job']);
  release();
  await Promise.all([first,second,third]);
  assert.deepEqual(calls,['burst-job']);
});

test('uncorrelated GitHub webhook signals never trigger GitHub refreshes', async () => {
  const bus=new MemoryEventBus();
  let refreshCalls=0;
  let reconcileCalls=0;
  const client={request:async()=>{throw new Error('unexpected REST');},graphql:async()=>{throw new Error('unexpected GraphQL');}};
  const pool=localPoolFixture(
    client,
    ['owner/repo'],
    new Set(['bot']),
    2,
    ()=>({reconcile:async()=>{reconcileCalls+=1;}}),
    ()=>false,
    async ()=>{refreshCalls+=1; throw new Error('webhook must not refresh GitHub');},
  );
  const stopPool=await pool.watch(bus);
  await pool.webhookSignal(bus,{deliveryId:'delivery-signal',event:'pull_request',action:'synchronize',repository:'owner/repo',pullRequest:82,publication:null,pullRequestFacts:{state:'OPEN',head:{ref:'feat/webhook',sha:'abc123'}}});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(refreshCalls,0);
  assert.equal(reconcileCalls,0);
  await stopPool();
});

test('repository pool emits package.published from a correlated publication webhook without service actions', async () => {
  const bus=new MemoryEventBus();
  const events=[];
  const client={request:async()=>{throw new Error('unexpected request');}};
  const root={...job([]),id:'release-job',repository:'owner/repo',prNumber:83};
  const pool=localPoolFixture(client,['owner/repo'],new Set(['bot']),1,()=>({reconcile:async()=>{}}));
  const stop=await bus.subscribe('release-job',async event=>events.push(event));
  await pool.webhookWake(bus,root,{deliveryId:'delivery-123',event:'issue_comment',action:'created',repository:'owner/repo',pullRequest:83,publication:{package:'agents-relay',version:'1.2.3',registry:'https://registry.npmjs.org',sha:'abc123'},pullRequestFacts:null});
  assert.deepEqual(events.map(event=>event.type),['package.published','github.webhook']);
  const published=events[0];
  assert.deepEqual(published.data,{deliveryId:'delivery-123',repository:'owner/repo',prNumber:83,package:'agents-relay',version:'1.2.3',registry:'https://registry.npmjs.org',sha:'abc123'});
  assert.deepEqual(published.source,{id:'github/owner/repo/delivery/delivery-123',component:'github-webhook'});
  await stop();
});

test('repository pool routes correlated task lifecycle events to the target reconciler', async () => {
  const bus=new MemoryEventBus();
  const calls=[];
  const client={request:async()=>{throw new Error('unexpected request');}};
  const pool=localPoolFixture(client,['owner/repo'],new Set(['bot']),4,(_store,maxConcurrent)=>({
    reconcile:async id=>{calls.push({kind:'reconcile',id,maxConcurrent});},
    applyEvent:async event=>{
      calls.push({kind:'event',type:event.type,jobId:event.job_id,taskId:event.task_id,maxConcurrent});
      return {applied:true,reconcile:event.type==='task.completed',reason:event.type};
    }
  }));
  const stop=await pool.watch(bus);
  await bus.publish(eventFor('job-2','task-2',null,'job.wake','queued','wake','orchestrator',{repository:'owner/repo',prNumber:43}));
  await bus.publish(eventFor('job-2','task-2',null,'task.started','running','started','orchestrator'));
  await bus.publish(eventFor('job-2','task-2',null,'task.completed','succeeded','done','orchestrator'));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(calls,[
    {kind:'reconcile',id:'job-2',maxConcurrent:0},
    {kind:'event',type:'task.started',jobId:'job-2',taskId:'task-2',maxConcurrent:4},
    {kind:'event',type:'task.completed',jobId:'job-2',taskId:'task-2',maxConcurrent:4},
    {kind:'reconcile',id:'job-2',maxConcurrent:0}
  ]);
  await stop();
});

test('repository pool ignores locally recorded MERGED PR when local Job is still ACTIVE', async () => {
  const root = { ...job([]), id: 'merged-pool', state: 'ACTIVE', prNumber: 14 };
  const store = new InMemoryStore(root);
  store.pullRequestState = async () => 'MERGED';
  store.pullRequestHead = async () => null;
  const api = { request: async () => { throw new Error('GitHub offline'); },
    graphql: async () => { throw new Error('GitHub offline'); } };
  const local = () => [{
    job: root, githubState: 'MERGED', draft: false, mergedAt: null, closedAt: null,
  }];
  const pool = localPoolFixture(api, ['owner/repo'], new Set(),
    2, runtime => managedReconciler(runtime, { owner: 'test', adapters: [] }),
    () => true, undefined, () => store, local);
  await pool.reconcile();
  assert.equal((await store.load('merged-pool')).state, 'ACTIVE');
});
test('task priority orders ready work and inherits job priority', () => { const a=task('a'), b=task('b'), c=task('c'); a.priority='P3'; b.priority='P0'; a.createdAt='2026-01-01T00:00:00.000Z'; b.createdAt='2026-01-02T00:00:00.000Z'; c.createdAt='2025-01-01T00:00:00.000Z'; assert.deepEqual([a,b,c].sort((x,y)=>compareTaskPriority(x,y,'P1')).map(x=>x.id), ['b','c','a']); });
test('model task requires an event bus before launch', async () => {
  const t=task('no-events'); const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter();
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter]});
  await reconciler.reconcile('j');
  const durable=(await store.load('j')).tasks[0];
  assert.equal(adapter.launches,0);
  assert.equal(durable.state,'BLOCKED');
  assert.match(durable.error,/event bus/);
});

test('Relay publishes process launched and accepts only a worker-owned post-launch start acknowledgement', async () => {
  const t=task('chat-start'); t.adapter='chatgpt'; const store=new InMemoryStore(job([t])); const bus=new MemoryEventBus(); const events=[];
  const adapter={name:'chatgpt',id:'fake-chatgpt',capabilities:['model','chatgpt'],launch(_task,_signal,context){return {id:'chat-runtime',launched:Promise.resolve(),promise:(context.waitForWorkerStart ?? Promise.resolve()).then(()=>({summary:'submitted'})),cancel(){}};}};
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,startAckTimeoutMs:100});
  const stopEvents=await bus.subscribe('j',async event=>events.push(event));
  const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  assert.equal(events.some(event=>event.type==='task.started'),false);
  assert.equal(events.some(event=>event.type==='task.process.launched'),true);
  await bus.publish(eventFor('j','chat-start',null,'task.started','running','wrong execution','user',undefined,{id:'wrong/execution'}));
  assert.equal((await store.load('j')).tasks[0].state,'QUEUED');
  await bus.publish(eventFor('j','chat-start',null,'task.started','running','worker began','user',undefined,await activeEventSource(store,'chat-start')));
  assert.equal((await store.load('j')).tasks[0].state,'RUNNING');
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(events.some(event=>event.type==='task.process.async_exited'),true);
  await bus.publish(eventFor('j','chat-start',null,'task.completed','succeeded','durable output','user',undefined,await activeEventSource(store,'chat-start')));
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await store.load('j')).tasks[0].state,'SUCCEEDED');
  await stop(); await stopEvents();
});

test('async transport exit is observable after an authoritative terminal event', async () => {
  const t=task('async-terminal-first');t.adapter='chatgpt';
  const store=new InMemoryStore(job([t]));const bus=new MemoryEventBus();const events=[];
  let finish;
  const transport=new Promise(resolve=>{finish=resolve});
  const adapter={name:'chatgpt',id:'delayed-async',capabilities:['model','chatgpt'],launch(){return {id:'transport',launched:Promise.resolve(),promise:transport,cancel(){}}}};
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
  const stopEvents=await bus.subscribe('j',async e=>events.push(e));const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  const source=await activeEventSource(store,'async-terminal-first');
  await bus.publish(eventFor('j','async-terminal-first',null,'task.started','running','started','user',undefined,source));
  await bus.publish(eventFor('j','async-terminal-first',null,'task.completed','succeeded','finished','user',undefined,source));
  finish({summary:'transport settled'});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal((await store.load('j')).tasks[0].state,'SUCCEEDED');
  assert.equal(events.filter(e=>e.type==='task.process.async_exited').length,1);
  await stop();await stopEvents();
});

test('after-start ChatGPT policy does not install a terminal close barrier', async () => {
  const t=task('chat-after-start'); t.adapter='chatgpt'; const store=new InMemoryStore(job([t])); const bus=new MemoryEventBus(); let terminalBarrier;
  const adapter={name:'chatgpt',id:'fake-chatgpt',capabilities:['model','chatgpt'],launch(_task,_signal,context){terminalBarrier=context.waitForTerminal; return {id:'chat-runtime',launched:Promise.resolve(),promise:(context.waitForWorkerStart ?? Promise.resolve()).then(()=>({summary:'submitted'})),cancel(){}};}};
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,startAckTimeoutMs:100,chatgptTabClosePolicy:'after-start'});
  const stop=await reconciler.watch('j'); await reconciler.reconcile('j');
  assert.equal(terminalBarrier,undefined);
  await bus.publish(eventFor('j','chat-after-start',null,'task.started','running','worker began','user',undefined,await activeEventSource(store,'chat-after-start')));
  await bus.publish(eventFor('j','chat-after-start',null,'task.completed','succeeded','durable output','user',undefined,await activeEventSource(store,'chat-after-start')));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await store.load('j')).tasks[0].state,'SUCCEEDED'); await stop();
});

test('ChatGPT start acknowledgement timeout is explicit and worker-owned', async () => {
  const t=task('chat-timeout'); t.adapter='chatgpt'; const store=new InMemoryStore(job([t])); const bus=new MemoryEventBus();
  const adapter={name:'chatgpt',id:'fake-chatgpt',capabilities:['model','chatgpt'],launch(_task,_signal,context){return {id:'chat-runtime',launched:Promise.resolve(),promise:(context.waitForWorkerStart ?? Promise.resolve()).then(()=>({summary:'submitted'})),cancel(){}};}};
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,startAckTimeoutMs:20});
  const stop=await reconciler.watch('j'); await reconciler.reconcile('j'); await new Promise(resolve=>setTimeout(resolve,50));
  const durable=(await store.load('j')).tasks[0]; assert.equal(durable.state,'BLOCKED'); assert.equal(durable.failureReason,'worker_outcome_unknown'); assert.equal(durable.platformFailure?.classification,'start_ack_timeout'); assert.match(durable.error,/worker_start_timeout/); await stop();
});

test('ChatGPT reviewer uses the same start acknowledgement policy as normal ChatGPT tasks', async () => {
  const contextRoot=await mkdtemp(join(tmpdir(),'agents-relay-reviewer-context-')); await mkdir(join(contextRoot,'agents')); await writeFile(join(contextRoot,'agents','reviewer.agent.md'),'---\nname: reviewer\n---\nReview the managed task.\n');
  const work=task('work','SUCCEEDED'); const store=new InMemoryStore({...job([work]),headSha:'sha-review-timeout'}); const bus=new MemoryEventBus();
  const adapter={name:'chatgpt',id:'fake-chatgpt',capabilities:['model','chatgpt'],launch(_task,_signal,context){return {id:'chat-runtime',launched:Promise.resolve(),promise:(context.waitForWorkerStart ?? Promise.resolve()).then(()=>({summary:'submitted'})),cancel(){}};}};
  const reviewer={adapter:'chatgpt',routing:{provider:'chatgpt',model:'account-defaults',decidedBy:'test',decidedAt:now()}};
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,startAckTimeoutMs:100,reviewer,executionContextRoots:{globalRoot:contextRoot,neoRoot:null}});
  const stop=await reconciler.watch('j'); await reconciler.reconcile('j'); await new Promise(resolve=>setTimeout(resolve,40));
  const created=(await store.load('j')).tasks.find(item=>item.agentName==='reviewer'); assert.equal(created?.state,'QUEUED');
  const source=await activeEventSource(store,created.id);
  await bus.publish(eventFor('j',created.id,null,'task.started','running','review began','user',undefined,source));
  await bus.publish(eventFor('j',created.id,null,'task.completed','succeeded','generic review process completion','user',undefined,source));
  await new Promise(resolve=>setTimeout(resolve,5));
  let durable=await store.load('j');
  assert.equal(durable.tasks.find(item=>item.id===created.id)?.state,'RUNNING','generic task.completed must not consume reviewer execution before review outcome');
  assert.equal(durable.review?.outcome,'pending');
  await bus.publish(eventFor('j',created.id,null,'review.changes_required','failed','review changes required','user',{outcome:{head_sha:'sha-review-timeout',blocking_findings:[{summary:'fix reviewer ordering regression'}]}},source));
  await new Promise(resolve=>setTimeout(resolve,10));
  durable=await store.load('j');
  assert.equal(durable.tasks.find(item=>item.id===created.id)?.state,'SUCCEEDED');
  assert.equal(durable.tasks.find(item=>item.id===created.id)?.executionId,null);
  assert.equal(durable.review?.outcome,'changes_required');
  assert.equal(durable.tasks.filter(item=>item.id.startsWith('review-fix-')).length,1);
  await stop(); await rm(contextRoot,{recursive:true,force:true});
});



test('reviewer start acknowledgement timeout quarantines the unknown ChatGPT submission outcome', async () => {
  const contextRoot=await mkdtemp(join(tmpdir(),'agents-relay-reviewer-recovery-context-')); await mkdir(join(contextRoot,'agents')); await writeFile(join(contextRoot,'agents','reviewer.agent.md'),'---\nname: reviewer\n---\nReview the managed task.\n');
  const work=task('work','SUCCEEDED'); const store=new InMemoryStore({...job([work]),headSha:'sha-review-recovery'}); const bus=new MemoryEventBus();
  const adapter={name:'chatgpt',id:'fake-chatgpt',capabilities:['model','chatgpt'],launch(_task,_signal,context){return {id:'chat-runtime',launched:Promise.resolve(),promise:(context.waitForWorkerStart ?? Promise.resolve()).then(()=>({summary:'submitted'})),cancel(){}};}};
  const reviewer={adapter:'chatgpt',routing:{provider:'chatgpt',model:'account-defaults',decidedBy:'test',decidedAt:now()}};
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,startAckTimeoutMs:20,reviewer,executionContextRoots:{globalRoot:contextRoot,neoRoot:null}});
  const stop=await reconciler.watch('j'); await reconciler.reconcile('j'); await new Promise(resolve=>setTimeout(resolve,100));
  const saved=await store.load('j');
  const review=saved.tasks.find(item=>item.agentName==='reviewer');
  assert.equal(review?.state,'BLOCKED');
  assert.equal(review?.failureReason,'worker_outcome_unknown');
  assert.equal(review?.platformFailure?.executionId,review?.executionHistory?.[0]?.id);
  const recovery=saved.tasks.find(item=>item.agentName==='troubleshooter'&&item.parentTaskId===review?.id);
  assert.equal(recovery,undefined,'unknown ChatGPT submission outcome is quarantined without automatic replay or unnecessary Troubleshooter work');
  await stop(); await reconciler.close(); await rm(contextRoot,{recursive:true,force:true});
});

test('after-terminal ChatGPT tab close ignores stale and wrong-task terminal events', async () => {
  const t=task('chat-terminal'); t.adapter='chatgpt'; const store=new InMemoryStore(job([t])); const bus=new MemoryEventBus(); let released=false;
  const adapter={name:'chatgpt',id:'fake-chatgpt',capabilities:['model','chatgpt'],launch(_task,_signal,context){return {id:'chat-runtime',launched:Promise.resolve(),promise:(async()=>{await context.waitForWorkerStart; await context.waitForTerminal; released=true; return {summary:'submitted'};})(),cancel(){}};}};
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,startAckTimeoutMs:100,chatgptTabClosePolicy:'after-terminal'});
  const stop=await reconciler.watch('j'); await reconciler.reconcile('j');
  await bus.publish(eventFor('j','other',null,'task.completed','succeeded','wrong task','user'));
  await bus.publish({...eventFor('j','chat-terminal',null,'task.completed','succeeded','stale','user'),timestamp:new Date(0).toISOString()});
  assert.equal(released,false); assert.equal((await store.load('j')).tasks[0].state,'QUEUED');
  await bus.publish(eventFor('j','chat-terminal',null,'task.started','running','worker began','user',undefined,await activeEventSource(store,'chat-terminal')));
  await bus.publish(eventFor('j','other',null,'task.failed','failed','wrong task','user'));
  assert.equal(released,false);
  await bus.publish(eventFor('j','chat-terminal',null,'task.completed','succeeded','durable output','user',undefined,await activeEventSource(store,'chat-terminal')));
  await reconciler.idle();
  assert.equal(released,true); assert.equal((await store.load('j')).tasks[0].state,'SUCCEEDED'); await stop();
});

test('ChatGPT after-terminal close waits for a fresh exact terminal event', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-chatgpt-close-policy-'));
  const agentPath = join(directory, 'browser-worker.agent.md');
  await writeFile(agentPath, '# fake browser worker');
  let released = false;
  try {
    const t = task('chat-terminal'); t.adapter = 'chatgpt';
    const store = new InMemoryStore(job([t])); const bus = new MemoryEventBus();
    const adapter = new ChatGptAdapter({
      agentPath,
      tabClosePolicy: 'after-terminal',
      agentRunner: () => ({
        promise: Promise.resolve('done'),
        submitted: Promise.resolve(JSON.stringify({ operation: 'submit', status: 'submitted', verified: true })),
        release: () => { released = true; },
        cancel() {},
      }),
    });
    const reconciler = managedReconciler(store, { owner: 'test', adapters: [adapter], eventBus: bus, startAckTimeoutMs: 100 });
    const stop = await reconciler.watch('j');
    await reconciler.reconcile('j');
    const stale = new Date(0).toISOString();
    await bus.publish({ ...eventFor('j', 'chat-terminal', null, 'task.completed', 'succeeded', 'stale', 'user'), timestamp: stale });
    await bus.publish(eventFor('j', 'other-task', null, 'task.completed', 'succeeded', 'wrong task', 'user'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(released, false);
    assert.equal((await store.load('j')).tasks[0].state, 'QUEUED');
    await bus.publish(eventFor('j', 'chat-terminal', null, 'task.started', 'running', 'worker began', 'user', undefined, await activeEventSource(store, 'chat-terminal')));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(released, false);
    await bus.publish(eventFor('j', 'chat-terminal', null, 'task.failed', 'failed', 'durable failure', 'user', undefined, await activeEventSource(store, 'chat-terminal')));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(released, true);
    assert.equal((await store.load('j')).tasks[0].state, 'FAILED');
    await stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ChatGPT cancelled terminal event closes after-terminal tab and preserves runtime separation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-chatgpt-cancel-policy-'));
  const agentPath = join(directory, 'browser-worker.agent.md');
  await writeFile(agentPath, '# fake browser worker');
  let released = false;
  try {
    const t = task('chat-cancelled'); t.adapter = 'chatgpt';
    const store = new InMemoryStore(job([t])); const bus = new MemoryEventBus();
    const adapter = new ChatGptAdapter({ agentPath, tabClosePolicy: 'after-terminal', agentRunner: () => ({ promise: Promise.resolve('done'), submitted: Promise.resolve(JSON.stringify({ operation: 'submit', status: 'submitted', verified: true })), release: () => { released = true; }, cancel() {} }) });
    const reconciler = managedReconciler(store, { owner: 'test', adapters: [adapter], eventBus: bus, startAckTimeoutMs: 100 });
    const stop = await reconciler.watch('j'); await reconciler.reconcile('j');
    await bus.publish(eventFor('j', 'chat-cancelled', null, 'task.started', 'running', 'worker began', 'user', undefined, await activeEventSource(store, 'chat-cancelled')));
    await bus.publish(eventFor('j', 'chat-cancelled', null, 'task.cancelled', 'cancelled', 'cancelled by worker', 'user', undefined, await activeEventSource(store, 'chat-cancelled')));
    const terminalDeadline = Date.now() + 2000;
    while (Date.now() < terminalDeadline) {
      if (released && (await store.load('j')).tasks[0].state === 'CANCELLED') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(released, true);
    assert.equal((await store.load('j')).tasks[0].state, 'CANCELLED');
    await stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('sync adapter runtime exit without mandatory terminal event fails after bounded grace', async () => {
  const t=task('runtime-exit'); t.timeoutMs=1000; const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus(); const events=[];
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,postExitTerminalGraceMs:20});
  const stopEvents=await bus.subscribe('j',async event=>events.push(event)); const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  await bus.publish(eventFor('j','runtime-exit',null,'task.started','running','worker began','user',undefined,await activeEventSource(store,'runtime-exit')));
  adapter.resolvers[0].resolve({summary:'process exited zero'});
  await new Promise(resolve=>setTimeout(resolve,100));
  const durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'FAILED');
  assert.equal(durable.failureReason,'terminal_event_timeout');
  assert.equal(events.filter(event=>event.type==='task.process.exited').length,1);
  assert.equal(events.filter(event=>event.type==='task.failed').length,1);
  assert.ok((await store.load('j')).tasks.some(item => item.agentName === 'troubleshooter' && item.parentTaskId === 'runtime-exit'), 'watchdog must wake reconciliation to create a troubleshooter without manual retry');
  await reconciler.close();
  await stop(); await stopEvents();
});

test('unauthorized E2E injection fails closed before launching real worker', async () => {
  const original=process.env.E2E_REPO; delete process.env.E2E_REPO;
  try {
    const t=task('unauthorized-injection');
    t.testInjection={method:'worker.codex.launch',action:'return',execution:'skip',mock:'worker_model_not_found'};
    const store=new InMemoryStore(job([t]));
    const adapter=new FakeAdapter();
    const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:new MemoryEventBus()});
    const stop=await reconciler.watch('j');
    await reconciler.reconcile('j');
    await new Promise(resolve=>setTimeout(resolve,50));
    const durable=(await store.load('j')).tasks.find(item=>item.id==='unauthorized-injection');
    assert.equal(adapter.launches,0);
    assert.equal(durable.state,'FAILED');
    assert.match(durable.error,/E2E test injection refused/);
    await reconciler.close(); await stop();
  } finally {
    if(original===undefined) delete process.env.E2E_REPO; else process.env.E2E_REPO=original;
  }
});

test('projection injection survives worker launch for its later checkpoint', async () => {
  const original=process.env.E2E_REPO; process.env.E2E_REPO='owner/repo';
  try {
    const t=task('projection-injection');
    t.testInjection={method:'github.projectLocalMerge',action:'throw',execution:'after',error:{code:'SERVICE_UNAVAILABLE',message:'projection unavailable',status:503}};
    const store=new InMemoryStore(job([t]));
    const adapter=new FakeAdapter();
    const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:new MemoryEventBus()});
    const stop=await reconciler.watch('j');
    await reconciler.reconcile('j');
    await new Promise(resolve=>setTimeout(resolve,20));
    const durable=(await store.load('j')).tasks.find(item=>item.id==='projection-injection');
    assert.equal(adapter.launches,1);
    assert.equal(durable.testInjection?.method,'github.projectLocalMerge');
    adapter.resolvers[0].resolve({summary:'runtime exited'});
    await reconciler.close(); await stop();
  } finally {
    if(original===undefined) delete process.env.E2E_REPO; else process.env.E2E_REPO=original;
  }
});

test('ambiguous ChatGPT Browser Workspace delivery failure is quarantined without same-route replay', async () => {
  const t=task('browser-runtime-retry');
  t.adapter='chatgpt';
  t.state='QUEUED';
  t.attempt=1;
  t.maxAttempts=2;
  t.executionId='browser-exec-1';
  t.leaseOwner='relay';
  t.leaseExpiresAt=new Date(Date.now()+60000).toISOString();
  t.executionHistory=[{id:'browser-exec-1',attempt:1,startedAt:now()}];
  t.routing={provider:'chatgpt',model:'account-defaults',decidedBy:'test',decidedAt:now()};
  t.workerRequirements={runtime:'chatgpt',capabilities:['model','browser-workspace']};
  const store=new InMemoryStore(job([t]));
  const bus=new MemoryEventBus();
  const events=[];
  const stopEvents=await bus.subscribe('j',async event=>events.push(event));
  class FailureHarness extends Reconciler {
    trigger() { return this.failLaunch('j',t.id,t.executionId,'E2E browser-workspace runtime dependency unavailable','delivery'); }
  }
  const reconciler=new FailureHarness(store,{owner:'test',adapters:[],eventBus:bus,maxConcurrent:0});
  await reconciler.trigger();
  await new Promise(resolve=>setTimeout(resolve,20));
  const durable=await store.load('j');
  const original=durable.tasks.find(item=>item.id===t.id);
  assert.equal(original.state,'BLOCKED');
  assert.equal(original.attempt,1);
  assert.equal(original.executionId,null);
  assert.match(original.error,/browser-workspace runtime dependency unavailable/);
  assert.equal(original.failureReason,'worker_outcome_unknown');
  assert.equal(original.platformFailure?.classification,'outcome_unknown');
  assert.equal(original.platformFailure?.executionId,'browser-exec-1');
  assert.equal(original.routing,undefined);
  assert.equal(original.workerSelection,undefined);
  assert.equal(original.routingExclusions?.[0]?.workerId,'chatgpt');
  assert.ok(events.some(event=>event.type==='task.failed' && event.data?.reason==='worker_outcome_unknown'));
  assert.ok(events.some(event=>event.type==='task.failed' && event.data?.workflowEvent==='worker.platform_failure'));
  assert.equal(events.some(event=>event.type==='task.runtime_retry'),false);
  await reconciler.close(); await stopEvents();
});

test('running ChatGPT delivery rejection is quarantined and cannot reroute after start', async () => {
  const t=task('chat-running-failure'); t.adapter='chatgpt'; t.state='RUNNING'; t.attempt=1; t.maxAttempts=3;
  t.executionId='running-chat-exec'; t.leaseOwner='relay'; t.leaseExpiresAt=new Date(Date.now()+60000).toISOString();
  t.executionHistory=[{id:t.executionId,attempt:1,startedAt:now()}];
  t.routing={provider:'chatgpt',model:'account-defaults',decidedBy:'test',decidedAt:now()};
  const store=new InMemoryStore(job([t])); let cancelled=0;
  class FailureHarness extends Reconciler { trigger(){return this.failLaunch('j',t.id,t.executionId,PreSubmissionRejection.fromPlatformResponse({status:'rejected',submitted:false,code:'MODEL_UNAVAILABLE',message:'explicit rejection'}),'delivery');} }
  const reconciler=new FailureHarness(store,{owner:'test',adapters:[new FakeChatGptAdapter(),new FakeAdapter()],eventBus:new MemoryEventBus(),maxConcurrent:0});
  reconciler.live.set(t.id,{jobId:'j',taskId:t.id,executionId:t.executionId,execution:{id:'old',promise:new Promise(()=>{}),cancel(){cancelled++;}},controller:new AbortController(),launchBarrier:0,workerStarted:true,processSettled:false});
  await reconciler.trigger();
  const saved=(await store.load('j')).tasks[0];
  assert.equal(saved.state,'BLOCKED');
  assert.equal(saved.failureReason,'worker_outcome_unknown');
  assert.equal(saved.platformFailure.safeToReroute,true);
  assert.equal(cancelled,1);
  assert.equal(saved.executionId,null);
  await reconciler.close();
});

test('stale old-generation failure cannot cancel or mutate the current execution', async () => {
  const t=task('chat-generation-fence'); t.adapter='chatgpt'; t.state='QUEUED'; t.attempt=2;
  t.executionId='current-generation'; t.executionHistory=[{id:'old-generation',attempt:1,startedAt:now()},{id:t.executionId,attempt:2,startedAt:now()}];
  const store=new InMemoryStore(job([t])); let cancelled=0;
  class FailureHarness extends Reconciler { trigger(){return this.failLaunch('j',t.id,'old-generation',PreSubmissionRejection.fromPlatformResponse({status:'rejected',submitted:false,code:'MODEL_UNAVAILABLE',message:'explicit rejection'}),'delivery');} }
  const reconciler=new FailureHarness(store,{owner:'test',adapters:[new FakeChatGptAdapter()],eventBus:new MemoryEventBus(),maxConcurrent:0});
  reconciler.live.set(t.id,{jobId:'j',taskId:t.id,executionId:t.executionId,execution:{id:'new',promise:new Promise(()=>{}),cancel(){cancelled++;}},controller:new AbortController(),launchBarrier:0,workerStarted:true,processSettled:false});
  await reconciler.trigger();
  const saved=(await store.load('j')).tasks[0];
  assert.equal(saved.executionId,'current-generation');
  assert.equal(saved.state,'QUEUED');
  assert.equal(saved.platformFailure,undefined);
  assert.equal(cancelled,0);
  await reconciler.close();
});

test('confirmed ChatGPT platform rejection routes the same Task to a compatible Codex worker', async () => {
  const t=task('chat-platform-reroute');
  t.adapter='chatgpt'; t.state='QUEUED'; t.attempt=1; t.maxAttempts=3;
  t.executionId='chat-platform-exec'; t.leaseOwner='relay'; t.leaseExpiresAt=new Date(Date.now()+60000).toISOString();
  t.executionHistory=[{id:'chat-platform-exec',attempt:1,startedAt:now()}];
  t.routing={provider:'chatgpt',model:'account-defaults',decidedBy:'test',decidedAt:now()};
  t.workerSelection={workerId:'fake-chatgpt',adapter:'chatgpt',capabilities:['model','chatgpt'],selectedBy:'test',selectedAt:now()};
  t.workerRequirements={capabilities:[]};
  const store=new InMemoryStore(job([t])); const bus=new MemoryEventBus(); const events=[];
  const adapter=new FakeAdapter(); const stopEvents=await bus.subscribe('j',async event=>events.push(event));
  class FailureHarness extends Reconciler {
    trigger(){return this.failLaunch('j',t.id,t.executionId,PreSubmissionRejection.fromPlatformResponse({status:'rejected',submitted:false,code:'MODEL_UNAVAILABLE',message:'unsupported'}),'delivery');}
    routeForRetry(task){return this.routeTaskForExecution(job([task]),task);}
  }
  const reconciler=new FailureHarness(store,{owner:'test',adapters:[new FakeChatGptAdapter(),adapter],eventBus:bus,maxConcurrent:0});
  await reconciler.trigger(); await new Promise(resolve=>setTimeout(resolve,30));
  let saved=(await store.load('j')).tasks.find(item=>item.id===t.id);
  assert.equal(saved.state,'QUEUED');
  assert.equal(saved.routing,undefined);
  await reconciler.routeForRetry(saved);
  saved=(await store.load('j')).tasks.find(item=>item.id===t.id);
  assert.equal(saved.id,t.id);
  assert.equal(saved.state,'QUEUED');
  assert.equal(saved.adapter,'codex');
  assert.equal(saved.routing?.provider,'openai');
  assert.equal(saved.workerSelection?.adapter,'codex');
  assert.equal(saved.executionHistory?.length,1);
  assert.equal(saved.executionHistory?.[0]?.id,'chat-platform-exec');
  assert.equal(saved.platformFailure?.classification,'model_unavailable');
  assert.equal(saved.platformFailure?.executionId,'chat-platform-exec');
  assert.equal(saved.routingExclusions?.[0]?.workerId,'fake-chatgpt');
  assert.equal(events.filter(event=>event.type==='task.rerouting').length,1);
  assert.equal((await store.load('j')).tasks.some(item=>item.agentName==='troubleshooter'),false);
  await reconciler.close(); await stopEvents();
});

test('confirmed ChatGPT rejection with no Codex route follows the graph BLOCKED quarantine edge', async () => {
  const t=task('chat-platform-no-codex'); t.adapter='chatgpt'; t.state='QUEUED'; t.attempt=1; t.maxAttempts=3;
  t.executionId='chat-platform-no-codex-exec'; t.leaseOwner='relay'; t.leaseExpiresAt=new Date(Date.now()+60000).toISOString();
  t.executionHistory=[{id:t.executionId,attempt:1,startedAt:now()}];
  t.routing={provider:'chatgpt',model:'account-defaults',decidedBy:'test',decidedAt:now()};
  const store=new InMemoryStore(job([t])); const bus=new MemoryEventBus(); const events=[];
  const stopEvents=await bus.subscribe('j',async event=>events.push(event));
  class FailureHarness extends Reconciler { trigger(){return this.failLaunch('j',t.id,t.executionId,PreSubmissionRejection.fromPlatformResponse({status:'rejected',submitted:false,code:'MODEL_UNAVAILABLE',message:'unsupported'}),'delivery');} }
  const reconciler=new FailureHarness(store,{owner:'test',adapters:[new FakeChatGptAdapter()],eventBus:bus,maxConcurrent:0});
  await reconciler.trigger();
  const saved=(await store.load('j')).tasks[0];
  assert.equal(saved.state,'BLOCKED');
  assert.equal(saved.failureReason,'worker_platform_fallback_unavailable');
  assert.equal(saved.executionId,null);
  assert.ok(events.some(event=>event.type==='task.failed' && event.data?.workflowEvent==='worker.platform_failure'));
  await reconciler.close(); await stopEvents();
});

test('failed Codex exit preserves rate limit reason instead of terminal event timeout', async () => {
  class FailedExitAdapter extends FakeAdapter {
    launch(t, signal) {
      const execution = super.launch(t, signal);
      execution.processExit = { exitCode: 1, signal: null, stderr: 'rate limit exceeded: Usage limit reached for 5 hour' };
      return execution;
    }
  }
  const t = task('rate-limited'); t.timeoutMs = 1000; t.routing = { provider: 'zai', model: 'glm-5.3-flash' };
  const store = new InMemoryStore(job([t])); const bus = new MemoryEventBus(); const events = [];
  const adapter = new FailedExitAdapter();
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [adapter], eventBus: bus, postExitTerminalGraceMs: 20 });
  const stopEvents = await bus.subscribe('j', async event => events.push(event)); const stop = await reconciler.watch('j');
  await reconciler.reconcile('j');
  await bus.publish(eventFor('j', 'rate-limited', null, 'task.started', 'running', 'worker began', 'user', undefined, await activeEventSource(store, 'rate-limited')));
  adapter.resolvers[0].reject(new Error('rate limit exceeded: Usage limit reached for 5 hour'));
  await new Promise(resolve => setTimeout(resolve, 100));
  const durable = (await store.load('j')).tasks[0];
  assert.equal(durable.state, 'QUEUED');
  assert.notEqual(durable.routing?.provider, 'zai');
  assert.deepEqual(durable.routingExclusions?.map(item => ({provider:item.provider,model:item.model,reason:item.reason})), [
    {provider:'zai',model:'glm-5.3-flash',reason:'rate_limit_exceeded'},
  ]);
  assert.equal(events.filter(event => event.type === 'task.rerouting').length, 1);
  assert.equal((await store.load('j')).tasks.filter(item => item.agentName === 'troubleshooter').length, 0, 'provider quota reroute must not spawn Troubleshooter work');
  const failed = events.find(event => event.type === 'task.failed');
  assert.equal(failed.data.reason, 'rate_limit_exceeded');
  assert.equal(failed.data.exitCode, 1);
  assert.match(failed.message, /Usage limit reached/);
  await reconciler.close(); await stop(); await stopEvents();
});

test('model-not-found reroute preserves the actual rejection reason', async () => {
  class FailedExitAdapter extends FakeAdapter {
    launch(t, signal) {
      const execution = super.launch(t, signal);
      execution.processExit = { exitCode: 1, signal: null, stderr: 'model_not_found: model is unavailable' };
      return execution;
    }
  }
  const t = task('missing-model');
  t.timeoutMs = 1000;
  t.routing = { provider: 'openai', model: 'gpt-missing' };
  const store = new InMemoryStore(job([t]));
  const bus = new MemoryEventBus();
  const adapter = new FailedExitAdapter();
  const events = [];
  const stopEvents = await bus.subscribe('j', async event => events.push(event));
  const reconciler = managedReconciler(store, { owner:'test', adapters:[adapter], eventBus:bus, postExitTerminalGraceMs:20 });
  const stop = await reconciler.watch('j');
  await reconciler.reconcile('j');
  await bus.publish(eventFor('j', t.id, null, 'task.started', 'running', 'worker began', 'user', undefined, await activeEventSource(store, t.id)));
  adapter.resolvers[0].reject(new Error('model_not_found: model is unavailable'));
  await new Promise(resolve => setTimeout(resolve, 100));
  const durable = (await store.load('j')).tasks[0];
  assert.equal(durable.state, 'QUEUED');
  assert.equal(durable.routingExclusions?.[0]?.reason, 'model_not_found');
  assert.equal(events.find(event => event.type === 'task.failed')?.data?.reason, 'model_not_found');
  await reconciler.close(); await stop(); await stopEvents();
});

test('async ChatGPT runtime exit keeps the overall terminal timeout active', async () => {
  const t=task('async-runtime-exit'); t.adapter='chatgpt'; t.timeoutMs=40; const store=new InMemoryStore(job([t])); const adapter=new FakeChatGptAdapter(); const bus=new MemoryEventBus();
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,startAckTimeoutMs:100});
  const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  await bus.publish(eventFor('j',t.id,null,'task.started','running','worker began','user',undefined,await activeEventSource(store,t.id)));
  adapter.resolvers[0].resolve({summary:'submit runtime exited'});
  await new Promise(resolve=>setTimeout(resolve,80));
  const durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'FAILED');
  assert.equal(durable.failureReason,'terminal_event_timeout');
  await stop();
});

test('stale sync process settlement cannot clear a newer execution terminal timer', async () => {
  const t=task('stale-runtime-exit'); t.timeoutMs=1000; const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus();
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
  const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  const first=(await store.load('j')).tasks[0];
  const live=reconciler.live.get(t.id);
  assert.ok(live);
  const originalTimer=reconciler.terminalTimers.get(t.id);
  if (originalTimer) clearTimeout(originalTimer);
  const newerTimer=setTimeout(()=>{},1000);
  reconciler.terminalTimers.set(t.id,newerTimer);
  reconciler.live.set(t.id,{...live,executionId:'new-execution'});
  await store.saveTask({...first,executionId:'new-execution',updatedAt:now()});
  adapter.resolvers[0].resolve({summary:'old runtime exited'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reconciler.terminalTimers.get(t.id),newerTimer);
  clearTimeout(newerTimer);
  reconciler.terminalTimers.delete(t.id);
  await reconciler.close();
  await stop();
});

test('stale lease recovery cannot overwrite a terminal success or newer execution generation', async () => {
  const t=task('lease-race','RUNNING');
  t.attempt=2; t.maxAttempts=2; t.executionId='exec-old'; t.leaseOwner='relay-old';
  t.leaseExpiresAt=new Date(Date.now()-1000).toISOString();
  const store=new InMemoryStore(job([t]));
  const reconciler=managedReconciler(store,{owner:'test',adapters:[]});
  const stale=await store.load('j');

  const completed={...(await store.load('j')).tasks[0],state:'SUCCEEDED',result:{summary:'durable success'},error:null,leaseOwner:null,leaseExpiresAt:null,executionId:null,updatedAt:now()};
  await store.saveTask(completed);
  await reconciler.recoverLostExecutions(stale, Date.now());
  let durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'SUCCEEDED');
  assert.equal(durable.result?.summary,'durable success');

  const newer={...t,state:'RUNNING',executionId:'exec-new',leaseOwner:'relay-new',leaseExpiresAt:new Date(Date.now()-1000).toISOString(),updatedAt:now()};
  await store.saveTask(newer);
  await reconciler.recoverLostExecutions(stale, Date.now());
  durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'RUNNING');
  assert.equal(durable.executionId,'exec-new');
  assert.equal(durable.error,null);
});

test('normal terminal event remains authoritative when Codex exits afterward', async () => {
  const t=task('success-then-exit'); const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus(); const events=[];
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
  const stopEvents=await bus.subscribe('j',async event=>events.push(event)); const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  await bus.publish(eventFor('j','success-then-exit',null,'task.started','running','worker began','user',undefined,await activeEventSource(store,'success-then-exit')));
  await bus.publish(eventFor('j','success-then-exit',null,'task.completed','succeeded','durable output','user',undefined,await activeEventSource(store,'success-then-exit')));
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(adapter.cancelled > 0, 'accepted Codex terminal fact must stop the still-live worker process');
  assert.equal((await store.load('j')).tasks[0].state,'SUCCEEDED');
  assert.equal(events.filter(event=>event.type==='task.failed').length,0);
  assert.equal(events.filter(event=>event.type==='task.process.exited').length,0, 'cleanup after authoritative terminal event must be silent');
  await stop(); await stopEvents();
});

test('late correlated terminal event remains authoritative after process exit', async (context) => {
  const t = task('late-terminal-recovery');
  const store = new InMemoryStore(job([t]));
  const adapter = new FakeAdapter();
  const bus = new MemoryEventBus();
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [adapter], eventBus: bus });
  const stop = await reconciler.watch('j');
  context.after(async () => {
    await reconciler.close();
    await stop();
  });
  await reconciler.reconcile('j');

  const source = await activeEventSource(store, 'late-terminal-recovery');
  await bus.publish(eventFor('j', t.id, null, 'task.started', 'running', 'worker began', 'user', undefined, source));
  adapter.resolvers[0].resolve({ summary: 'runtime exited' });
  await new Promise(resolve => setTimeout(resolve, 20));

  const afterExit = (await store.load('j')).tasks[0];
  assert.equal(afterExit.state, 'RUNNING');
  assert.equal(afterExit.failureReason, undefined);

  await reconciler.handleEvent(eventFor('j', t.id, null, 'task.completed', 'succeeded', 'durable output', 'user', undefined, source));
  const recovered = (await store.load('j')).tasks[0];
  assert.equal(recovered.state, 'SUCCEEDED');
  assert.equal(recovered.result?.summary, 'durable output');
});

test('process exit does not interfere while terminal persistence is in flight', async () => {
  const t=task('terminal-persist-race');
  const store=new DelayedTerminalStore(job([t]));
  const adapter=new FakeAdapter();
  const bus=new MemoryEventBus();
  const events=[];
  const launchReconciler=managedReconciler(store,{owner:'launcher',adapters:[adapter],eventBus:bus});
  const lifecycleReconciler=managedReconciler(store,{owner:'lifecycle',adapters:[adapter],eventBus:bus});
  const stopEvents=await bus.subscribe('j',async event=>events.push(event));
  await launchReconciler.reconcile('j');
  const source=await activeEventSource(store,'terminal-persist-race');
  await lifecycleReconciler.handleEvent(eventFor('j','terminal-persist-race',null,'task.started','running','worker began','user',undefined,source));
  const terminal=lifecycleReconciler.handleEvent(eventFor('j','terminal-persist-race',null,'task.completed','succeeded','durable output','user',undefined,source));
  await store.terminalSaveStarted;
  adapter.resolvers[0].resolve({summary:'runtime exited'});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(events.filter(event=>event.type==='task.failed').length,0);
  store.releaseTerminalSave();
  await terminal;
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await store.load('j')).tasks[0].state,'SUCCEEDED');
  assert.equal(events.filter(event=>event.type==='task.failed').length,0);
  await stopEvents();
});

test('worker failure before Codex nonzero exit is not duplicated by the watchdog', async () => {
  const t=task('failed-then-exit'); const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus(); const events=[];
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
  const stopEvents=await bus.subscribe('j',async event=>events.push(event)); const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  await bus.publish(eventFor('j','failed-then-exit',null,'task.started','running','worker began','user',undefined,await activeEventSource(store,'failed-then-exit')));
  await bus.publish(eventFor('j','failed-then-exit',null,'task.failed','failed','apply_patch could not be verified','user',undefined,await activeEventSource(store,'failed-then-exit')));
  adapter.resolvers[0].reject(new Error('Codex exited 1'));
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal((await store.load('j')).tasks[0].state,'FAILED');
  assert.equal(events.filter(event=>event.type==='task.failed').length,1);
  await reconciler.close();
  await stop(); await stopEvents();
});

test('Codex exit after task.started is observational and does not terminate the task', async () => {
  const t=task('exit-without-terminal'); t.timeoutMs=1000; const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus(); const events=[];
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
  const stopEvents=await bus.subscribe('j',async event=>events.push(event)); const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  await bus.publish(eventFor('j','exit-without-terminal',null,'task.started','running','worker began','user',undefined,await activeEventSource(store,'exit-without-terminal')));
  adapter.resolvers[0].resolve({summary:'process exited'});
  await new Promise(resolve=>setTimeout(resolve,30));
  const durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'RUNNING');
  assert.equal(durable.failureReason,undefined);
  assert.equal(events.filter(event=>event.type==='task.failed').length,0);
  assert.equal(events.filter(event=>event.type==='task.process.exited').length,1);
  await reconciler.close();
  await stop(); await stopEvents();
});

test('Codex exit before task.started is observational and does not terminate the task', async () => {
  const t=task('exit-before-start'); t.timeoutMs=1000; const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus();
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
  const stop=await reconciler.watch('j'); await reconciler.reconcile('j'); adapter.resolvers[0].resolve({summary:'process exited'});
  await new Promise(resolve=>setTimeout(resolve,30));
  const durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'QUEUED'); assert.equal(durable.failureReason,undefined); await reconciler.close(); await stop();
});

test('asynchronous LaunchFailure becomes authoritative delivery failure', async () => {
  const t=task('delivery-fail');
  const store=new InMemoryStore(job([t]));
  const bus=new MemoryEventBus();
  const events=[];
  const stop=await bus.subscribe('j',async event=>{events.push(event);});
  const adapter={
    name:'codex',id:'delivery-test',capabilities:['model','codex'],
    launch:()=>({id:'exec-delivery',promise:Promise.reject(new LaunchFailure('submit was not accepted')),cancel(){}})
  };
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
  await reconciler.reconcile('j');
  await reconciler.idle();
  const durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'FAILED');
  assert.match(durable.error,/Worker delivery failed/);
  assert.equal(events.some(event=>event.type==='task.failed' && event.data?.phase==='delivery'),true);
  await stop();
});


test('ChatGPT delivery failure after correlated task.started quarantines and cancels that generation', async () => {
  const t=task('chat-delivery-after-start'); t.adapter='chatgpt';
  const store=new InMemoryStore(job([t])); const bus=new MemoryEventBus(); const events=[];
  let rejectRun;
  const adapter={
    name:'chatgpt',id:'chatgpt-after-start',capabilities:['model','chatgpt'],
    launch(current) {
      const source=eventSource('j',current.id,current.executionId);
      const promise=new Promise((_resolve,reject)=>{rejectRun=reject;});
      void bus.publish(eventFor('j',current.id,null,'task.started','running','worker began','user',undefined,source));
      return {id:'chat-run',launched:Promise.resolve(),promise,cancel(){}};
    }
  };
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,startAckTimeoutMs:100,emit:event=>events.push(event)});
  const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  for(let i=0;i<50;i++){
    const observed=(await store.load('j')).tasks[0];
    if(observed.state==='RUNNING') break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal((await store.load('j')).tasks[0].state,'RUNNING');
  rejectRun(new LaunchFailure('DOM receipt missed the submitted user turn'));
  await new Promise(resolve=>setTimeout(resolve,20));
  let durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'BLOCKED');
  assert.equal(durable.failureReason,'worker_outcome_unknown');
  assert.equal(events.some(event=>event.type==='task.failed' && event.data?.workflowEvent==='worker.platform_failure'),true);
  assert.equal(events.some(event=>event.type==='task.process.delivery_failed' && event.data?.authoritative===false),false);
  await bus.publish(eventFor('j',durable.id,null,'task.completed','succeeded','review finished','user',undefined,eventSource('j',durable.id,durable.executionId)));
  await new Promise(resolve=>setTimeout(resolve,20));
  durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'BLOCKED');
  assert.equal(durable.failureReason,'worker_outcome_unknown');
  await stop();
});

test('terminal event persists valid Job-defined tag separately from lifecycle and result data', async () => {
  const t = task('tag-report', 'RUNNING');
  t.adapter = 'orchestrator';
  const root = { ...job([t]), tag: { description: 'E2E outcome.', values: { pass: '✅', fail: '❌' } } };
  const store = new InMemoryStore(root);
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [] });
  await reconciler.handleEvent(eventFor('j', t.id, null, 'task.completed', 'succeeded', 'check complete', 'user', { tag: 'pass', evidence: 'ok' }));
  const durable = (await store.load('j')).tasks[0];
  assert.equal(durable.state, 'SUCCEEDED');
  assert.equal(durable.tag, 'pass');
  assert.deepEqual(durable.result.data, { evidence: 'ok' });
});

test('terminal event ignores undeclared tag values without changing lifecycle', async () => {
  const t = task('tag-invalid', 'RUNNING');
  t.adapter = 'orchestrator';
  const root = { ...job([t]), tag: { description: 'E2E outcome.', values: { pass: '✅', fail: '❌' } } };
  const store = new InMemoryStore(root);
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [] });
  await reconciler.handleEvent(eventFor('j', t.id, null, 'task.completed', 'succeeded', 'check complete', 'user', { tag: 'maybe' }));
  const durable = (await store.load('j')).tasks[0];
  assert.equal(durable.state, 'SUCCEEDED');
  assert.equal(durable.tag, undefined);
  assert.equal(durable.result.data, undefined);
});

test('late completed recovers legacy delivery-after-start failure', async () => {
  const t=task('legacy-delivery-failure','FAILED'); t.adapter='chatgpt'; t.executionId='legacy-delivery-exec';
  t.error='Worker delivery failed after task.started: DOM receipt missed user turn';
  t.failureReason='worker_delivery_after_start';
  t.updatedAt='2026-09-20T20:00:00.000Z';
  const store=new InMemoryStore(job([t])); const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()]});
  await reconciler.handleEvent({...eventFor('j',t.id,null,'task.completed','succeeded','late valid completion','user',undefined,eventSource('j',t.id,t.executionId)),timestamp:'2026-09-20T20:00:03.000Z'});
  const durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'SUCCEEDED');
  assert.equal(durable.error,null);
});

test('scheduled autonomous cycle ignores failures from older slots and creates a fresh planner', async () => {
  const oldFailed=task('old-failed','FAILED'); oldFailed.createdAt='2026-09-21T16:00:00.000Z'; oldFailed.updatedAt=oldFailed.createdAt;
  const oldPlanner=task('planner-1','SUCCEEDED'); oldPlanner.kind='planner'; oldPlanner.adapter='orchestrator'; oldPlanner.routing=undefined; oldPlanner.agentName='planner'; oldPlanner.createdAt='2026-09-21T16:05:00.000Z'; oldPlanner.updatedAt=oldPlanner.createdAt; oldPlanner.plannerResult={objective_status:'satisfied',assessment:'previous slot done',next_tasks:[]};
  const root={...job([oldFailed,oldPlanner]),executionMode:'autonomous',state:'ACTIVE',objective:'repeat the objective',schedule:{cron:'*/10 * * * *',timezone:'UTC',nextRunAt:'2026-09-21T16:30:00.000Z',missedRunPolicy:'skip',concurrencyPolicy:'skip',lastScheduledSlot:'2026-09-21T16:20:00.000Z',currentRunSlot:'2026-09-21T16:20:00.000Z',lastRunAt:'2026-09-21T16:10:00.000Z'}};
  const store=new InMemoryStore(root);
  const reconciler=managedReconciler(store,{owner:'test',adapters:[],maxConcurrent:0,planner:{plan:async()=>({objective_status:'satisfied',assessment:'current slot done',next_tasks:[]})}});
  await reconciler.reconcile('j');
  await reconciler.idle();
  const saved=await store.load('j');
  const fresh=saved.plans?.find(item=>item.id==='plan-2');
  assert.ok(fresh);
  assert.equal(fresh.previousPlanId,'planner-1');
  assert.equal(fresh.status,'SUCCEEDED');
  assert.equal(saved.tasks.filter(item=>item.kind==='planner').length,1); // legacy history only
  assert.notEqual(saved.state,'FAILED');
});

test('scheduled autonomous cycle keeps ACTIVE lifecycle and derives WAITING between runs', async () => {
  const current=task('planner-1','SUCCEEDED'); current.kind='planner'; current.adapter='orchestrator'; current.routing=undefined; current.agentName='planner'; current.createdAt='2026-09-21T16:21:00.000Z'; current.updatedAt=current.createdAt; current.plannerResult={objective_status:'satisfied',assessment:'this slot done',next_tasks:[]};
  const root={...job([current]),executionMode:'autonomous',state:'ACTIVE',headSha:'scheduled-sha',schedule:{cron:'*/10 * * * *',timezone:'UTC',nextRunAt:'2026-09-21T16:30:00.000Z',missedRunPolicy:'skip',concurrencyPolicy:'skip',lastScheduledSlot:'2026-09-21T16:20:00.000Z',currentRunSlot:'2026-09-21T16:20:00.000Z',lastRunAt:null}};
  const store=new InMemoryStore(root); let merges=0; store.mergePullRequest=async()=>{merges+=1;};
  const reconciler=managedReconciler(store,{owner:'test',adapters:[],maxConcurrent:0});
  await reconciler.reconcile('j');
  const saved=await store.load('j');
  assert.equal(saved.state,'ACTIVE');
  assert.equal(deriveJobRuntimeStatus(saved,'OPEN'),'WAITING');
  assert.ok(saved.schedule.lastRunAt);
  assert.equal(saved.tasks.some(item=>item.agentName==='reviewer'),false);
  assert.equal(merges,0);
});

test('final review ignores troubleshooter recovery history', async () => {
  const succeeded=task('done','SUCCEEDED');
  const recoveryDone=task('troubleshoot-done-a1','SUCCEEDED'); recoveryDone.agentName='troubleshooter'; recoveryDone.parentTaskId='done';
  const recoveryCancelled=task('troubleshoot-done-a2','CANCELLED'); recoveryCancelled.agentName='troubleshooter'; recoveryCancelled.parentTaskId='done'; recoveryCancelled.error='Cancelled by user';
  const store=new InMemoryStore({...job([succeeded,recoveryDone,recoveryCancelled]),state:'ACTIVE',headSha:'recovery-review-sha'});
  const bus=new MemoryEventBus();
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:bus,maxConcurrent:0,reviewer:{adapter:'chatgpt',routing:{provider:'chatgpt',model:'account-defaults',decidedBy:'test',decidedAt:now()}}});
  await reconciler.reconcile('j');
  const saved=await store.load('j');
  const review=saved.tasks.find(item=>item.agentName==='reviewer');
  assert.ok(review);
  assert.deepEqual(review.dependencies,['done']);
  assert.equal(deriveJobRuntimeStatus(saved,'OPEN'),'QUEUED');
});

test('cancelled Task supersede uses resolution graph and reopens implementation completion gate', async () => {
  const succeeded=task('done','SUCCEEDED');
  const cancelled=task('obsolete','CANCELLED'); cancelled.error='Cancelled by user';
  const store=new InMemoryStore({...job([succeeded,cancelled]),state:'ACTIVE',headSha:'resolution-supersede-sha'});
  const { supersedeCancelledTask } = await import('../dist/task-actions.js');
  const { implementationComplete } = await import('../dist/runtime-status.js');
  assert.equal(implementationComplete(await store.load('j')),false);
  const result=await supersedeCancelledTask(store,'j','obsolete','after corrected planning generation');
  assert.equal(result.task.state,'CANCELLED');
  assert.equal(result.task.resolution?.path,'cancel_supersede');
  assert.equal(result.task.resolution?.state,'resolved');
  assert.match(result.task.error,/^Superseded /);
  assert.equal(implementationComplete(await store.load('j')),true);
  const failed=task('failed','FAILED'); const failedStore=new InMemoryStore(job([failed]));
  await assert.rejects(()=>supersedeCancelledTask(failedStore,'j','failed','not obsolete'),/must already be CANCELLED/);
});

test('final review ignores explicitly superseded cancelled history', async () => {
  const succeeded=task('done','SUCCEEDED');
  const superseded=task('old','CANCELLED'); superseded.error='Superseded after objective split';
  const store=new InMemoryStore({...job([succeeded,superseded]),state:'ACTIVE',headSha:'abc1234567890'});
  const bus=new MemoryEventBus();
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:bus,maxConcurrent:0,reviewer:{adapter:'chatgpt',routing:{provider:'chatgpt',model:'account-defaults',decidedBy:'test',decidedAt:now()}}});
  await reconciler.reconcile('j');
  const saved=await store.load('j');
  const review=saved.tasks.find(item=>item.agentName==='reviewer');
  assert.ok(review);
  assert.deepEqual(review.dependencies,['done']);
});

test('async launch and delivery rejection emits exactly one task.failed', async () => {
  const t=task('dedupe-launch'); t.adapter='chatgpt'; const store=new InMemoryStore(job([t])); const bus=new MemoryEventBus(); const events=[];
  const error=new LaunchFailure('same failure');
  const adapter={name:'chatgpt',id:'dedupe-chatgpt',capabilities:['model','chatgpt'],launch:()=>({id:'x',launched:Promise.reject(error),promise:Promise.reject(error),cancel(){}})};
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,startAckTimeoutMs:100,emit:event=>{events.push(event);}});
  await reconciler.reconcile('j'); await reconciler.idle(); await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(events.filter(event=>event.type==='task.failed').length,1);
  assert.equal((await store.load('j')).tasks[0].state,'BLOCKED');
  assert.equal((await store.load('j')).tasks[0].failureReason,'worker_outcome_unknown');
});
test('late worker events recover a watchdog timeout failure', async () => {
  const t=task('late-worker','FAILED'); t.adapter='chatgpt'; t.executionId='late-worker-exec'; t.error='Worker start-ack failed: worker_start_timeout'; t.failureReason='worker_start_timeout'; t.updatedAt='2026-09-20T20:00:00.000Z';
  const store=new InMemoryStore(job([t])); const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()]});
  await reconciler.handleEvent({...eventFor('j','late-worker',null,'task.started','running','worker really started','user',undefined,eventSource('j','late-worker','late-worker-exec')),timestamp:'2026-09-20T20:00:01.000Z'});
  assert.equal((await store.load('j')).tasks[0].state,'RUNNING');
  await reconciler.handleEvent({...eventFor('j','late-worker',null,'task.completed','succeeded','worker really completed','user',undefined,eventSource('j','late-worker','late-worker-exec')),timestamp:'2026-09-20T20:00:02.000Z'});
  const durable=(await store.load('j')).tasks[0]; assert.equal(durable.state,'SUCCEEDED'); assert.equal(durable.error,null);
});

test('late completed event directly recovers terminal timeout failure', async () => {
  const t=task('late-complete','FAILED'); t.adapter='chatgpt'; t.executionId='late-complete-exec'; t.error='Task late-complete timed out waiting for the mandatory terminal worker event'; t.failureReason='terminal_event_timeout'; t.updatedAt='2026-09-20T20:00:00.000Z';
  const store=new InMemoryStore(job([t])); const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()]});
  await reconciler.handleEvent({...eventFor('j','late-complete',null,'task.completed','succeeded','done after timeout','user',undefined,eventSource('j','late-complete','late-complete-exec')),timestamp:'2026-09-20T20:00:03.000Z'});
  assert.equal((await store.load('j')).tasks[0].state,'SUCCEEDED');
});

test('late events do not revive genuine failures or stale watchdog events', async () => {
  const genuine=task('genuine','FAILED'); genuine.adapter='chatgpt'; genuine.executionId='genuine-exec'; genuine.error='worker reported failure'; genuine.updatedAt='2026-09-20T20:00:00.000Z';
  const stale=task('stale','FAILED'); stale.adapter='chatgpt'; stale.executionId='stale-exec'; stale.error='Task stale timed out waiting for the mandatory terminal worker event'; stale.failureReason='terminal_event_timeout'; stale.updatedAt='2026-09-20T20:00:05.000Z';
  const store=new InMemoryStore(job([genuine,stale])); const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()]});
  await reconciler.handleEvent({...eventFor('j','genuine',null,'task.started','running','late','user',undefined,eventSource('j','genuine','genuine-exec')),timestamp:'2026-09-20T20:00:01.000Z'});
  await reconciler.handleEvent({...eventFor('j','stale',null,'task.completed','succeeded','old completion','user',undefined,eventSource('j','stale','stale-exec')),timestamp:'2026-09-20T20:00:04.000Z'});
  const durable=await store.load('j'); assert.equal(durable.tasks[0].state,'FAILED'); assert.equal(durable.tasks[1].state,'SUCCEEDED', 'same execution ID owns recovery despite untrusted event timestamp');
});

test('correlated terminal completed event is authoritative', async () => {
  const t=task('event-complete'); const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus();
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
  const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  await bus.publish(eventFor('j','event-complete',null,'task.started','running','worker began','user',undefined,await activeEventSource(store,'event-complete')));
  await bus.publish(eventFor('j','event-complete',null,'task.completed','succeeded','stale execution','orchestrator',undefined,{id:executionEventSource('j','event-complete','older-execution')}));
  assert.equal((await store.load('j')).tasks[0].state,'RUNNING');
  adapter.resolvers[0].resolve({summary:'runtime exited'});
  await bus.publish(eventFor('j','event-complete',null,'task.completed','succeeded','durable output written','orchestrator',{artifact:'PR'},await activeEventSource(store,'event-complete')));
  await new Promise(resolve=>setTimeout(resolve,20));
  const durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'SUCCEEDED');
  assert.equal(durable.result.summary,'durable output written');
  assert.equal(durable.result.data.artifact,'PR');
  await stop();
});

test('terminal event published during launch cannot be overwritten back to running', async () => {
  const t=task('instant-terminal'); const store=new InMemoryStore(job([t])); const bus=new MemoryEventBus();
  const adapter={
    name:'codex', id:'instant-codex', capabilities:['model','codex'],
    launch(current) {
      const source=eventSource('j',current.id,current.executionId); void bus.publish(eventFor('j',current.id,current.parentTaskId,'task.started','running','worker began','user',undefined,source)).then(()=>bus.publish(eventFor('j',current.id,current.parentTaskId,'task.completed','succeeded','instant complete','orchestrator',undefined,source)));
      return {id:'runtime-id',promise:Promise.resolve({summary:'runtime exited'}),cancel(){}};
    }
  };
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
  const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  await reconciler.idle();
  const durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'SUCCEEDED');
  assert.equal(durable.result.summary,'instant complete');
  await stop();
});

test('correlated failed events set terminal durable states', async () => {
  for (const [type,state] of [['task.failed','FAILED']]) {
    const t=task(type); const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus();
    const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
    const stop=await reconciler.watch('j');
    await reconciler.reconcile('j');
    await bus.publish(eventFor('j',type,null,'task.started','running','worker began','user',undefined,await activeEventSource(store,type)));
    await bus.publish(eventFor('j',type,null,type,type==='task.failed'?'failed':'blocked','terminal','user',undefined,await activeEventSource(store,type)));
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal((await store.load('j')).tasks[0].state,state);
    await reconciler.close();
    await stop();
  }
});

test('ordinary Worker cannot set its own Task to BLOCKED', async () => {
  const t=task('cannot-block'); const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter();
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:new MemoryEventBus()});
  await reconciler.reconcile('j');
  const source=await activeEventSource(store,t.id);
  assert.equal((await reconciler.applyEvent(eventFor('j',t.id,null,'task.started','running','worker started','user',{},source))).applied,true);
  const result=await reconciler.applyEvent(eventFor('j',t.id,null,'task.blocked','blocked','worker wants to wait','user',{},source));
  assert.equal(result.applied,false);
  assert.equal((await store.load('j')).tasks[0].state,'RUNNING');
  await reconciler.close();
});

test('terminal event for another task cannot complete running work', async () => {
  const t=task('target'); const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus();
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
  const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  await bus.publish(eventFor('j','target',null,'task.started','running','worker began','user',undefined,await activeEventSource(store,'target')));
  await bus.publish(eventFor('j','other',null,'task.completed','succeeded','wrong task','orchestrator'));
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await store.load('j')).tasks[0].state,'RUNNING');
  await bus.publish(eventFor('j','target',null,'task.completed','succeeded','right task','orchestrator',undefined,await activeEventSource(store,'target')));
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await store.load('j')).tasks[0].state,'SUCCEEDED');
  await stop();
});

test('timeout produces explicit terminal-event failure when worker never reports terminal state', async () => {
  const t=task('timeout'); t.timeoutMs=20; const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus();
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
  const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  await new Promise(resolve=>setTimeout(resolve,60));
  const durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'FAILED');
  assert.match(durable.error,/mandatory terminal worker event/);
  await stop();
});

test('continuation runs only after completed terminal event', async () => {
  const t=task('child'); t.continuation={kind:'command',target:'echo'}; const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus(); const calls=[];
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,continuations:[{kind:'command',continue:async input=>calls.push(input)}]});
  const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  await bus.publish(eventFor('j','child',null,'task.started','running','worker began','user',undefined,await activeEventSource(store,'child')));
  adapter.resolvers[0].resolve({summary:'runtime only'});
  await reconciler.idle();
  assert.equal(calls.length,0);
  await bus.publish(eventFor('j','child',null,'task.completed','succeeded','final result','orchestrator',undefined,await activeEventSource(store,'child')));
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(calls,['final result']);
  await stop();
});

test('Codex launch requires routing metadata and applies command contract', () => {
  const t=task('model','QUEUED'); delete t.routing;
  assert.throws(() => new CodexAdapter('definitely-not-started').launch(t, new AbortController().signal), /routing metadata/);
});

test('dashboard uses safe DOM rendering and named live events', () => { assert.equal(dashboardHtml.includes('innerHTML'),false); assert.equal(dashboardHtml.includes("addEventListener('relay'"),true); });
test('dashboard omits job objective from selected-job summary', () => { assert.equal(dashboardHtml.includes("field('Objective',job.objective"), false); });
test('dashboard connection status is color-only without visible status text', () => { for (const label of ['Connecting…','Live · durable state connected','Live · event stream connected','Degraded · event stream reconnecting','Error · durable state unavailable']) assert.equal(dashboardHtml.includes(label),false); assert.match(dashboardHtml,/aria-label=\"Connecting\"/); });
test('event bus wakes reconciliation and dashboard serves durable state', async () => { const store=new InMemoryStore(job([task('dash','SUCCEEDED')])); const bus=new MemoryEventBus(); const server=managedDashboard(store,0,bus,10000,'j'); await new Promise(resolve=>server.once('listening',resolve)); const address=server.address(); const port=typeof address==='object'&&address ? address.port : 0; const response=await fetch(`http://127.0.0.1:${port}/api/job`); assert.equal(response.status,200); assert.match(await response.text(),/dash/); server.close(); });
test('dashboard selected-job refresh serves a cold-cache target by repository and PR', async () => { const selected={...job([task('selected','SUCCEEDED')]),id:'selected'}; const refreshed={...selected,tasks:[...selected.tasks,task('new-durable-task','QUEUED')]}; const store=new InMemoryStore(selected); let target; const server=managedDashboard(store,0,undefined,10000,'selected',undefined,async()=>[],undefined,undefined,async(id,value)=>{target=value;return id==='selected'&&value?.repository==='owner/repo'&&value?.prNumber===1?refreshed:null}); await new Promise(resolve=>server.once('listening',resolve)); const address=server.address(); const port=typeof address==='object'&&address ? address.port : 0; const response=await fetch(`http://127.0.0.1:${port}/api/job?id=selected&repo=owner%2Frepo&pr=1`); assert.equal(response.status,200); const body=await response.text(); assert.match(body,/selected/); assert.match(body,/new-durable-task/); assert.deepEqual(target,{repository:'owner/repo',prNumber:1}); const missing=await fetch(`http://127.0.0.1:${port}/api/job?id=missing&repo=owner%2Frepo&pr=1`); assert.equal(missing.status,404); server.close(); });

test('relay control lookup sends managed repository and PR identity', async () => { let requestUrl=''; const server=(await import('node:http')).createServer((req,res)=>{requestUrl=req.url??'';res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(job()));}); server.listen(0,'127.0.0.1'); await once(server,'listening'); const address=server.address(); const port=typeof address==='object'&&address?address.port:0; await relayControlJob(['--host','127.0.0.1','--port',String(port),'--repo','owner/repo','--pr','1'],'j'); assert.equal(requestUrl,'/api/job?id=j&repo=owner%2Frepo&pr=1'); server.close(); });

test('relay job state command routes lifecycle mutation through daemon control API', async () => {
  let requestUrl=''; let method='';
  const server=(await import('node:http')).createServer((req,res)=>{requestUrl=req.url??'';method=req.method??'';res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({...job(),state:'CANCELLED'}));});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address=server.address(); const port=typeof address==='object'&&address?address.port:0;
  const result=await relayJobStateCommand(['--host','127.0.0.1','--port',String(port),'--repo','owner/repo','--pr','1'],'j','CANCELLED');
  assert.equal(method,'POST');
  assert.equal(requestUrl,'/api/job-state?id=j&state=CANCELLED&repo=owner%2Frepo&pr=1');
  assert.equal(result.state,'CANCELLED');
  server.close();
});


test('workspace webhook forwards only self-contained PR facts for configured repositories', async () => {
  const selected={...job([task('webhook-task','SUCCEEDED')]),id:'webhook-job',repository:'lalalic/agents-relay',prNumber:9};
  const store=new InMemoryStore(selected);
  const received=[];
  const secret='workspace-secret';
  const server=managedDashboard(store,0,undefined,10000,'webhook-job',undefined,async()=>[{job:selected,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null}],{secret,repositories:new Set(['lalalic/agents-relay','lalalic/neo']),wake:async event=>{received.push(event);}});
  await new Promise(resolve=>server.once('listening',resolve));
  const address=server.address(); const port=typeof address==='object'&&address?address.port:0;
  const body=JSON.stringify({action:'synchronize',repository:{full_name:'lalalic/agents-relay'},pull_request:{number:9,head:{ref:'feat/webhook',sha:'abc123'}}});
  const signature='sha256='+createHmac('sha256',secret).update(body).digest('hex');
  const response=await fetch(`http://127.0.0.1:${port}/webhooks/github`,{method:'POST',headers:{'content-type':'application/json','x-github-delivery':'workspace-delivery','x-github-event':'pull_request','x-hub-signature-256':signature},body});
  assert.equal(response.status,202);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(received.length,1);
  assert.equal(received[0].repository,'lalalic/agents-relay');
  assert.equal(received[0].pullRequest,9);
  assert.deepEqual(received[0].pullRequestFacts,{state:'OPEN',head:{ref:'feat/webhook',sha:'abc123'}});

  const ignoredBody=JSON.stringify({action:'created',repository:{full_name:'lalalic/agents-relay'},issue:{number:9,pull_request:{url:'x'}},comment:{body:'normal human comment'}});
  const ignoredSignature='sha256='+createHmac('sha256',secret).update(ignoredBody).digest('hex');
  const ignored=await fetch(`http://127.0.0.1:${port}/webhooks/github`,{method:'POST',headers:{'content-type':'application/json','x-github-delivery':'workspace-ignored','x-github-event':'issue_comment','x-hub-signature-256':ignoredSignature},body:ignoredBody});
  assert.equal(await ignored.text(),'Ignored');
  assert.equal(received.length,1);
  server.close();
});


test('memory event bus supports explicit all-job subscriptions without weakening subject safety', async () => {
  const bus=new MemoryEventBus(); const seen=[]; const unsubscribe=await bus.subscribeAll(async event=>{seen.push(event.job_id);});
  await bus.publish({version:1,event_id:'e1',job_id:'job-a',task_id:'t',parent_task_id:null,type:'job.wake',status:'queued',timestamp:new Date().toISOString(),visibility:'orchestrator',level:'info',message:'wake'});
  await bus.publish({version:1,event_id:'e2',job_id:'job-b',task_id:'t',parent_task_id:null,type:'job.wake',status:'queued',timestamp:new Date().toISOString(),visibility:'orchestrator',level:'info',message:'wake'});
  await unsubscribe(); assert.deepEqual(seen,['job-a','job-b']); assert.throws(()=>subjectToken('*'),/Unsafe/);
});

test('dashboard returns an error without sending success headers first when durable snapshot fails', async () => {
  const store={load:async()=>{throw new Error('durable unavailable');},saveJob:async()=>{throw new Error('unused');},appendEvent:async()=>{throw new Error('unused');}};
  const server=managedDashboard(store,0,undefined,10000,'j'); await new Promise(resolve=>server.once('listening',resolve));
  const address=server.address(); const port=typeof address==='object'&&address?address.port:0;
  const response=await fetch(`http://127.0.0.1:${port}/api/job`); assert.equal(response.status,404); assert.match(await response.text(),/durable unavailable/);
  server.close();
});

test('dashboard usage failure returns 503 without double-sending headers', async () => {
  const store=new InMemoryStore(job()); const usageRegistry={snapshot:async()=>{throw new Error('usage unavailable');}};
  const server=managedDashboard(store,0,undefined,10000,'j',usageRegistry); await new Promise(resolve=>server.once('listening',resolve));
  const address=server.address(); const port=typeof address==='object'&&address?address.port:0;
  const response=await fetch(`http://127.0.0.1:${port}/api/usage`); assert.equal(response.status,503); assert.match(await response.text(),/usage unavailable/);
  server.close();
});


test('managed model worker input contains durable links without duplicating stored task input', async () => {
  const { managedWorkerInput } = await import('../dist/reconciler.js');
  const t=task('prompt-context'); t.executionId='prompt-execution'; t.adapter='chatgpt'; t.projectName='agents-relay'; t.parentTaskId='parent'; t.taskUrl='https://github.com/lalalic/agents-relay/pull/7#issuecomment-5754690474'; t.input='implement the change'; t.output={kind:'task_pr'};
  const root=job([t]); root.prNumber=7; root.repository='lalalic/agents-relay';
  const input=await managedWorkerInput(root,t);
  assert.match(input,/Job URL: https:\/\/github\.com\/lalalic\/agents-relay\/pull\/7/);
  assert.match(input,/Job ID: j/);
  assert.match(input,/Task URL: https:\/\/github\.com\/lalalic\/agents-relay\/pull\/7#issuecomment-5754690474/);
  assert.match(input,/Task ID: prompt-context/);
  assert.match(input,/Project: agents-relay/);
  assert.doesNotMatch(input,/implement the change/); assert.match(input,/\[Output contract\]/); assert.match(input,/task\/PR/); assert.match(input,/\[Execution event contract — mandatory\]/); assert.match(input,/FIRST execution action/); assert.match(input,/task\.started/); assert.match(input,/MUST publish exactly one canonical terminal event/); assert.match(input,/publish task\.failed with the concrete reason BEFORE exiting/); assert.match(input,/Never exit after task\.started without publishing exactly one terminal task event/); assert.match(input,/\[Final event gate\]/);
  assert.equal(t.input,'implement the change');
});

test('local projected reviewer input exposes external PR while keeping local lifecycle authority', async () => {
  const { managedWorkerInput } = await import('../dist/reconciler.js');
  const t=task('local-reviewer'); t.executionId='review-execution'; t.adapter='chatgpt'; t.projectName='agents-relay'; t.agentName='reviewer'; t.input='Review PR #17 at exactly head SHA abc123.'; t.output={kind:'task_pr'};
  const root=job([t]); root.prNumber=17; root.localMerge={sourceRef:'refs/heads/local-review',targetRef:'refs/heads/main',status:'pending'}; root.repository='lalalic/agents-relay';
  const input=await managedWorkerInput(root,t);
  assert.match(input,/Job: local j \(lifecycle authority\)/);
  assert.match(input,/Projected GitHub PR: https:\/\/github\.com\/lalalic\/agents-relay\/pull\/17/);
  assert.match(input,/local SQLite Job is the lifecycle authority/);
  assert.match(input,/Review the projected PR at https:\/\/github\.com\/lalalic\/agents-relay\/pull\/17/);
  assert.match(input,/Review PR #17 at exactly head SHA abc123/);
  assert.match(input,/Projected PR: https:\/\/github\.com\/lalalic\/agents-relay\/pull\/17/);
  assert.doesNotMatch(input,/do not query GitHub/);
});

test('local model worker input includes authoritative task input and event contract', async () => {
  const { managedWorkerInput } = await import('../dist/reconciler.js');
  const t=task('local-worker'); t.executionId='local-execution'; t.adapter='codex'; t.projectName='agents-relay'; t.input='local durable work contract'; t.output={kind:'task_pr'};
  const root=job([t]); root.prNumber=0; root.localMerge={sourceRef:'refs/heads/local-worker',targetRef:'refs/heads/main',status:'pending'}; root.repository='lalalic/agents-relay';
  const input=await managedWorkerInput(root,t);
  assert.match(input,/\[Agents Relay managed task\]/);
  assert.match(input,/Job: local j/);
  assert.match(input,/Task URL: local:j\/task\/local-worker/);
  assert.match(input,/Treat the following durable task input as the authoritative work contract; do not query GitHub\./);
  assert.match(input,/local durable work contract/);
  assert.match(input,/\[Execution event contract — mandatory\]/);
  assert.match(input,/Your exact event source identity is: job\/j\/task\/local-worker\/execution\/local-execution/);
  assert.doesNotMatch(input,/Retrieve the durable job and task from GitHub/);
  assert.equal(t.input,'local durable work contract');
});

test('ChatGPT tasks do not carry durable resumable thread lifecycle', () => {
  const t=task('chat'); t.adapter='chatgpt'; t.threadId=null;
  assert.equal(t.threadId,null);
  assert.equal(t.output.kind,'task_pr');
});

test('merged zero-task PR remains local ACTIVE without implementation completion', async () => {
  const root=job([]); const store=new InMemoryStore(root); store.pullRequestState=async()=> 'MERGED';
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()]});
  const result=await reconciler.reconcile('j');
  assert.equal(result.state,'ACTIVE');
});

test('MERGED PR cannot change locally recorded failure, blocked or cancelled state', async () => {
  for (const state of ['FAILED','BLOCKED','CANCELLED']) {
    const root={...job([]),state};
    const store=new InMemoryStore(root);
    store.pullRequestState=async()=> 'MERGED';
    const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()]});
    const result=await reconciler.reconcile('j');
    assert.equal(result.state,state, state);
  }
});

test('dependent planned reviewer freezes latest PR head only at execution', async () => {
  const implementation = task('implement', 'SUCCEEDED');
  const review = {
    ...task('review', 'QUEUED', ['implement']), agentName: 'reviewer',
    planningDecisionId: 'plan-7', reviewHeadSha: 'stale-planning-head',
  };
  const store = new InMemoryStore({ ...job([implementation, review]), headSha: 'new-head' });
  store.pullRequestHead = async () => ({ ref: 'e2e-fix', sha: 'new-head' });
  await bindPlannedReviewHead(store, review, 'new-head');
  const persisted = (await store.load('j')).tasks.find(item => item.id === 'review');
  assert.equal(persisted.reviewHeadSha, 'new-head');
  assert.equal(persisted.state, 'QUEUED');
  assert.equal(persisted.attempt, 0);
});

test('completed jobs create one SHA-bound reviewer task and suppress duplicates', async () => {
  const work = task('work', 'SUCCEEDED');
  const reviewJob = { ...job([work]), headSha: 'sha-review-1' };
  const store = new InMemoryStore(reviewJob);
  const bus = new MemoryEventBus();
  const adapter = new FakeAdapter();
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [adapter], eventBus: bus, maxConcurrent: 0, reviewer: { adapter: 'chatgpt', routing: { provider: 'chatgpt', model: 'account-defaults', decidedBy: 'test', decidedAt: now() } } });
  await reconciler.reconcile('j');
  let saved = await store.load('j');
  assert.equal(saved.tasks.filter(item => item.agentName === 'reviewer').length, 1);
  const reviewer = saved.tasks.find(item => item.agentName === 'reviewer');
  assert.equal(reviewer?.reviewHeadSha, 'sha-review-1');
  assert.equal(reviewer?.adapter, 'chatgpt');
  assert.equal(reviewer?.routing?.provider, 'chatgpt');
  assert.equal(reviewer?.routing?.model, 'account-defaults');
  assert.equal(reviewer?.routing?.decidedBy, 'execution-router:fallback');
  assert.equal(reviewer?.routing?.decisionEvidence?.fallback, true);
  assert.match(reviewer?.input ?? '', /Review PR #1 at exactly head SHA sha-review-1\./);
  assert.match(reviewer?.input ?? '', /Review PR #1 at exactly head SHA sha-review-1/);
  assert.match(reviewer?.input ?? '', /PRE-MERGE artifact approval gate/);
  assert.match(reviewer?.input ?? '', /Do not block approval because automatic merge/);
  assert.doesNotMatch(reviewer?.input ?? '', /review\.started|review\.approved|task\.completed/);

  await reconciler.reconcile('j');
  saved = await store.load('j');
  assert.equal(saved.tasks.filter(item => item.agentName === 'reviewer').length, 1);
});

test('review thread metadata persists and resolves reviewer, creator, then CLI override', async () => {
  const { resolveReviewerThreadDestination } = await import('../dist/reviewer-thread.js');
  assert.deepEqual(resolveReviewerThreadDestination({ reviewerThreadId: 'reviewer', creatorThreadId: 'creator' }), {
    threadId: 'reviewer', source: 'reviewer',
  });
  assert.deepEqual(resolveReviewerThreadDestination({ reviewerThreadId: undefined, creatorThreadId: 'creator' }), {
    threadId: 'creator', source: 'creator',
  });
  assert.deepEqual(resolveReviewerThreadDestination({ reviewerThreadId: 'reviewer', creatorThreadId: 'creator' }, ' override '), {
    threadId: 'override', source: 'override',
  });
  assert.equal(resolveReviewerThreadDestination({}), null);
  assert.throws(() => resolveReviewerThreadDestination({ reviewerThreadId: ' ' }), /reviewer thread ID/);
  const { reviewRequestThreadOverride } = await import('../dist/cli-review.js');
  assert.equal(reviewRequestThreadOverride([]), undefined);
  assert.equal(reviewRequestThreadOverride(['--thread-id', ' override ']), 'override');
  assert.throws(() => reviewRequestThreadOverride(['--thread-id']), /--thread-id/);
  assert.throws(() => reviewRequestThreadOverride(['--thread-id', ' ']), /--thread-id/);
  assert.equal(resolveReviewerThreadDestination({ reviewerThreadId: 'reviewer', creatorThreadId: 'creator' }, reviewRequestThreadOverride([])).source, 'reviewer');
  assert.equal(resolveReviewerThreadDestination({ creatorThreadId: 'creator' }, reviewRequestThreadOverride([])).source, 'creator');
  assert.equal(resolveReviewerThreadDestination({}, reviewRequestThreadOverride([])), null);
  assert.equal(runtimeReviewer(['--thread-id', ' override ']).threadId, 'override');
  assert.throws(() => runtimeReviewer(['--thread-id', ' ']), /--thread-id/);
});

test('thread-bound final review uses the selected durable thread and records delivery', async () => {
  const work = task('work', 'SUCCEEDED');
  const reviewJob = { ...job([work]), prNumber: 16, headSha: 'sha-threaded', creatorThreadId: 'creator-thread' };
  const store = new InMemoryStore(reviewJob);
  const bus = new MemoryEventBus();
  const adapter = new FakeAdapter();
  const reviewer = { adapter: 'chatgpt', routing: { provider: 'chatgpt', model: 'account-defaults', decidedBy: 'test', decidedAt: now() } };
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [adapter], eventBus: bus, maxConcurrent: 0, reviewer });
  await reconciler.reconcile('j');
  const reviewerTask = (await store.load('j')).tasks.find(item => item.agentName === 'reviewer');
  assert.equal(reviewerTask?.adapter, 'chatgpt');
  assert.equal(reviewerTask?.chatgptThreadDelivery?.threadId, 'creator-thread');
  assert.equal(reviewerTask?.chatgptThreadDelivery?.threadSource, 'creator');
  assert.equal(reviewerTask?.chatgptThreadDelivery?.reviewHeadSha, 'sha-threaded');
  assert.equal(reviewerTask?.chatgptThreadDelivery?.prNumber, 16);
  assert.equal(reviewerTask?.chatgptThreadDelivery?.requestId, 'j:final-review-sha-threaded:sha-threaded');
  assert.match(reviewerTask?.input ?? '', /Job ID: j/);
  assert.match(reviewerTask?.input ?? '', /Review head SHA: sha-threaded/);
  assert.match(reviewerTask?.input ?? '', /Review PR #16 at exactly head SHA sha-threaded/);
});

test('review thread override wins over durable metadata', async () => {
  const work = task('work', 'SUCCEEDED');
  const reviewJob = { ...job([work]), headSha: 'sha-override', reviewerThreadId: 'reviewer-thread', creatorThreadId: 'creator-thread' };
  const store = new InMemoryStore(reviewJob);
  const adapter = new FakeAdapter();
  const reconciler = managedReconciler(store, {
    owner: 'test', adapters: [adapter], maxConcurrent: 0,
    reviewer: { threadId: 'override-thread', adapter: 'chatgpt', routing: { provider: 'chatgpt', model: 'account-defaults', decidedBy: 'test', decidedAt: now() } },
  });
  await reconciler.reconcile('j');
  const reviewerTask = (await store.load('j')).tasks.find(item => item.agentName === 'reviewer');
  assert.equal(reviewerTask?.chatgptThreadDelivery?.threadId, 'override-thread');
  assert.equal(reviewerTask?.chatgptThreadDelivery?.threadSource, 'override');
});

test('final review created after the first dispatch pass is dispatched in the same reconcile', async () => {
  const contextRoot = await mkdtemp(join(tmpdir(), 'agents-relay-review-dispatch-context-'));
  await mkdir(join(contextRoot, 'agents'));
  await writeFile(join(contextRoot, 'agents', 'reviewer.agent.md'), '---\nname: reviewer\n---\nReview the managed task.\n');
  const work = task('work', 'RUNNING');
  const store = new InMemoryStore({ ...job([work]), headSha: 'sha-late-review' });
  const bus = new MemoryEventBus();
  const adapter = new FakeAdapter();
  const reconciler = managedReconciler(store, {
    owner: 'test', adapters: [adapter], eventBus: bus, maxConcurrent: 1,
    executionContextRoots: { globalRoot: contextRoot, neoRoot: null },
  });
  const originalEnsureFinalReview = reconciler.ensureFinalReview.bind(reconciler);
  let reviewChecks = 0;
  reconciler.ensureFinalReview = async (...args) => {
    reviewChecks += 1;
    if (reviewChecks === 2) {
      const current = await store.load('j');
      const currentWork = current.tasks.find(item => item.id === 'work');
      currentWork.state = 'SUCCEEDED';
      currentWork.executionId = null;
      currentWork.leaseOwner = null;
      currentWork.leaseExpiresAt = null;
      await store.saveTask(currentWork);
      args[0] = await store.load('j');
    }
    return originalEnsureFinalReview(...args);
  };

  await reconciler.reconcile('j');
  const saved = await store.load('j');
  const reviewer = saved.tasks.find(item => item.agentName === 'reviewer');
  assert.ok(reviewer);
  assert.equal(adapter.launches, 1);
  assert.equal(reviewer.attempt, 1);
  assert.ok(reviewer.executionId);

  await reconciler.reconcile('j');
  assert.equal((await store.load('j')).tasks.filter(item => item.agentName === 'reviewer').length, 1);
  assert.equal(adapter.launches, 1);
  await rm(contextRoot, { recursive: true, force: true });
});

test('cancelled same-head review creates a versioned review round instead of conflicting', async () => {
  const work=task('work','SUCCEEDED');
  const base='final-review-sha-review-r';
  const old={...task(base,'CANCELLED'),agentName:'reviewer',reviewHeadSha:'sha-review-round',error:'Cancelled by user',dependencies:['work']};
  const reviewJob={...job([work,old]),headSha:'sha-review-round',review:{outcome:'pending',headSha:'sha-review-round',taskId:old.id,evidence:null,updatedAt:now()}};
  const store=new InMemoryStore(reviewJob);
  store.pullRequestState=async()=> 'OPEN';
  store.headSha=async()=> 'sha-review-round';
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:new MemoryEventBus(),maxConcurrent:0});
  await reconciler.reconcile('j');
  let saved=await store.load('j');
  let rounds=saved.tasks.filter(item=>item.agentName==='reviewer'&&item.reviewHeadSha==='sha-review-round');
  assert.equal(rounds.length,2);
  assert.equal(rounds[1].id,base+'-r2');
  assert.equal(saved.review?.taskId,base+'-r2');
  await reconciler.reconcile('j');
  saved=await store.load('j');
  rounds=saved.tasks.filter(item=>item.agentName==='reviewer'&&item.reviewHeadSha==='sha-review-round');
  assert.equal(rounds.length,2);
});
test('reconcile ignores remote head and does not request GitHub merge after local approval', async () => {
  const oldHead = 'old-head-before-push';
  const newHead = 'new-head-after-push';
  const work = task('work', 'SUCCEEDED');
  const store = new InMemoryStore({ ...job([work]), headSha: oldHead });
  store.pullRequestState = async () => 'OPEN';
  store.headSha = async () => { throw new Error('remote head must not be read'); };
  let mergedHead = null;
  store.mergePullRequest = async headSha => { mergedHead = headSha; };
  const reconciler = managedReconciler(store, {
    owner: 'test',
    adapters: [new FakeAdapter()],
    eventBus: new MemoryEventBus(),
    maxConcurrent: 0,
  });

  await reconciler.reconcile('j');
  const afterReview = await store.load('j');
  const reviewer = afterReview.tasks.find(item => item.agentName === 'reviewer');
  assert.ok(reviewer);
  assert.equal(afterReview.headSha, oldHead);
  assert.equal(reviewer.reviewHeadSha, oldHead);

  await reconciler.handleEvent(eventFor('j', reviewer.id, null, 'review.approved', 'succeeded', 'approved', 'orchestrator', {
    review: { headSha: oldHead, summary: 'approved', blockingFindings: [] },
  }));
  const completed = await store.load('j');
  assert.equal(completed.review?.outcome, 'approved');
  assert.equal(completed.tasks.find(item => item.id === reviewer.id)?.state, 'SUCCEEDED');
  assert.equal(mergedHead, null);
});

test('autonomous in-progress batch advances planner without creating final review', async () => {
  const planner=task('plan-1','SUCCEEDED'); planner.kind='planner'; planner.agentName='planner'; planner.plannerResult={objective_status:'in_progress',assessment:'continue',next_tasks:[],unblocks:[]};
  const work=task('work','SUCCEEDED'); work.planningDecisionId='plan-1'; work.planningSource='model-planner';
  const root={...job([planner,work]),executionMode:'autonomous',state:'ACTIVE',headSha:'sha-autonomous-in-progress'};
  const store=new InMemoryStore(root); store.pullRequestState=async()=> 'OPEN'; store.headSha=async()=> 'sha-autonomous-in-progress';
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:new MemoryEventBus(),maxConcurrent:0});
  await reconciler.reconcile('j');
  const saved=await store.load('j');
  assert.equal(saved.tasks.some(item=>item.agentName==='reviewer'),false);
  assert.equal(saved.tasks.filter(item=>item.kind==='planner').length,1); // legacy history remains read-only
  assert.equal(saved.plans?.some(item=>item.id==='plan-2'),true);
});

test('autonomous satisfied objective ignores failed troubleshooter history for final review', async () => {
  const planner=task('plan-1','SUCCEEDED'); planner.kind='planner'; planner.agentName='planner'; planner.plannerResult={objective_status:'satisfied',assessment:'done',next_tasks:[],unblocks:[]};
  const work=task('work','SUCCEEDED'); work.planningDecisionId='plan-1'; work.planningSource='model-planner';
  const recovery=task('troubleshoot-old','FAILED'); recovery.agentName='troubleshooter'; recovery.error='historical timeout';
  const root={...job([planner,work,recovery]),executionMode:'autonomous',state:'ACTIVE',headSha:'sha-recovered'};
  const store=new InMemoryStore(root); store.pullRequestState=async()=> 'OPEN'; store.headSha=async()=> 'sha-recovered';
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:new MemoryEventBus(),maxConcurrent:0});
  await reconciler.reconcile('j');
  const saved=await store.load('j');
  assert.equal(saved.tasks.filter(item=>item.agentName==='reviewer').length,1);
});

test('autonomous satisfied objective still blocks final review on failed implementation', async () => {
  const planner=task('plan-1','SUCCEEDED'); planner.kind='planner'; planner.agentName='planner'; planner.plannerResult={objective_status:'satisfied',assessment:'done',next_tasks:[],unblocks:[]};
  const work=task('work','FAILED'); work.planningDecisionId='plan-1'; work.planningSource='model-planner'; work.error='real failure';
  const root={...job([planner,work]),executionMode:'autonomous',state:'ACTIVE',headSha:'sha-failed-work'};
  const store=new InMemoryStore(root); store.pullRequestState=async()=> 'OPEN'; store.headSha=async()=> 'sha-failed-work';
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:new MemoryEventBus(),maxConcurrent:0});
  await reconciler.reconcile('j');
  const saved=await store.load('j');
  assert.equal(saved.tasks.some(item=>item.agentName==='reviewer'),false);
});

test('autonomous satisfied objective allows one final review', async () => {
  const planner=task('plan-1','SUCCEEDED'); planner.kind='planner'; planner.agentName='planner'; planner.plannerResult={objective_status:'satisfied',assessment:'done',next_tasks:[],unblocks:[]};
  const work=task('work','SUCCEEDED'); work.planningDecisionId='plan-1'; work.planningSource='model-planner';
  const root={...job([planner,work]),executionMode:'autonomous',state:'ACTIVE',headSha:'sha-autonomous-done'};
  const store=new InMemoryStore(root); store.pullRequestState=async()=> 'OPEN'; store.headSha=async()=> 'sha-autonomous-done';
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:new MemoryEventBus(),maxConcurrent:0});
  await reconciler.reconcile('j');
  const saved=await store.load('j');
  assert.equal(saved.tasks.filter(item=>item.agentName==='reviewer').length,1);
  assert.equal(saved.tasks.find(item=>item.agentName==='reviewer')?.reviewHeadSha,'sha-autonomous-done');
});

test('no-review jobs stay ACTIVE and become merge-pending without creating a reviewer task', async () => {
  const work=task('work','SUCCEEDED');
  const root={...job([work]),executionMode:'fixed',state:'ACTIVE',headSha:'sha-no-review',reviewEnabled:false};
  const store=new InMemoryStore(root); store.pullRequestState=async()=> 'OPEN'; store.headSha=async()=> 'sha-no-review';
  const reconciler=managedReconciler(store,{owner:'test',adapters:[]});
  await reconciler.reconcile('j');
  const saved=await store.load('j');
  assert.equal(saved.state,'ACTIVE');
  assert.equal(deriveJobRuntimeStatus(saved,'OPEN'),'MERGE_PENDING');
  assert.equal(saved.review,undefined);
  assert.equal(saved.tasks.some(item=>item.agentName==='reviewer'),false);
});

test('CLI init persists no-review independently from auto-merge', async () => {
  const directory=await mkdtemp(join(tmpdir(),'agents-relay-no-review-')); const file=join(directory,'job.json');
  const result=spawn(process.execPath,[join('dist','cli.js'),'init','--file',file,'--id','no-review','--no-review'],{cwd:process.cwd()});
  const [code]=await once(result,'exit'); assert.equal(code,0);
  const saved=JSON.parse(await readFile(file,'utf8'));
  assert.equal(saved.reviewEnabled,false);
  assert.equal(saved.autoMerge,true);
  await rm(directory,{recursive:true,force:true});
});

test('review changes-required creates one routable implementation fix task containing all findings', async () => {
  const reviewJob={...job([task('work','SUCCEEDED')]),headSha:'sha-fix-12345678'};
  const store=new InMemoryStore(reviewJob); const events=[];
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:new MemoryEventBus(),maxConcurrent:0,emit:event=>events.push(event)});
  await reconciler.reconcile('j');
  const reviewer=(await store.load('j')).tasks.find(item=>item.agentName==='reviewer');
  assert.ok(reviewer);
  const payload={review:{headSha:'sha-fix-12345678',issues:['first bug','second bug',{summary:'third bug'}]}};
  await reconciler.handleEvent(eventFor('j',reviewer.id,null,'review.changes_required','failed','changes required','orchestrator',payload));
  let saved=await store.load('j');
  const fixes=saved.tasks.filter(item=>item.id.startsWith('review-fix-'));
  assert.equal(fixes.length,1);
  assert.equal(fixes[0].id,'review-fix-sha-fix-');
  assert.equal(fixes[0].agentName,'implementation');
  assert.deepEqual(fixes[0].workerRequirements,{capabilities:[]});
  assert.equal(fixes[0].routing,undefined);
  assert.equal(fixes[0].timeoutMs,0);
  assert.deepEqual(fixes[0].dependencies,[reviewer.id]);
  assert.match(fixes[0].input,/1\. first bug/);
  assert.match(fixes[0].input,/2\. second bug/);
  assert.match(fixes[0].input,/3\. third bug/);
  assert.equal(saved.tasks.find(item=>item.id===reviewer.id)?.state,'SUCCEEDED');
  assert.equal(saved.state,'ACTIVE');
  assert.equal(deriveJobRuntimeStatus(saved,'OPEN'),'QUEUED');
  assert.equal(events.filter(event=>event.type==='review.fix_task_created').length,1);
  await reconciler.handleEvent(eventFor('j',reviewer.id,null,'review.changes_required','failed','duplicate event','orchestrator',payload));
  saved=await store.load('j');
  assert.equal(saved.tasks.filter(item=>item.id.startsWith('review-fix-')).length,1);
});

test('PR 258-shaped local review evidence creates one idempotent fix and rejects malformed evidence', async () => {
  const headSha = '059c84f00c46f15dbc8f52c571c0be435878601c';
  const source = { id: `job/relay-child-process-lifecycle/task/process-lifecycle-final-review/execution/reviewer`, agent: 'reviewer' };
  const store = new InMemoryStore({ ...job([task('work', 'SUCCEEDED')]), headSha });
  Object.defineProperty(store, 'headSha', { value: async () => { throw new Error('remote head unavailable'); } });
  const bus = new MemoryEventBus();
  const emitted = [];
  const unsubscribe = await bus.subscribeAll(async event => emitted.push(event));
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [new FakeAdapter()], eventBus: bus, maxConcurrent: 0 });
  await reconciler.reconcile('j');
  let saved = await store.load('j');
  const reviewer = saved.tasks.find(item => item.agentName === 'reviewer');
  assert.ok(reviewer);
  assert.equal(reviewer.reviewHeadSha, headSha);

  await reconciler.handleEvent(eventFor('j', reviewer.id, null, 'review.changes_required', 'failed', 'missing head', 'orchestrator', {
    outcome: { decision: 'changes_required', blocking_findings: [{ summary: 'must not succeed without SHA identity' }] },
  }, source));
  saved = await store.load('j');
  assert.equal(saved.review?.outcome, 'pending');
  assert.equal(saved.review?.evidence, null);
  assert.equal(saved.tasks.find(item => item.id === reviewer.id)?.state, reviewer.state);
  assert.equal(saved.tasks.filter(item => item.id.startsWith('review-fix-')).length, 0);

  await reconciler.handleEvent(eventFor('j', reviewer.id, null, 'review.changes_required', 'failed', 'changes required', 'orchestrator', {
    outcome: {
      decision: 'changes_required',
      head_sha: headSha,
      blocking_findings: [{
        id: 'F1',
        severity: 'blocking',
        summary: 'Direct child close cancels forced group cleanup while an unref\u0027d descendant can still be alive.',
      }],
    },
  }, source));
  saved = await store.load('j');
  const fixes = saved.tasks.filter(item => item.id.startsWith('review-fix-'));
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].id, 'review-fix-059c84f0');
  assert.equal(fixes[0].parentTaskId, reviewer.id);
  assert.deepEqual(fixes[0].dependencies, [reviewer.id]);
  assert.equal(fixes[0].agentName, 'implementation');
  assert.match(fixes[0].input, /Direct child close cancels forced group cleanup/);
  assert.equal(saved.review?.outcome, 'changes_required');
  assert.equal(saved.review?.headSha, headSha);
  assert.equal(saved.review?.evidence?.data?.source?.id, source.id);
  assert.equal(emitted.filter(event => event.type === 'review.fix_task_created').length, 1);

  await reconciler.handleEvent(eventFor('j', reviewer.id, null, 'review.changes_required', 'failed', 'duplicate event', 'orchestrator', {
    outcome: { decision: 'changes_required', head_sha: headSha, blocking_findings: [{ summary: 'duplicate' }] },
  }, source));
  saved = await store.load('j');
  assert.equal(saved.tasks.filter(item => item.id.startsWith('review-fix-')).length, 1);
  assert.equal(emitted.filter(event => event.type === 'review.fix_task_created').length, 1);
  await unsubscribe();
});

test('planner-created review binds its first authoritative verdict to Job review state', async () => {
  const head = '0123456789abcdef0123456789abcdef01234567';
  const implementation = task('implementation', 'SUCCEEDED');
  const reviewer = { ...task('review-planned', 'RUNNING', ['implementation']), agentName: 'reviewer', planningDecisionId: 'plan-8', reviewHeadSha: head };
  const store = new InMemoryStore({ ...job([implementation, reviewer]), headSha: head, review: null });
  store.headSha = async () => head;
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [new FakeAdapter()], eventBus: new MemoryEventBus(), maxConcurrent: 0 });
  await reconciler.handleEvent(eventFor('j', reviewer.id, null, 'review.changes_required', 'failed', 'Unrequested seed artifact', 'orchestrator', {
    outcome: { head_sha: head, decision: 'changes_required', blocking_findings: [{ summary: 'Remove unrequested seed artifact' }] },
  }));
  const saved = await store.load('j');
  assert.equal(saved.review?.outcome, 'changes_required');
  assert.equal(saved.review?.taskId, reviewer.id);
  assert.equal(saved.review?.headSha, head);
  assert.equal(saved.tasks.find(item => item.id === reviewer.id)?.state, 'SUCCEEDED');
  const fixes = saved.tasks.filter(item => item.id.startsWith('review-fix-'));
  assert.equal(fixes.length, 1);
  assert.match(fixes[0].input, /Remove unrequested seed artifact/);
});

test('planner-created review approval persists locally without requesting remote merge', async () => {
  const head = 'abcdef0123456789abcdef0123456789abcdef01';
  const implementation = task('implementation', 'SUCCEEDED');
  const reviewer = { ...task('review-planned', 'RUNNING', ['implementation']), agentName: 'reviewer', planningDecisionId: 'plan-8', reviewHeadSha: head };
  const store = new InMemoryStore({ ...job([implementation, reviewer]), headSha: head, review: null });
  store.headSha = async () => head;
  let merges = 0;
  store.mergePullRequest = async observedHead => { assert.equal(observedHead, head); merges += 1; };
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [new FakeAdapter()], eventBus: new MemoryEventBus(), maxConcurrent: 0 });
  await reconciler.handleEvent(eventFor('j', reviewer.id, null, 'review.approved', 'succeeded', 'approved', 'orchestrator', {
    outcome: { head_sha: head, decision: 'approved', blocking_findings: [] },
  }));
  const saved = await store.load('j');
  assert.equal(saved.review?.outcome, 'approved');
  assert.equal(saved.review?.headSha, head);
  assert.equal(saved.tasks.find(item => item.id === reviewer.id)?.state, 'SUCCEEDED');
  assert.equal(merges, 0);
});

test('review changes-required falls back to one fix task from the review message', async () => {
  const reviewJob={...job([task('work','SUCCEEDED')]),headSha:'fallback12345678'};
  const store=new InMemoryStore(reviewJob);
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:new MemoryEventBus(),maxConcurrent:0});
  await reconciler.reconcile('j');
  const reviewer=(await store.load('j')).tasks.find(item=>item.agentName==='reviewer'); assert.ok(reviewer);
  await reconciler.handleEvent(eventFor('j',reviewer.id,null,'review.changes_required','failed','fix the race and add coverage','orchestrator',{review:{headSha:'fallback12345678'}}));
  const fixes=(await store.load('j')).tasks.filter(item=>item.id.startsWith('review-fix-'));
  assert.equal(fixes.length,1);
  assert.match(fixes[0].input,/fix the race and add coverage/);
});

test('approved review never calls GitHub merge regardless of autoMerge policy', async () => {
  for (const [autoMerge, expected] of [[undefined,0],[false,0]]) {
    const reviewJob={...job([task('work','SUCCEEDED')]),headSha:'sha-auto',autoMerge};
    const store=new InMemoryStore(reviewJob); let merges=0; let mergedSha=null;
    store.mergePullRequest=async sha=>{ merges+=1; mergedSha=sha; };
    const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:new MemoryEventBus(),maxConcurrent:0});
    await reconciler.reconcile('j');
    const created=(await store.load('j')).tasks.find(item=>item.agentName==='reviewer');
    assert.ok(created);
    await reconciler.handleEvent(eventFor('j',created.id,null,'review.approved','succeeded','approved','orchestrator',{review:{headSha:'sha-auto',summary:'approved',blockingFindings:[]}}));
    assert.equal(merges,expected);
    if (expected) assert.equal(mergedSha,'sha-auto');
  }
});

test('SHA-bound reviewer accepts correlated approval without head SHA in event data', async () => {
  const reviewer=task('final-review-sha-bound','RUNNING');
  reviewer.agentName='reviewer';
  reviewer.adapter='chatgpt';
  reviewer.reviewHeadSha='sha-bound';
  reviewer.executionId='exec-review';
  reviewer.executionHistory=[{id:'exec-review',attempt:1,startedAt:now()}];
  const reviewJob={...job([reviewer]),headSha:'sha-bound',review:{outcome:'pending',headSha:'sha-bound',taskId:reviewer.id,evidence:null,updatedAt:now()}};
  const store=new InMemoryStore(reviewJob);
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeChatGptAdapter()],eventBus:new MemoryEventBus(),maxConcurrent:0});
  await reconciler.handleEvent(eventFor('j',reviewer.id,null,'review.approved','succeeded','approved','user',{},eventSource('j',reviewer.id,'exec-review')));
  const durable=await store.load('j');
  assert.equal(durable.tasks.find(item=>item.id===reviewer.id)?.state,'SUCCEEDED');
  assert.equal(durable.review?.outcome,'approved');
  assert.equal(durable.review?.headSha,'sha-bound');
});

test('review outcomes persist durably and old SHA evidence is ignored after head changes', async () => {
  const reviewJob = { ...job([task('work', 'SUCCEEDED')]), headSha: 'sha-review-1' };
  const store = new InMemoryStore(reviewJob);
  const bus = new MemoryEventBus();
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [new FakeAdapter()], eventBus: bus, maxConcurrent: 0 });
  await reconciler.reconcile('j');
  const created = (await store.load('j')).tasks.find(item => item.agentName === 'reviewer');
  assert.ok(created);
  await reconciler.handleEvent(eventFor('j', created.id, null, 'review.started', 'running', 'started', 'orchestrator', { review: { headSha: 'sha-review-1', summary: 'gates passed', evidence: ['tests'] } }));
  assert.equal((await store.load('j')).review?.outcome, 'started');
  assert.equal((await store.load('j')).tasks.find(item => item.id === created.id)?.state, 'RUNNING');
  await reconciler.handleEvent(eventFor('j', created.id, null, 'review.approved', 'succeeded', 'approved', 'orchestrator', { review: { headSha: 'sha-review-1', summary: 'approved', blockingFindings: [], evidence: ['tests'] } }));
  assert.equal((await store.load('j')).review?.outcome, 'approved');
  assert.equal((await store.load('j')).review?.evidence?.data?.review?.summary, 'approved');
  assert.equal((await store.load('j')).tasks.find(item => item.id === created.id)?.state, 'SUCCEEDED');
  const changed = await store.load('j');
  changed.headSha = 'sha-review-2';
  await store.saveJob(changed);
  await reconciler.handleEvent(eventFor('j', created.id, null, 'review.approved', 'succeeded', 'stale approval', 'orchestrator', { headSha: 'sha-review-1' }));
  assert.equal((await store.load('j')).review?.headSha, 'sha-review-1');
  assert.equal((await store.load('j')).tasks.filter(item => item.id.startsWith('review-fix-')).length, 0);
  // The review event may already have started an event-driven reconcile.
  // Wait for that pass before asserting on the next local head generation.
  const deadline = Date.now() + 1000;
  while (reconciler.reconciling) {
    if (Date.now() > deadline) throw new Error('review reconcile did not drain');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  await reconciler.reconcile('j');
  const refreshed = await store.load('j');
  assert.equal(refreshed.review?.headSha, 'sha-review-2');
  assert.equal(refreshed.tasks.filter(item => item.agentName === 'reviewer').length, 2);
});


test('legacy blocked review becomes failed Reviewer with Troubleshooter recovery', async () => {
  const reviewJob={...job([task('work','SUCCEEDED')]),headSha:'sha-blocked'};
  const store=new InMemoryStore(reviewJob);
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:new MemoryEventBus(),maxConcurrent:1});
  await reconciler.reconcile('j');
  const reviewer=(await store.load('j')).tasks.find(item=>item.agentName==='reviewer');
  assert.ok(reviewer);
  const source=await activeEventSource(store,reviewer.id);
  assert.equal((await reconciler.applyEvent(eventFor('j',reviewer.id,null,'task.started','running','review started','user',{},source))).applied,true);
  const result=await reconciler.applyEvent(eventFor('j',reviewer.id,null,'review.blocked','blocked','missing build toolchain','user',{review:{headSha:'sha-blocked'}},source));
  assert.equal(result.applied,true);
  const saved=await store.load('j');
  assert.equal(saved.tasks.find(item=>item.id===reviewer.id)?.state,'FAILED');
  const {pendingTroubleshooterTasks}=await import('../dist/troubleshooter.js');
  assert.equal(pendingTroubleshooterTasks(saved).some(item=>item.parentTaskId===reviewer.id),true);
  await reconciler.close();
});

test('projected PR stale head delays final review until projection catches up', async () => {
  const implementation=task('implementation','SUCCEEDED');
  const root={...job([implementation]),headSha:'sha-current',prNumber:99,localMerge:{sourceRef:'refs/heads/e2e-test',targetRef:'refs/heads/main',status:'pending'}};
  const store=new InMemoryStore(root);
  let projected='sha-bootstrap';
  store.pullRequestHead=async()=>({ref:'e2e/test',sha:projected});
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:new MemoryEventBus(),maxConcurrent:0});
  await reconciler.reconcile('j');
  assert.equal((await store.load('j')).tasks.some(item=>item.agentName==='reviewer'),false);
  projected='sha-current';
  await reconciler.reconcile('j');
  const durable=await store.load('j');
  const reviewer=durable.tasks.find(item=>item.agentName==='reviewer');
  assert.ok(reviewer);
  assert.equal(reviewer.reviewHeadSha,'sha-current');
  await reconciler.close();
});

test('bootstrap-only remote branch uses force-with-lease for authoritative projection', async () => {
  const { authoritativeBranchPushArgs } = await import('../dist/github-branch-projection.js');
  assert.deepEqual(authoritativeBranchPushArgs({sourceRef:'refs/heads/e2e/job',branch:'e2e/job',remoteHeadSha:'bootstrap-sha',remoteTreeMatchesBase:true}),[
    'push','origin','--force-with-lease=refs/heads/e2e/job:bootstrap-sha','refs/heads/e2e/job:refs/heads/e2e/job'
  ]);
  assert.deepEqual(authoritativeBranchPushArgs({sourceRef:'refs/heads/e2e/job',branch:'e2e/job',remoteHeadSha:'real-work',remoteTreeMatchesBase:false}),[
    'push','origin','refs/heads/e2e/job:refs/heads/e2e/job'
  ]);
});

test('approved reviewer remains SUCCEEDED while external MERGED PR cannot terminate Job', async () => {
  const reviewJob={...job([task('work','SUCCEEDED')]),headSha:'sha-merged-review',autoMerge:false};
  const store=new InMemoryStore(reviewJob); store.pullRequestState=async()=> 'OPEN'; store.headSha=async()=> 'sha-merged-review';
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:new MemoryEventBus(),maxConcurrent:0});
  await reconciler.reconcile('j');
  const reviewer=(await store.load('j')).tasks.find(item=>item.agentName==='reviewer');
  assert.ok(reviewer);
  await reconciler.handleEvent(eventFor('j',reviewer.id,null,'review.started','running','started','orchestrator',{review:{headSha:'sha-merged-review'}}));
  await reconciler.handleEvent(eventFor('j',reviewer.id,null,'review.approved','succeeded','approved','orchestrator',{review:{headSha:'sha-merged-review'}}));
  assert.equal((await store.load('j')).tasks.find(item=>item.id===reviewer.id)?.state,'SUCCEEDED');
  store.pullRequestState=async()=> 'MERGED';
  const merged=await reconciler.reconcile('j');
  assert.equal(merged.state,'ACTIVE');
  assert.equal(merged.tasks.find(item=>item.id===reviewer.id)?.state,'SUCCEEDED');
  assert.equal(merged.tasks.find(item=>item.id===reviewer.id)?.error,null);
});

test('open zero-task jobs remain create-only and do not consume reconciliation capacity', () => {
  const root = {...job([]),state:'DRAFT'};
  assert.equal(root.state, 'DRAFT');
  assert.equal(needsLifecycleReconciliation(root), false);
  assert.deepEqual(root.tasks, []);
  assert.match(dashboardHtml, /Lifecycle state/);
  assert.match(dashboardHtml, /Runtime status/);
});

test('external MERGED PR does not cancel a locally RUNNING Task', async () => {
  const t=task('running-on-merge','RUNNING'); t.executionId='run-merge'; t.leaseOwner='worker'; t.leaseExpiresAt=new Date(Date.now()+60000).toISOString();
  const store=new InMemoryStore(job([t])); store.pullRequestState=async()=> 'MERGED';
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()]});
  const result=await reconciler.reconcile('j');
  const durable=result.tasks.find(item=>item.id===t.id);
  assert.equal(result.state,'ACTIVE');
  assert.equal(durable.state,'RUNNING');
  assert.equal(durable.error,null);
});

test('external CLOSED PR cannot cancel locally queued work', async () => {
  const t=task('closed-queued'); const store=new InMemoryStore(job([t])); store.pullRequestState=async()=> 'CLOSED'; const adapter=new FakeAdapter();
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:new MemoryEventBus(),maxConcurrent:0}); const result=await reconciler.reconcile('j');
  assert.equal(result.state,'ACTIVE'); assert.equal(result.tasks[0].state,'QUEUED'); assert.equal(result.tasks[0].error,null); assert.equal(adapter.launches,0);
});

test('reconciler durably persists Graph dependency release transitions', async () => {
  const dep=task('dep','SUCCEEDED');
  const child=task('child','DRAFT',['dep']);
  const store=new InMemoryStore(job([dep,child]));
  const reconciler=managedReconciler(store,{owner:'test',adapters:[],maxConcurrent:0});
  await reconciler.reconcile('j');
  assert.equal((await store.load('j')).tasks.find(item=>item.id==='child').state,'QUEUED');
});

test('concurrent reconciler instances atomically claim one queued task only once', async () => {
  const t=task('atomic-launch');
  const store=new InMemoryStore(job([t]));
  const bus=new MemoryEventBus();
  const adapter=new FakeAdapter();
  const a=managedReconciler(store,{owner:'test-a',adapters:[adapter],eventBus:bus});
  const b=managedReconciler(store,{owner:'test-b',adapters:[adapter],eventBus:bus});
  await Promise.all([a.reconcile('j'),b.reconcile('j')]);
  const durable=(await store.load('j')).tasks.find(item=>item.id==='atomic-launch');
  assert.equal(adapter.launches,1);
  assert.equal(durable.state,'QUEUED');
  assert.equal(durable.attempt,1);
  assert.ok(durable.executionId);
  const source=eventSource('j',durable.id,durable.executionId);
  await a.handleEvent(eventFor('j',durable.id,null,'task.started','running','worker began','user',undefined,source));
  await a.handleEvent(eventFor('j',durable.id,null,'task.completed','succeeded','worker completed','user',undefined,source));
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await store.load('j')).tasks.find(item=>item.id==='atomic-launch').state,'SUCCEEDED');
});

test('concurrent reconciler instances route one queued generation only once', async () => {
  const t=task('atomic-route');
  t.routing=undefined;
  t.workerRequirements={capabilities:[]};
  const store=new InMemoryStore(job([t]));
  const bus=new MemoryEventBus();
  const events=[];
  const stopEvents=await bus.subscribe('j',async event=>events.push(event));
  const adapter=new FakeAdapter();
  const a=managedReconciler(store,{owner:'test-a',adapters:[adapter],eventBus:bus});
  const b=managedReconciler(store,{owner:'test-b',adapters:[adapter],eventBus:bus});
  await Promise.all([a.reconcile('j'),b.reconcile('j')]);
  const durable=(await store.load('j')).tasks.find(item=>item.id==='atomic-route');
  assert.equal(events.filter(event=>event.type==='worker.selected').length,1);
  assert.equal(events.filter(event=>event.type==='model.selected').length,1);
  assert.ok(durable.workerSelection);
  await a.close(); await b.close(); await stopEvents();
});

test('unrouted model task is routed and claimed in the same execution reconcile', async () => {
  const t=task('route-at-claim');
  t.routing=undefined;
  t.workerRequirements={capabilities:[]};
  const store=new InMemoryStore(job([t]));
  const bus=new MemoryEventBus();
  const adapter=new FakeAdapter();
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
  await reconciler.reconcile('j');
  const durable=(await store.load('j')).tasks[0];
  assert.equal(adapter.launches,1);
  assert.equal(durable.attempt,1);
  assert.ok(durable.executionId);
  assert.ok(durable.routing);
  assert.ok(durable.workerSelection);
  await reconciler.close();
});

test('routing failure leaves execution generation unclaimed', async () => {
  const t=task('route-failure');
  t.routing=undefined;
  t.workerRequirements={capabilities:[]};
  const store=new InMemoryStore(job([t]));
  const reconciler=managedReconciler(store,{owner:'test',adapters:[],eventBus:new MemoryEventBus()});
  await reconciler.reconcile('j');
  const durable=(await store.load('j')).tasks[0];
  assert.equal(durable.attempt,0);
  assert.equal(durable.executionId,null);
  assert.equal(durable.routing,undefined);
  assert.equal(durable.state,'FAILED');
  assert.match(durable.error ?? '',/No executable worker\+model route/);
  await reconciler.close();
});

test('concurrent terminal reconciliation commits one execution generation', async () => {
  const t=task('atomic-terminal','RUNNING');
  t.executionId='atomic-terminal-execution';
  t.leaseOwner='test';
  t.leaseExpiresAt=new Date(Date.now()+60000).toISOString();
  const store=new InMemoryStore(job([t]));
  const a=managedReconciler(store,{owner:'test-a',adapters:[]});
  const b=managedReconciler(store,{owner:'test-b',adapters:[]});
  const terminal=eventFor('j',t.id,null,'task.completed','succeeded','durable output','user',undefined,eventSource('j',t.id,t.executionId));
  await Promise.all([a.handleEvent(terminal),b.handleEvent(terminal)]);
  const durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'SUCCEEDED');
  assert.equal(durable.executionId,null);
});

test('terminal fact from a duplicate same-attempt execution wins over its orphan', async () => {
  const t=task('duplicate-terminal','RUNNING');
  t.attempt=1;
  t.executionId='orphan-execution';
  t.leaseOwner='test';
  t.leaseExpiresAt=new Date(Date.now()+60000).toISOString();
  t.executionHistory=[
    {id:'successful-execution',attempt:1,startedAt:'2026-09-29T20:00:00.000Z'},
    {id:'orphan-execution',attempt:1,startedAt:'2026-09-29T20:00:01.000Z'},
  ];
  const store=new InMemoryStore(job([t]));
  const reconciler=managedReconciler(store,{owner:'test',adapters:[]});
  await reconciler.handleEvent({...eventFor('j',t.id,null,'task.completed','succeeded','durable output','user',undefined,eventSource('j',t.id,'successful-execution')),timestamp:'2026-09-29T20:00:02.000Z'});
  const durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'SUCCEEDED');
  assert.equal(durable.executionId,null);
  assert.equal(durable.result?.summary,'durable output');
});

test('GitHub rate limit does not gate SQLite lifecycle reconciliation', async () => {
  const calls = [];
  const client = {
    request: async () => { throw new Error('GitHub offline'); },
    graphql: async () => { throw new Error('GitHub offline'); },
  };
  const root = { ...job([]), id: 'local-rate-limit', prNumber: 44 };
  const inventory = () => [{ job: root, githubState: 'OPEN', draft: false, mergedAt: null, closedAt: null }];
  const pool = localPoolFixture(client, ['owner/repo'], new Set(), 4,
    () => ({ reconcile: async () => { calls.push('reconcile'); } }),
    () => true, undefined, () => new InMemoryStore(root), inventory);
  await pool.reconcile();
  await pool.reconcileTarget('owner/repo', 44, 'local-rate-limit');
  assert.ok(calls.length >= 1, 'SQLite reconciliation must proceed despite GitHub limits');
});
test('CLI task create rejects malformed Agent Graph before persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-agent-graph-invalid-create-'));
  const file = join(directory, 'job.json');
  await writeFile(file, JSON.stringify(job([])));
  const child = spawn(process.execPath, [join('dist','cli.js'),'task','create','--file',file,'--task-id','bad-graph','--output','task-pr','--input','execute graph','--agent-graph','graph LR\na --> b'], {cwd:process.cwd()});
  assert.notEqual(await new Promise(resolve=>child.on('close',resolve)),0);
  const saved=JSON.parse(await readFile(file,'utf8'));
  assert.equal(saved.tasks.length,0);
  await rm(directory,{recursive:true,force:true});
});


test('CLI task update rejects malformed Agent Graph before replacing durable graph', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-agent-graph-invalid-update-'));
  const file = join(directory, 'job.json');
  const existing = task('graph-task', 'QUEUED');
  existing.agentGraph = 'flowchart LR\nreviewer --> planner';
  await writeFile(file, JSON.stringify(job([existing])));
  const child = spawn(process.execPath, [join('dist','cli.js'),'task','update','--file',file,'--task-id','graph-task','--agent-graph','graph LR\nreviewer --> planner'], {cwd:process.cwd()});
  assert.notEqual(await new Promise(resolve=>child.on('close',resolve)),0);
  const saved=JSON.parse(await readFile(file,'utf8'));
  assert.equal(saved.tasks[0].agentGraph,'flowchart LR\nreviewer --> planner');
  await rm(directory,{recursive:true,force:true});
});

test('valid current execution start uses execution identity instead of worker midnight timestamp', async () => {
  const t=task('midnight-start'); t.executionId='current-generation'; t.leaseOwner='relay-owner'; t.attempt=1;
  t.executionHistory=[{id:'current-generation',attempt:1,startedAt:'2026-10-08T10:17:00.000Z'}];
  const store=new InMemoryStore(job([t])); const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()]});
  const oldClock={...eventFor('j',t.id,null,'task.started','running','starting','orchestrator',undefined,eventSource('j',t.id,t.executionId)),timestamp:'2026-10-08T00:00:00.000Z'};
  await reconciler.handleEvent(oldClock);
  const saved=(await store.load('j')).tasks[0];
  assert.equal(saved.state,'RUNNING');
  assert.notEqual(saved.updatedAt,oldClock.timestamp);
});

test('previous execution cannot start current generation despite newer timestamp', async () => {
  const t=task('reject-previous'); t.executionId='generation-two'; t.leaseOwner='relay-owner'; t.attempt=2;
  const store=new InMemoryStore(job([t])); const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()]});
  await reconciler.handleEvent(eventFor('j',t.id,null,'task.started','running','old worker','orchestrator',undefined,eventSource('j',t.id,'generation-one')));
  assert.equal((await store.load('j')).tasks[0].state,'QUEUED');
});

test('same Job dispatches at most one task until the active execution terminates', async () => {
  const store = new InMemoryStore(job([task('first'), task('second')]));
  const adapter = new FakeAdapter();
  const bus = new MemoryEventBus();
  const reconciler = managedReconciler(store, { owner:'serial-job-test', maxConcurrent:4, adapters:[adapter], eventBus:bus });
  const stop = await reconciler.watch('j');
  try {
    await reconciler.reconcile('j');
    assert.equal(adapter.launches, 1);
    await reconciler.reconcile('j');
    assert.equal(adapter.launches, 1, 'a repeated reconcile must not launch another Job task');
    const claimed = (await store.load('j')).tasks.filter(t => t.executionId !== null);
    assert.equal(claimed.length, 1);
    const first = claimed[0];
    const source = await activeEventSource(store, first.id);
    await bus.publish(eventFor('j',first.id,null,'task.started','running','started','user',undefined,source));
    await bus.publish(eventFor('j',first.id,null,'task.completed','succeeded','done','orchestrator',undefined,source));
    const deadline = Date.now() + 2000;
    while (adapter.launches < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      await reconciler.reconcile('j');
    }
    assert.equal(adapter.launches, 2, 'next Job task should run after terminal event');
  } finally { await stop(); await reconciler.close(); }
});

test('separate Jobs each retain one independent execution slot', async () => {
  const firstStore = new InMemoryStore(job([task('first'),task('second')]));
  const secondJob = job([task('other')]);
  secondJob.id='second-job'; secondJob.tasks[0].jobId='second-job';
  const secondStore = new InMemoryStore(secondJob);
  const adapterA = new FakeAdapter();
  const adapterB = new FakeAdapter();
  const bus = new MemoryEventBus();
  const first = managedReconciler(firstStore,{owner:'cross-job-1',maxConcurrent:4,adapters:[adapterA],eventBus:bus});
  const second = managedReconciler(secondStore,{owner:'cross-job-2',maxConcurrent:4,adapters:[adapterB],eventBus:bus});
  try {
    await Promise.all([first.reconcile('j'),second.reconcile('second-job')]);
    assert.equal(adapterA.launches,1);
    assert.equal(adapterB.launches,1);
  } finally { await first.close(); await second.close(); }
});

test('legacy RUNNING orphan repair releases the Job execution slot', async () => {
  const self = task('orchestrator-owned', 'RUNNING');
  self.adapter = 'orchestrator';
  const store = new InMemoryStore(job([self, task('model-worker')]));
  const adapter = new FakeAdapter();
  const reconciler = managedReconciler(store, { owner:'p0-serialized', adapters:[adapter], eventBus:new MemoryEventBus(), maxConcurrent:1 });
  await reconciler.reconcile('j');
  assert.equal(adapter.launches, 1);
});

test('publication Webhook replay retains the same EventBus event identity per Job', async () => {
  const root = job([]); root.prNumber = 83; root.repository = 'owner/repo';
  const bus = new MemoryEventBus();
  const emitted = [];
  await bus.subscribeAll(async event => { emitted.push(event); });
  const pool = localPoolFixture({
    request: async () => { throw new Error('no HTTP expected'); },
    graphql: async () => { throw new Error('no GraphQL expected'); },
  }, ['owner/repo'], new Set(), 1);
  const wake = { deliveryId: 'same-publish-delivery', event: 'issue_comment', action: 'created',
    repository: 'owner/repo', pullRequest: 83, publication: {
      package: 'agents-relay', version: '3.1.0', registry: null, sha: 'abc123',
    }, pullRequestFacts: null };
  await pool.webhookWake(bus, root, wake);
  await pool.webhookWake(bus, root, wake);
  const publications = emitted.filter(event => event.type === 'package.published');
  assert.equal(publications.length, 2);
  assert.equal(publications[0].event_id, publications[1].event_id);
});

test('reviewer runtime recovery preserves exact immutable head and accepts verdict on recovered execution', async () => {
  const implementation=task('implementation','SUCCEEDED');
  const reviewer={...task('review-runtime-failed','FAILED',['implementation']),agentName:'reviewer',reviewHeadSha:'sha-review-recovered',error:'worker_start_timeout',failureReason:'worker_start_timeout',attempt:1,maxAttempts:3,routing:{provider:'openai',model:'gpt-5.6-luna',decidedBy:'test',decidedAt:now()},workerSelection:{workerId:'codex',adapter:'codex',capabilities:['model','codex'],selectedBy:'test',selectedAt:now()}};
  const recovery={...task('troubleshoot-review-runtime-failed-a1','RUNNING'),agentName:'troubleshooter',parentTaskId:reviewer.id,executionId:'recovery-exec',leaseOwner:'relay',error:null};
  const root={...job([implementation,reviewer,recovery]),headSha:'sha-review-recovered',review:{outcome:'pending',headSha:'sha-review-recovered',taskId:reviewer.id,evidence:null,updatedAt:now()}};
  const store=new InMemoryStore(root); store.headSha=async()=> 'sha-review-recovered';
  await dispatchTaskAction(store,{id:'task.recover',jobId:'j',taskId:reviewer.id,recoveryTaskId:recovery.id});
  let durable=await store.load('j');
  let recovered=durable.tasks.find(item=>item.id===reviewer.id);
  assert.equal(recovered.state,'QUEUED');
  assert.equal(recovered.reviewHeadSha,'sha-review-recovered');
  assert.equal(recovered.id,reviewer.id);
  recovery.state='SUCCEEDED'; recovery.executionId=null; recovery.leaseOwner=null; recovery.leaseExpiresAt=null;
  await store.saveTask(recovery);

  durable=await store.load('j'); recovered=durable.tasks.find(item=>item.id===reviewer.id);
  recovered.state='RUNNING'; recovered.executionId='review-recovered-exec'; recovered.leaseOwner='test';
  recovered.leaseExpiresAt=new Date(Date.now()+60000).toISOString(); recovered.attempt+=1;
  await store.saveTask(recovered);

  const bus=new MemoryEventBus();
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:bus,maxConcurrent:1});
  const stop=await reconciler.watch('j');
  const source=eventSource('j',reviewer.id,'review-recovered-exec');
  await bus.publish(eventFor('j',reviewer.id,null,'review.changes_required','failed','same-head review requires change','user',{outcome:{head_sha:'sha-review-recovered',blocking_findings:[{summary:'fix recovered review'}]}},source));
  await new Promise(resolve=>setTimeout(resolve,10));
  durable=await store.load('j'); recovered=durable.tasks.find(item=>item.id===reviewer.id);
  assert.equal(recovered.state,'SUCCEEDED');
  assert.equal(recovered.reviewHeadSha,'sha-review-recovered');
  assert.equal(durable.review?.headSha,'sha-review-recovered');
  assert.equal(durable.review?.outcome,'changes_required');
  assert.equal(durable.tasks.filter(item=>item.id.startsWith('review-fix-')).length,1);
  await stop(); await reconciler.close();
});

test('Planner null-review first verdict persists through atomic store mutation',async()=>{
 for(const verdict of ['review.changes_required','review.approved']){
  const head='planner-review-head-123456789';
  const reviewer={...task('planner-review','RUNNING'),agentName:'reviewer',
   planningDecisionId:'plan-1',reviewHeadSha:head,executionId:'exec-1',
   executionHistory:[{id:'exec-1',attempt:1,startedAt:now()}],
   leaseOwner:'worker',leaseExpiresAt:now(),adapter:'chatgpt'};
  const store=new InMemoryStore({...job([reviewer]),headSha:head,review:null,autoMerge:false});
  store.mutateJob=async(id,mutation)=>{
   const updated=mutation(await store.load(id));
   await store.saveJob(updated);
   for(const item of updated.tasks) await store.saveTask(item);
   return store.load(id);
  };
  const emitted=[];
  const reconciler=managedReconciler(store,{owner:'test',
   adapters:[new FakeChatGptAdapter()],eventBus:new MemoryEventBus(),
   maxConcurrent:0,emit:event=>emitted.push(event)});
  const payload={outcome:{head_sha:head,blocking_findings:[{summary:'fix review issue'}]}};
  const send=(data=payload,exec='exec-1')=>reconciler.handleEvent(
   eventFor('j',reviewer.id,null,verdict,'succeeded','review verdict',
    'orchestrator',data,eventSource('j',reviewer.id,exec)));
  await send(payload,'stale-execution');
  assert.equal((await store.load('j')).review,null);
  await send({outcome:{head_sha:'wrong-head'}});
  assert.equal((await store.load('j')).review,null);
  await send();
  let saved=await store.load('j');
  const completed=saved.tasks.find(item=>item.id===reviewer.id);
  assert.equal(completed.state,'SUCCEEDED');
  assert.equal(completed.executionId,null);
  assert.equal(completed.leaseOwner,null);
  assert.equal(completed.leaseExpiresAt,null);
  assert.equal(completed.executionHistory[0].id,'exec-1');
  const outcome=verdict==='review.approved'?'approved':'changes_required';
  assert.equal(saved.review.outcome,outcome);
  assert.equal(saved.review.headSha,head);
  assert.equal(saved.review.evidence.data.headSha,head);
  const fixes=saved.tasks.filter(item=>item.id.startsWith('review-fix-'));
  assert.equal(fixes.length,verdict==='review.approved'?0:1);
  await send();
  await reconciler.handleEvent(eventFor('j',reviewer.id,null,'task.completed',
    'succeeded','generic completion','orchestrator',{},eventSource('j',reviewer.id,'exec-1')));
  saved=await store.load('j');
  assert.equal(saved.review.outcome,outcome);
  assert.equal(saved.tasks.filter(item=>item.id.startsWith('review-fix-')).length,fixes.length);
  if(fixes.length){
   assert.equal(fixes[0].parentTaskId,reviewer.id);
   assert.equal(emitted.filter(event=>event.type==='review.fix_task_created').length,1);
  }
 }
});

test('daemon inventory wakes an autonomous job with unconsumed unblock', () => {
  const blocked=task('25','BLOCKED');
  const unblocked=task('30','DRAFT');
  unblocked.unblock={event:'task.unblocked',at:now(),source:'cli',reason:'retry',baseline:{blockedAt:now()}};
  const value={...job([blocked,unblocked]),executionMode:'autonomous',plans:[]};
  assert.equal(needsLifecycleReconciliation(value),true);
  value.plans=[{id:'plan-4',status:'SUCCEEDED',trigger:{source:'unblock',taskIds:['30']}}];
  assert.equal(needsLifecycleReconciliation(value),false);
});

test('failed local merge is scheduled for reconciliation when retry is due', () => {
  const now=Date.parse('2026-10-16T21:00:00Z');
  const base={...job([task('work','SUCCEEDED')]),state:'ACTIVE',localMerge:{sourceRef:'refs/heads/task',targetRef:'refs/heads/main',status:'failed',nextAttemptAt:'2026-10-16T20:59:00Z'}};
  assert.equal(needsLifecycleReconciliation(base,now),true);
  assert.equal(needsLifecycleReconciliation({...base,localMerge:{...base.localMerge,nextAttemptAt:'2026-10-16T21:01:00Z'}},now),false);
});
