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
import { Reconciler, compareTaskPriority, executionEventSource } from '../dist/reconciler.js';
import { MemoryEventBus, eventFor, subjectToken } from '../dist/events.js';
import { serveDashboard, dashboardHtml } from '../dist/dashboard.js';
import { discoverAgents } from '../dist/registry.js';
import { compareJobPriority, needsLifecycleReconciliation, runnableManagedJobs, terminalManagedJobs, RepositoryWorkerPool } from '../dist/pool.js';
import { deriveJobRuntimeStatus } from '../dist/runtime-status.js';
import { dashboardTaskAction, dashboardTaskSetState } from '../dist/cli.js';

const now = () => new Date().toISOString();
const task = (id, state='QUEUED', dependencies=[]) => ({jobId:'j',id,parentTaskId:null,dependencies,capabilities:[],adapter:'codex',input:'do the described work',output:{kind:'task_pr'},routing:{provider:'openai',model:'gpt-test',decidedBy:'test',decidedAt:now()},state,attempt:0,maxAttempts:2,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:null,timeoutMs:1000,createdAt:now(),updatedAt:now(),continuation:null,continuationDeliveredAt:null});
const job = (tasks=[]) => ({id:'j',title:'x',prNumber:1,repository:'owner/repo',state:'ACTIVE',continuation:null,createdAt:now(),updatedAt:now(),tasks});
const eventSource = (jobId, taskId, executionId) => ({ id: executionEventSource(jobId, taskId, executionId) });
const activeEventSource = async (store, taskId, jobId='j') => {
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
  const root = { ...job([]), objective: 'durable objective', executionMode: 'fixed', state: 'DRAFT' };
  await writeFile(file, JSON.stringify(root));
  await writeFile(promptFile, 'additional planning guidance');
  await writeFile(plannerCommand, '#!/usr/bin/env node\nlet input="";for await (const chunk of process.stdin) input+=chunk;const value=JSON.parse(input);if(value.objective!=="durable objective"||value.caller_prompt!=="additional planning guidance") process.exit(7);process.stdout.write(JSON.stringify({objective_status:"satisfied",assessment:"complete",next_tasks:[]}));\n');
  await chmod(plannerCommand, 0o755);
  const result = spawn(process.execPath, [join('dist','cli.js'),'plan','--file',file,'--project-path',process.cwd(),'--prompt-file',promptFile,'--planner-command',plannerCommand], { cwd: process.cwd() });
  const [code] = await once(result, 'exit');
  assert.equal(code, 0);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.state, 'ACTIVE');
  assert.equal(saved.tasks[0].id, 'plan-1');
  assert.equal(saved.tasks[0].plannerGuidance, 'additional planning guidance');
  assert.equal(saved.tasks[0].plannerResult.objective_status, 'satisfied');
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
  const reconciler = managedReconciler(store,{owner:'test',adapters:[new FakeChatGptAdapter()],maxConcurrent:0,emit:event=>events.push(event)});
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

test('CLI task create accepts orchestrator self work without a model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-orchestrator-create-'));
  const file = join(directory, 'job.json');
  await writeFile(file, JSON.stringify(job([])));
  const result = spawn(process.execPath, [join('dist','cli.js'),'task','create','--file',file,'--task-id','self','--adapter','orchestrator','--output','task-pr','--input','handle this in the top-level orchestrator'], {cwd:process.cwd()});
  const [code] = await once(result, 'exit');
  assert.equal(code, 0);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  const created = saved.tasks.find(item => item.id === 'self');
  assert.equal(created.adapter, 'orchestrator');
  assert.equal(created.routing, undefined);
  assert.equal(created.timeoutMs, 0);
  await rm(directory,{recursive:true,force:true});
});

test('reconciler leaves orchestrator self work queued for its creating orchestrator', async () => {
  const self = task('self'); self.adapter='orchestrator'; self.routing=undefined; self.timeoutMs=0;
  const root = {...job([self]), executionMode:'fixed'};
  const store = new InMemoryStore(root); const events=[];
  const reconciler = managedReconciler(store,{owner:'test',adapters:[],emit:event=>events.push(event)});
  await reconciler.reconcile('j');
  const durable=(await store.load('j')).tasks.find(item=>item.id==='self');
  assert.equal(durable.state,'QUEUED');
  assert.equal(durable.leaseOwner,null); assert.equal(durable.executionId,null);
  assert.equal(events.some(event=>event.type==='task.orchestrator_assigned'),false);
});

test('CLI task complete terminalizes the same orchestrator self task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-orchestrator-complete-'));
  const file = join(directory, 'job.json');
  await writeFile(file, JSON.stringify(job([])));
  let child = spawn(process.execPath, [join('dist','cli.js'),'task','create','--file',file,'--task-id','self','--adapter','orchestrator','--output','task-pr','--input','do it now'], {cwd:process.cwd()});
  assert.equal(await new Promise(resolve=>child.on('close',resolve)),0);
  child = spawn(process.execPath, [join('dist','cli.js'),'task','complete','--file',file,'--task-id','self','--summary','done in creator turn'], {cwd:process.cwd()});
  assert.equal(await new Promise(resolve=>child.on('close',resolve)),0);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  const completed = saved.tasks.find(item => item.id === 'self');
  assert.equal(completed.state, 'SUCCEEDED');
  assert.equal(completed.result.summary, 'done in creator turn');
  assert.equal(completed.attempt, 1);
  await rm(directory,{recursive:true,force:true});
});

test('CLI task create defaults story size to M and derives overall timeout from size', async () => {
  const dir=await mkdtemp(join(tmpdir(),'agents-relay-story-size-'));
  const file=join(dir,'job.json');
  const root=job([]); root.executionMode='fixed'; await writeFile(file,JSON.stringify(root));
  const child=spawn(process.execPath,[join('dist','cli.js'),'task','create','--file',file,'--task-id','sized','--adapter','codex','--model','gpt-test','--output','task-pr','--story-size','L','--input','sized work'],{cwd:process.cwd()});
  assert.equal(await new Promise(resolve=>child.on('close',resolve)),0);
  const saved=JSON.parse(await readFile(file,'utf8'));
  const created=saved.tasks.find(item=>item.id==='sized');
  assert.equal(created.storySize,'L');
  assert.equal(created.timeoutMs,2700000);
  await rm(dir,{recursive:true,force:true});
});

test('CLI task update mutates safe durable fields in place and preserves execution history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-task-update-'));
  const file = join(directory, 'job.json');
  const existing = task('mutable', 'FAILED');
  existing.attempt = 2; existing.maxAttempts = 3; existing.error = 'old failure';
  existing.routing = { provider: 'openai', model: 'gpt-old', reasoning: 'medium', decidedBy: 'cli', decidedAt: 'old' };
  await writeFile(file, JSON.stringify(job([existing])));
  const result = spawn(process.execPath, [join('dist','cli.js'),'task','update','--file',file,'--task-id','mutable','--adapter','chatgpt','--provider','chatgpt','--model','gpt-5.6-sol','--reasoning','high','--capabilities','model,chatgpt,browser-harness','--max-attempts','4','--timeout','900000'], {cwd:process.cwd()});
  const [code] = await once(result,'exit');
  assert.equal(code,0);
  const saved = JSON.parse(await readFile(file,'utf8')); const updated=saved.tasks[0];
  assert.equal(updated.id,'mutable'); assert.equal(updated.state,'FAILED'); assert.equal(updated.attempt,2); assert.equal(updated.error,'old failure');
  assert.equal(updated.adapter,'chatgpt'); assert.equal(updated.routing.provider,'chatgpt'); assert.equal(updated.routing.model,'gpt-5.6-sol'); assert.equal(updated.routing.reasoning,'high');
  assert.deepEqual(updated.capabilities,['model','chatgpt','browser-harness']); assert.equal(updated.maxAttempts,4); assert.equal(updated.timeoutMs,900000);
  assert.equal(updated.routing.decidedBy,'cli:update');
  await rm(directory,{recursive:true,force:true});
});

test('CLI task update rejects active and terminal execution records', async () => {
  for (const state of ['RUNNING','SUCCEEDED','CANCELLED']) {
    const directory = await mkdtemp(join(tmpdir(), 'agents-relay-task-update-guard-')); const file=join(directory,'job.json');
    await writeFile(file, JSON.stringify(job([task('guard',state)])));
    const result=spawn(process.execPath,[join('dist','cli.js'),'task','update','--file',file,'--task-id','guard','--model','gpt-5.6-sol'],{cwd:process.cwd()});
    const [code]=await once(result,'exit'); assert.notEqual(code,0);
    const saved=JSON.parse(await readFile(file,'utf8')); assert.equal(saved.tasks[0].routing.model,'gpt-test');
    await rm(directory,{recursive:true,force:true});
  }
});

test('CLI task create rejects terminal completed jobs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-reopen-create-'));
  const file = join(directory, 'job.json');
  await writeFile(file, JSON.stringify({...job([]),state:'COMPLETED'}));
  const result = spawn(process.execPath, [join('dist','cli.js'),'task','create','--file',file,'--task-id','review','--provider','openai','--model','gpt-test','--output','task-pr','--input','review completed job'], {cwd:process.cwd()});
  const [code] = await once(result,'exit');
  assert.notEqual(code,0);
  const saved = JSON.parse(await readFile(file,'utf8'));
  assert.equal(saved.state,'COMPLETED');
  assert.equal(saved.tasks.length,0);
  await rm(directory,{recursive:true,force:true});
});

test('CLI task create and retry keep ACTIVE lifecycle while runtime changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-reactivate-')); const file=join(directory,'job.json');
  const failedTask=task('failed','FAILED'); failedTask.error='old'; failedTask.attempt=1; failedTask.maxAttempts=3;
  await writeFile(file, JSON.stringify(job([failedTask])));
  let child=spawn(process.execPath,[join('dist','cli.js'),'task','create','--file',file,'--task-id','replacement','--provider','openai','--model','gpt-test','--output','task-pr','--input','replacement'],{cwd:process.cwd()});
  let [code]=await once(child,'exit'); assert.equal(code,0); let saved=JSON.parse(await readFile(file,'utf8')); assert.equal(saved.state,'ACTIVE');
  child=spawn(process.execPath,[join('dist','cli.js'),'task','retry','--file',file,'--task-id','failed'],{cwd:process.cwd()});
  [code]=await once(child,'exit'); assert.equal(code,0); saved=JSON.parse(await readFile(file,'utf8')); assert.equal(saved.state,'ACTIVE'); assert.equal(saved.tasks.find(t=>t.id==='failed').state,'QUEUED');
  await rm(directory,{recursive:true,force:true});
});
test('manual planner retry preserves the previous planner error as retry feedback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-planner-retry-')); const file=join(directory,'job.json');
  const failedTask={...task('planner-1','FAILED'),kind:'planner',adapter:'orchestrator',error:'Planner next_tasks[0].output is required',attempt:3,maxAttempts:3};
  await writeFile(file, JSON.stringify(job([failedTask])));
  const child=spawn(process.execPath,[join('dist','cli.js'),'task','retry','--file',file,'--task-id','planner-1'],{cwd:process.cwd()});
  const [code]=await once(child,'exit'); assert.equal(code,0);
  const saved=JSON.parse(await readFile(file,'utf8')); const planner=saved.tasks.find(t=>t.id==='planner-1');
  assert.equal(planner.state,'QUEUED');
  assert.equal(planner.error,null);
  assert.equal(planner.plannerRetryFeedback,'Planner next_tasks[0].output is required');
  await rm(directory,{recursive:true,force:true});
});

test('active replacement work derives QUEUED despite historical failed tasks', () => {
  const old=task('old','FAILED'); const replacement=task('replacement','QUEUED');
  const value=schedule(job([old,replacement])); assert.equal(value.state,'ACTIVE'); assert.equal(deriveJobRuntimeStatus(value,'OPEN'),'QUEUED');
});
test('CLI record persists completed orchestrator work without pretending it was a worker execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-record-'));
  const file = join(directory, 'job.json');
  await writeFile(file, JSON.stringify(job([])));
  const result = spawn(process.execPath, [join('dist', 'cli.js'), 'record', '--file', file, '--task-id', 'truth-fix', '--project', 'agents-relay', '--summary', 'Reconciled durable state with GitHub truth', '--commit', 'abc123'], { cwd: process.cwd() });
  const [code] = await once(result, 'exit');
  assert.equal(code, 0);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.tasks[0].adapter, 'orchestrator');
  assert.equal(saved.tasks[0].agentName, 'orchestrator');
  assert.equal(saved.tasks[0].state, 'SUCCEEDED');
  assert.equal(saved.tasks[0].executionId, 'abc123');
  assert.equal(saved.tasks[0].result.data.commit, 'abc123');
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
test('repository pool orders open jobs globally by durable priority', () => { const low={...job([]),id:'low',priority:'P3',createdAt:'2026-01-01T00:00:00.000Z'}; const high={...job([]),id:'high',priority:'P0',createdAt:'2026-02-01T00:00:00.000Z'}; assert.equal(compareJobPriority(high,low)<0,true); assert.deepEqual(runnableManagedJobs([{job:low,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null},{job:high,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null},{job:{...high,id:'merged'},githubState:'MERGED',draft:false,mergedAt:now(),closedAt:now()}]).map(x=>x.id),['high','low']); });
test('startup reconciliation selects expired durable RUNNING leases after daemon restart', () => {
  const expired=task('expired','RUNNING'); expired.executionId='expired-exec'; expired.leaseExpiresAt='2026-09-19T16:46:23.718Z';
  const live=task('live','RUNNING'); live.executionId='live-exec'; live.leaseExpiresAt='2026-09-19T17:10:00.000Z';
  assert.equal(needsLifecycleReconciliation(job([expired]),Date.parse('2026-09-19T16:59:20.000Z')),true);
  assert.equal(needsLifecycleReconciliation(job([live]),Date.parse('2026-09-19T16:59:20.000Z')),false);
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
test('completed jobs remain behind the runnable gate even if stale task data appears', () => { const review=task('review','QUEUED'); const completed={...job([review]),id:'completed-with-new-work',state:'COMPLETED'}; const item={job:completed,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null}; assert.deepEqual(runnableManagedJobs([item]),[]); });
test('ACTIVE jobs with failed tasks remain eligible for reconciliation', () => { const failedTask=task('failed-task','FAILED'); const failed={...job([failedTask]),id:'failed'}; const item={job:failed,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null}; assert.deepEqual(runnableManagedJobs([item]).map(x=>x.id),['failed']); });
test('GitHub draft PR does not override ACTIVE job execution lifecycle', () => { const held={...job([]),id:'held'}; const item={job:held,githubState:'OPEN',draft:true,mergedAt:null,closedAt:null}; assert.deepEqual(runnableManagedJobs([item]).map(x=>x.id),['held']); });
test('repository pool selects stale terminal jobs for lifecycle reconciliation', () => {
  const open={...job([]),id:'open'}; const merged={...job([]),id:'merged',state:'ACTIVE'}; const completed={...job([]),id:'done',state:'COMPLETED'}; const closed={...job([]),id:'closed',state:'ACTIVE'};
  const items=[{job:open,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null},{job:merged,githubState:'MERGED',draft:false,mergedAt:now(),closedAt:now()},{job:completed,githubState:'MERGED',draft:false,mergedAt:now(),closedAt:now()},{job:closed,githubState:'CLOSED',draft:false,mergedAt:null,closedAt:now()}];
  assert.deepEqual(new Set(terminalManagedJobs(items).map(x=>x.id)),new Set(['merged','closed']));
});

test('repository pool reuses startup discovery without another workspace scan', async () => {
  const calls=[];
  const queued=task('startup-task','QUEUED');
  const root={...job([queued]),id:'startup-known',repository:'owner/repo',prNumber:7};
  const overview={job:root,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null};
  const client={request:async()=>{throw new Error('startup known state must not scan REST');},graphql:async()=>{throw new Error('startup known state must not scan GraphQL');}};
  const pool=new RepositoryWorkerPool(client,['owner/repo'],new Set(['bot']),4,(_store,maxConcurrent)=>({reconcile:async id=>{calls.push({id,maxConcurrent});}}));
  await pool.reconcileKnown([overview]);
  assert.deepEqual(calls,[{id:'startup-known',maxConcurrent:1}]);
});

test('repository pool uses targeted wake metadata without a full workspace scan', async () => {
  const bus=new MemoryEventBus();
  const calls=[];
  const client={request:async()=>{throw new Error('full scan should not run for targeted wake');}};
  const pool=new RepositoryWorkerPool(client,['owner/repo'],new Set(['bot']),4,(_store,maxConcurrent)=>({reconcile:async id=>{calls.push({id,maxConcurrent});}}));
  const stop=await pool.watch(bus);
  await bus.publish(eventFor('job-1','task-1',null,'job.wake','queued','wake','orchestrator',{repository:'owner/repo',prNumber:42}));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(calls,[{id:'job-1',maxConcurrent:4}]);
  await stop();
});

test('repository pool serializes same-job targeted reconcile with discovered reconcile', async () => {
  const queued=task('serialize-task','QUEUED');
  const root={...job([queued]),id:'serialize-job',repository:'owner/repo',prNumber:44};
  const overview={job:root,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null};
  const client={request:async()=>{throw new Error('unexpected request');}};
  let active=0, maxActive=0; const calls=[]; let releaseFirst;
  const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
  const pool=new RepositoryWorkerPool(client,['owner/repo'],new Set(['bot']),4,(_store,maxConcurrent)=>({reconcile:async id=>{
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

test('repository pool consumes a webhook PR snapshot for targeted reconciliation without duplicate reads', async () => {
  const root={...job([]),id:'seeded-job',repository:'owner/repo',prNumber:46};
  let graphqlCalls=0;
  const client={request:async()=>{throw new Error('unexpected REST');},graphql:async()=>{graphqlCalls+=1;throw new Error('seeded reconcile must not re-read GraphQL');}};
  const seen=[];
  const pool=new RepositoryWorkerPool(client,['owner/repo'],new Set(['bot']),4,(store,maxConcurrent)=>({reconcile:async id=>{
    const loaded=await store.load(id);
    const state=await store.pullRequestState();
    const head=await store.pullRequestHead();
    seen.push({id,maxConcurrent,title:loaded.title,state,head});
  }}));
  pool.seedTargetSnapshot('owner/repo',46,'seeded-job',{
    prNode:{id:'PR_seed',state:'OPEN',merged:false,mergedAt:null,closedAt:null,body:renderJobBody(root),headRefName:'feat/seed',headRefOid:'seed-sha'},
    comments:[],
  });
  await pool.reconcileTarget('owner/repo',46,'seeded-job');
  assert.equal(graphqlCalls,0);
  assert.deepEqual(seen,[{id:'seeded-job',maxConcurrent:4,title:'x',state:'OPEN',head:{ref:'feat/seed',sha:'seed-sha'}}]);
});

test('runtime-only event cannot consume a pending webhook snapshot seed', async () => {
  const bus=new MemoryEventBus();
  const root={...job([]),id:'seed-preserved-job',repository:'owner/repo',prNumber:47};
  let graphqlCalls=0;
  let reconciles=0;
  const client={request:async()=>{throw new Error('unexpected REST');},graphql:async()=>{graphqlCalls+=1;throw new Error('webhook seed was lost before reconcile');}};
  const pool=new RepositoryWorkerPool(client,['owner/repo'],new Set(['bot']),4,(store)=>({
    applyEvent:async event=>({applied:true,reconcile:false,reason:event.type}),
    reconcile:async id=>{
      reconciles+=1;
      if (reconciles >= 2) {
        const loaded=await store.load(id);
        assert.equal(loaded.id,'seed-preserved-job');
      }
    }
  }));
  await pool.reconcileTarget('owner/repo',47,'seed-preserved-job','setup-target');
  pool.seedTargetSnapshot('owner/repo',47,'seed-preserved-job',{
    prNode:{id:'PR_seed_preserved',state:'OPEN',merged:false,mergedAt:null,closedAt:null,body:renderJobBody(root),headRefName:'feat/seed-preserved',headRefOid:'seed-preserved-sha'},
    comments:[],
  });
  const stop=await pool.watch(bus);
  await bus.publish(eventFor('seed-preserved-job','task-1',null,'task.started','running','started','orchestrator'));
  await pool.reconcileTarget('owner/repo',47,'seed-preserved-job','github.webhook:pull_request:edited');
  assert.equal(graphqlCalls,0);
  assert.equal(reconciles,2);
  await stop();
});

test('repository pool coalesces concurrent targeted reconciles for the same job', async () => {
  const calls=[]; let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const client={request:async()=>{throw new Error('unexpected request');}};
  const pool=new RepositoryWorkerPool(client,['owner/repo'],new Set(['bot']),4,()=>({reconcile:async id=>{calls.push(id); await gate;}}));
  const first=pool.reconcileTarget('owner/repo',45,'burst-job');
  const second=pool.reconcileTarget('owner/repo',45,'burst-job');
  const third=pool.reconcileTarget('owner/repo',45,'burst-job');
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(calls,['burst-job']);
  release();
  await Promise.all([first,second,third]);
  assert.deepEqual(calls,['burst-job']);
});

test('GitHub webhook enters through EventBus before coordinator refreshes and reconciles the discovered job', async () => {
  const bus=new MemoryEventBus();
  const root={...job([]),id:'webhook-signal-job',repository:'owner/repo',prNumber:82};
  const observed=[];
  let refreshCalls=0;
  let reconcileCalls=0;
  const client={request:async()=>{throw new Error('unexpected REST');},graphql:async()=>{throw new Error('coordinator must consume the refreshed seed');}};
  const pool=new RepositoryWorkerPool(
    client,
    ['owner/repo'],
    new Set(['bot']),
    2,
    store=>({
      applyEvent:async event=>({applied:true,reconcile:false,reason:event.type}),
      reconcile:async id=>{
        reconcileCalls+=1;
        const loaded=await store.load(id);
        assert.equal(loaded.id,'webhook-signal-job');
      }
    }),
    ()=>false,
    async (repository,prNumber,trigger)=>{
      refreshCalls+=1;
      observed.push(`refresh:${trigger}`);
      assert.equal(repository,'owner/repo');
      assert.equal(prNumber,82);
      return {
        overviews:[{job:root,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null}],
        seed:{
          prNode:{id:'PR_webhook_signal',state:'OPEN',merged:false,mergedAt:null,closedAt:null,body:renderJobBody(root),headRefName:'feat/webhook-signal',headRefOid:'webhook-signal-sha'},
          comments:[],
        },
      };
    },
  );
  const stopAudit=await bus.subscribeAll(async event=>{ observed.push(`bus:${event.job_id}:${event.type}`); });
  const stopPool=await pool.watch(bus);
  await pool.webhookSignal(bus,{deliveryId:'delivery-signal',event:'pull_request',action:'edited',repository:'owner/repo',pullRequest:82});
  for(let i=0;i<20&&reconcileCalls===0;i+=1) await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(refreshCalls,1);
  assert.equal(reconcileCalls,1);
  assert.equal(observed[0],'bus:github-webhook:github.webhook');
  assert.ok(observed.some(value=>value==='bus:webhook-signal-job:github.webhook'));
  await stopPool(); await stopAudit();
});

test('repository pool emits package.published from a correlated publication webhook without service actions', async () => {
  const bus=new MemoryEventBus();
  const events=[];
  const client={request:async()=>{throw new Error('unexpected request');}};
  const root={...job([]),id:'release-job',repository:'owner/repo',prNumber:83};
  const pool=new RepositoryWorkerPool(client,['owner/repo'],new Set(['bot']),1,()=>({reconcile:async()=>{}}));
  const stop=await bus.subscribe('release-job',async event=>events.push(event));
  await pool.webhookWake(bus,root,{deliveryId:'delivery-123',event:'issue_comment',action:'created',repository:'owner/repo',pullRequest:83,publication:{package:'agents-relay',version:'1.2.3',registry:'https://registry.npmjs.org',sha:'abc123'}});
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
  const pool=new RepositoryWorkerPool(client,['owner/repo'],new Set(['bot']),4,(_store,maxConcurrent)=>({
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
    {kind:'reconcile',id:'job-2',maxConcurrent:4},
    {kind:'event',type:'task.started',jobId:'job-2',taskId:'task-2',maxConcurrent:4},
    {kind:'event',type:'task.completed',jobId:'job-2',taskId:'task-2',maxConcurrent:4},
    {kind:'reconcile',id:'job-2',maxConcurrent:4}
  ]);
  await stop();
});

test('repository pool reconciles merged PRs even though they are not runnable', async () => {
  const root={...job([]),id:'merged-pool',state:'ACTIVE',prNumber:14};
  const comments=[{id:1,body:marker('agents-relay:job:v1',{...root,tasks:undefined}),updated_at:now(),user:{login:'bot'}}];
  const client=graphCommentClient(comments,14,'MERGED');
  const pool=new RepositoryWorkerPool(client,'owner/repo',new Set(['bot']),2,store=>managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()]}));
  await pool.reconcile();
  assert.equal(comments.some(c=>c.body.includes('agents-relay:job:v1')),false);
  assert.match(client.body,/\"state\":\"COMPLETED\"/);
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
  const durable=(await store.load('j')).tasks[0]; assert.equal(durable.state,'FAILED'); assert.match(durable.error,/worker_start_timeout/); await stop();
});

test('ChatGPT reviewer uses the same start acknowledgement policy as normal ChatGPT tasks', async () => {
  const contextRoot=await mkdtemp(join(tmpdir(),'agents-relay-reviewer-context-')); await mkdir(join(contextRoot,'agents')); await writeFile(join(contextRoot,'agents','reviewer.agent.md'),'---\nname: reviewer\n---\nReview the managed task.\n');
  const work=task('work','SUCCEEDED'); const store=new InMemoryStore({...job([work]),headSha:'sha-review-timeout'}); const bus=new MemoryEventBus();
  const adapter={name:'chatgpt',id:'fake-chatgpt',capabilities:['model','chatgpt'],launch(_task,_signal,context){return {id:'chat-runtime',launched:Promise.resolve(),promise:(context.waitForWorkerStart ?? Promise.resolve()).then(()=>({summary:'submitted'})),cancel(){}};}};
  const reviewer={adapter:'chatgpt',routing:{provider:'chatgpt',model:'account-defaults',decidedBy:'test',decidedAt:now()}};
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,startAckTimeoutMs:100,reviewer,executionContextRoots:{globalRoot:contextRoot,neoRoot:null}});
  const stop=await reconciler.watch('j'); await reconciler.reconcile('j'); await new Promise(resolve=>setTimeout(resolve,40));
  const created=(await store.load('j')).tasks.find(item=>item.agentName==='reviewer'); assert.equal(created?.state,'QUEUED');
  await bus.publish(eventFor('j',created.id,null,'task.started','running','review began','user',undefined,await activeEventSource(store,created.id)));
  await bus.publish(eventFor('j',created.id,null,'task.completed','succeeded','review done','user',undefined,await activeEventSource(store,created.id)));
  await new Promise(resolve=>setTimeout(resolve,10)); await stop(); await rm(contextRoot,{recursive:true,force:true});
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
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(released, true);
    assert.equal((await store.load('j')).tasks[0].state, 'CANCELLED');
    await stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('sync adapter runtime exit clears overall timeout without completing the task', async () => {
  const t=task('runtime-exit'); t.timeoutMs=30; const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus(); const events=[];
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
  const stopEvents=await bus.subscribe('j',async event=>events.push(event)); const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  await bus.publish(eventFor('j','runtime-exit',null,'task.started','running','worker began','user',undefined,await activeEventSource(store,'runtime-exit')));
  adapter.resolvers[0].resolve({summary:'process exited zero'});
  await new Promise(resolve=>setTimeout(resolve,70));
  const durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'RUNNING');
  assert.equal(durable.failureReason,undefined);
  assert.equal(events.filter(event=>event.type==='task.process.exited').length,1);
  assert.equal(events.filter(event=>event.type==='task.failed').length,0);
  await reconciler.close();
  await stop(); await stopEvents();
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

test('normal terminal event remains authoritative when Codex exits afterward', async () => {
  const t=task('success-then-exit'); const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus(); const events=[];
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
  const stopEvents=await bus.subscribe('j',async event=>events.push(event)); const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  await bus.publish(eventFor('j','success-then-exit',null,'task.started','running','worker began','user',undefined,await activeEventSource(store,'success-then-exit')));
  await bus.publish(eventFor('j','success-then-exit',null,'task.completed','succeeded','durable output','user',undefined,await activeEventSource(store,'success-then-exit')));
  adapter.resolvers[0].resolve({summary:'runtime exited'});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal((await store.load('j')).tasks[0].state,'SUCCEEDED');
  assert.equal(events.filter(event=>event.type==='task.failed').length,0);
  assert.equal(events.filter(event=>event.type==='task.process.exited').length,1);
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


test('delivery failure after correlated task.started is diagnostic only and terminal event remains authoritative', async () => {
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
  await new Promise(resolve=>setTimeout(resolve,20));
  rejectRun(new LaunchFailure('DOM receipt missed the submitted user turn'));
  await new Promise(resolve=>setTimeout(resolve,20));
  let durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'RUNNING');
  assert.equal(events.some(event=>event.type==='task.failed'),false);
  assert.equal(events.some(event=>event.type==='task.process.delivery_failed' && event.data?.authoritative===false),true);
  await bus.publish(eventFor('j',durable.id,null,'task.completed','succeeded','review finished','user',undefined,eventSource('j',durable.id,durable.executionId)));
  await new Promise(resolve=>setTimeout(resolve,20));
  durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'SUCCEEDED');
  assert.equal(durable.error,null);
  await stop();
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
  const reconciler=managedReconciler(store,{owner:'test',adapters:[],maxConcurrent:0});
  await reconciler.reconcile('j');
  const saved=await store.load('j');
  const fresh=saved.tasks.find(item=>item.id==='plan-2');
  assert.ok(fresh);
  assert.equal(fresh.kind,'planner');
  assert.equal(fresh.parentTaskId,'planner-1');
  assert.equal(fresh.state,'QUEUED');
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
  assert.equal(deriveJobRuntimeStatus(saved,'OPEN'),'REVIEWING');
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
  assert.equal((await store.load('j')).tasks[0].state,'FAILED');
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
  const durable=await store.load('j'); assert.equal(durable.tasks[0].state,'FAILED'); assert.equal(durable.tasks[1].state,'FAILED');
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
  await new Promise(resolve=>setTimeout(resolve,20));
  const durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'SUCCEEDED');
  assert.equal(durable.result.summary,'instant complete');
  await stop();
});

test('correlated failed and blocked events set terminal durable states', async () => {
  for (const [type,state] of [['task.failed','FAILED'],['task.blocked','BLOCKED']]) {
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
test('dashboard selected-job refresh serves the requested durable overview without a page reload', async () => { const selected={...job([task('selected','SUCCEEDED')]),id:'selected'}; const refreshed={...selected,tasks:[...selected.tasks,task('new-durable-task','QUEUED')]}; const store=new InMemoryStore(selected); const server=managedDashboard(store,0,undefined,10000,'selected',undefined,async()=>[{job:selected,githubState:'OPEN',draft:true,mergedAt:null,closedAt:null}],undefined,undefined,async id=>id==='selected'?refreshed:null); await new Promise(resolve=>server.once('listening',resolve)); const address=server.address(); const port=typeof address==='object'&&address ? address.port : 0; const response=await fetch(`http://127.0.0.1:${port}/api/job?id=selected`); assert.equal(response.status,200); const body=await response.text(); assert.match(body,/selected/); assert.match(body,/new-durable-task/); const missing=await fetch(`http://127.0.0.1:${port}/api/job?id=missing`); assert.equal(missing.status,404); server.close(); });


test('workspace webhook accepts configured repositories and forwards exact PR identity', async () => {
  const selected={...job([task('webhook-task','SUCCEEDED')]),id:'webhook-job',repository:'lalalic/agents-relay',prNumber:9};
  const store=new InMemoryStore(selected);
  const received=[];
  const secret='workspace-secret';
  const server=managedDashboard(store,0,undefined,10000,'webhook-job',undefined,async()=>[{job:selected,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null}],{secret,repositories:new Set(['lalalic/agents-relay','lalalic/neo']),wake:async event=>{received.push(event);}});
  await new Promise(resolve=>server.once('listening',resolve));
  const address=server.address(); const port=typeof address==='object'&&address?address.port:0;
  const body=JSON.stringify({action:'created',repository:{full_name:'lalalic/agents-relay'},issue:{number:9,pull_request:{url:'x'}}});
  const signature='sha256='+createHmac('sha256',secret).update(body).digest('hex');
  const response=await fetch(`http://127.0.0.1:${port}/webhooks/github`,{method:'POST',headers:{'content-type':'application/json','x-github-delivery':'workspace-delivery','x-github-event':'issue_comment','x-hub-signature-256':signature},body});
  assert.equal(response.status,202);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(received.length,1);
  assert.equal(received[0].repository,'lalalic/agents-relay');
  assert.equal(received[0].pullRequest,9);
  server.close();
});

test('webhook refresh immediately pushes the refreshed dashboard snapshot even when reconciliation fails', async () => {
  const selected={...job([task('webhook-task','SUCCEEDED')]),id:'webhook-job',repository:'lalalic/agents-relay',prNumber:9};
  const refreshed={...selected,tasks:[...selected.tasks,task('fresh-task','QUEUED')]};
  const secret='workspace-secret'; let reconciliationFailed=false; let current=selected; let wakeResolve;
  const wakeDone=new Promise(resolve=>{wakeResolve=resolve;});
  const server=managedDashboard(new InMemoryStore(selected),0,undefined,300000,'webhook-job',undefined,async()=>[{job:current,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null}],{secret,repositories:new Set(['lalalic/agents-relay']),refresh:async()=>{current=refreshed; return ['webhook-job'];},wake:async()=>{
    try { throw new Error('reconciliation failed'); } catch { reconciliationFailed=true; throw new Error('reconciliation failed'); } finally { wakeResolve(); }
  }});
  await new Promise(resolve=>server.once('listening',resolve));
  const address=server.address(); const port=typeof address==='object'&&address?address.port:0;
  const stream=await fetch(`http://127.0.0.1:${port}/events`); const reader=stream.body.getReader(); await reader.read();
  const body=JSON.stringify({action:'synchronize',repository:{full_name:'lalalic/agents-relay'},pull_request:{number:9}});
  const signature='sha256='+createHmac('sha256',secret).update(body).digest('hex');
  await fetch(`http://127.0.0.1:${port}/webhooks/github`,{method:'POST',headers:{'content-type':'application/json','x-github-delivery':'freshness-delivery','x-github-event':'pull_request','x-hub-signature-256':signature},body});
  let received=''; const readFreshSnapshot=(async()=>{for (;;) { const chunk=await reader.read(); received+=Buffer.from(chunk.value??[]).toString(); if (received.includes('fresh-task')) return; if (chunk.done) throw new Error('dashboard event stream ended before refreshed snapshot'); }})();
  await Promise.race([readFreshSnapshot,new Promise((_,reject)=>setTimeout(()=>reject(new Error('timed out waiting for refreshed dashboard snapshot')),1000))]);
  await Promise.race([wakeDone,new Promise((_,reject)=>setTimeout(()=>reject(new Error('timed out waiting for webhook wake')),1000))]);
  assert.equal(reconciliationFailed,true); assert.match(received,/fresh-task/); await reader.cancel(); server.close();
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

test('ChatGPT tasks do not carry durable resumable thread lifecycle', () => {
  const t=task('chat'); t.adapter='chatgpt'; t.threadId=null;
  assert.equal(t.threadId,null);
  assert.equal(t.output.kind,'task_pr');
});

test('merged zero-task PR becomes COMPLETED even when scheduler would leave it OPEN', async () => {
  const root=job([]); const store=new InMemoryStore(root); store.pullRequestState=async()=> 'MERGED';
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()]});
  const result=await reconciler.reconcile('j');
  assert.equal(result.state,'COMPLETED');
});

test('merged PR authoritatively completes jobs stuck in failed, blocked, or cancelled states', async () => {
  for (const state of ['FAILED','BLOCKED','CANCELLED']) {
    const root={...job([]),state};
    const store=new InMemoryStore(root);
    store.pullRequestState=async()=> 'MERGED';
    const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()]});
    const result=await reconciler.reconcile('j');
    assert.equal(result.state,'COMPLETED', state);
  }
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
  assert.match(reviewer?.input ?? '', /Review existing PR #1 at exactly head SHA sha-review-1/);
  assert.doesNotMatch(reviewer?.input ?? '', /review\.started|review\.approved|task\.completed/);

  await reconciler.reconcile('j');
  saved = await store.load('j');
  assert.equal(saved.tasks.filter(item => item.agentName === 'reviewer').length, 1);
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
  assert.equal(saved.tasks.filter(item=>item.kind==='planner').length,2);
  assert.equal(saved.tasks.filter(item=>item.kind==='planner').at(-1).id,'plan-2');
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
  assert.equal(deriveJobRuntimeStatus(saved,'OPEN'),'WAITING');
  assert.equal(events.filter(event=>event.type==='review.fix_task_created').length,1);
  await reconciler.handleEvent(eventFor('j',reviewer.id,null,'review.changes_required','failed','duplicate event','orchestrator',payload));
  saved=await store.load('j');
  assert.equal(saved.tasks.filter(item=>item.id.startsWith('review-fix-')).length,1);
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

test('approved review auto-merges by default and respects opt-out', async () => {
  for (const [autoMerge, expected] of [[undefined,1],[false,0]]) {
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
  await reconciler.reconcile('j');
  const refreshed = await store.load('j');
  assert.equal(refreshed.review?.headSha, 'sha-review-2');
  assert.equal(refreshed.tasks.filter(item => item.agentName === 'reviewer').length, 2);
});


test('blocked review transitions reviewer task to BLOCKED', async () => {
  const reviewJob={...job([task('work','SUCCEEDED')]),headSha:'sha-blocked'};
  const store=new InMemoryStore(reviewJob);
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:new MemoryEventBus(),maxConcurrent:0});
  await reconciler.reconcile('j');
  const reviewer=(await store.load('j')).tasks.find(item=>item.agentName==='reviewer');
  assert.ok(reviewer);
  await reconciler.handleEvent(eventFor('j',reviewer.id,null,'review.started','running','started','orchestrator',{review:{headSha:'sha-blocked'}}));
  await reconciler.handleEvent(eventFor('j',reviewer.id,null,'review.blocked','blocked','external blocker','orchestrator',{review:{headSha:'sha-blocked'}}));
  const saved=await store.load('j');
  assert.equal(saved.review?.outcome,'blocked');
  assert.equal(saved.tasks.find(item=>item.id===reviewer.id)?.state,'BLOCKED');
});

test('approved reviewer remains SUCCEEDED after merged PR reconciliation', async () => {
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
  assert.equal(merged.state,'COMPLETED');
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

test('merged PR cancels running work with task.cancelled lifecycle event', async () => {
  const t=task('running-on-merge','RUNNING'); t.executionId='run-merge'; t.leaseOwner='worker'; t.leaseExpiresAt=new Date(Date.now()+60000).toISOString();
  const store=new InMemoryStore(job([t])); store.pullRequestState=async()=> 'MERGED';
  const reconciler=managedReconciler(store,{owner:'test',adapters:[new FakeAdapter()]});
  const result=await reconciler.reconcile('j');
  const durable=result.tasks.find(item=>item.id===t.id);
  assert.equal(result.state,'COMPLETED');
  assert.equal(durable.state,'CANCELLED');
  assert.equal(durable.error,'Pull request merged');
});

test('closed unmerged PR cancels queued work and job without launching', async () => {
  const t=task('closed-queued'); const store=new InMemoryStore(job([t])); store.pullRequestState=async()=> 'CLOSED'; const adapter=new FakeAdapter();
  const reconciler=managedReconciler(store,{owner:'test',adapters:[adapter]}); const result=await reconciler.reconcile('j');
  assert.equal(result.state,'CANCELLED'); assert.equal(result.tasks[0].state,'CANCELLED'); assert.equal(result.tasks[0].error,'Pull request closed'); assert.equal(adapter.launches,0);
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

test('repository pool performs no GitHub-backed reconciliation while rate limited', async () => {
  const calls=[];
  const client={request:async()=>{calls.push('request'); throw new Error('must not call GitHub');},graphql:async()=>{calls.push('graphql'); throw new Error('must not call GitHub');}};
  const pool=new RepositoryWorkerPool(client,['owner/repo'],new Set(['bot']),4,()=>({reconcile:async()=>{calls.push('reconcile');}}),()=>true);
  await pool.reconcile();
  await pool.reconcileTarget('owner/repo',44,'limited-job');
  assert.deepEqual(calls,[]);
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
