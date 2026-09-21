import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTask, marker, TASK_MARKER } from '../dist/markers.js';
import { detectCycles, dependencyReady, extendRetryBudget, schedule, transitionTask } from '../dist/scheduler.js';
import { CodexAdapter, ChatGptAdapter, LaunchFailure } from '../dist/adapters.js';
import { InMemoryStore, GitHubStore } from '../dist/store.js';
import { Reconciler, compareTaskPriority } from '../dist/reconciler.js';
import { MemoryEventBus, eventFor, subjectToken } from '../dist/events.js';
import { serveDashboard, dashboardHtml } from '../dist/dashboard.js';
import { discoverAgents } from '../dist/registry.js';
import { compareJobPriority, needsLifecycleReconciliation, runnableManagedJobs, terminalManagedJobs, RepositoryWorkerPool } from '../dist/pool.js';

const now = () => new Date().toISOString();
const task = (id, state='QUEUED', dependencies=[]) => ({jobId:'j',id,parentTaskId:null,dependencies,capabilities:[],adapter:'codex',input:'do the described work',output:{kind:'task_pr'},routing:{provider:'openai',model:'gpt-test',decidedBy:'test',decidedAt:now()},state,attempt:0,maxAttempts:2,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:null,timeoutMs:1000,createdAt:now(),updatedAt:now(),continuation:null,continuationDeliveredAt:null});
const job = (tasks=[]) => ({id:'j',title:'x',prNumber:1,repository:'owner/repo',state:'OPEN',continuation:null,createdAt:now(),updatedAt:now(),tasks});
const graphCommentClient = (comments, prNumber=1, prState='OPEN') => ({
  request: async path => {
    if (path.includes('/pulls?')) return [{number:prNumber,state:prState.toLowerCase(),merged_at:prState==='MERGED'?now():null,closed_at:prState!=='OPEN'?now():null,body:'',head:{ref:'fix'},base:{ref:'main'}}];
    throw new Error('unexpected REST '+path);
  },
  graphql: async (query, variables={}) => {
    if (query.includes('pullRequest(number:$number){id state merged mergedAt closedAt}')) return {repository:{pullRequest:{id:'PR_'+prNumber,state:prState==='MERGED'?'CLOSED':prState,merged:prState==='MERGED',mergedAt:prState==='MERGED'?now():null,closedAt:prState!=='OPEN'?now():null}}};
    if (query.includes('open:pullRequests(first:50')) {
      const node={number:prNumber,body:'',state:prState==='MERGED'?'CLOSED':prState,isDraft:false,merged:prState==='MERGED',mergedAt:prState==='MERGED'?now():null,closedAt:prState!=='OPEN'?now():null,comments:{nodes:comments.map(c=>({body:c.body,author:{login:c.user.login}}))}};
      return {repository:{open:{nodes:prState==='OPEN'?[node]:[],pageInfo:{hasNextPage:false,endCursor:null}},recentClosed:{nodes:prState==='OPEN'?[]:[node]}}};
    }
    if (query.includes('comments(first:100')) return {repository:{pullRequest:{comments:{nodes:comments.map(c=>({id:'IC_'+c.id,databaseId:c.id,body:c.body,updatedAt:c.updated_at,author:{login:c.user.login}})),pageInfo:{hasNextPage:false,endCursor:null}}}}};
    if (query.includes('addComment')) {const c={id:comments.length+1,body:variables.body,updated_at:now(),user:{login:'bot'}};comments.push(c);return {addComment:{commentEdge:{node:{id:'IC_'+c.id}}}};}
    if (query.includes('updateIssueComment')) {const id=Number(String(variables.id).replace('IC_',''));const c=comments.find(x=>x.id===id);c.body=variables.body;return {updateIssueComment:{issueComment:{id:variables.id}}};}
    if (query.includes('deleteIssueComment')) {const id=Number(String(variables.id).replace('IC_',''));const i=comments.findIndex(x=>x.id===id);if(i>=0)comments.splice(i,1);return {deleteIssueComment:{clientMutationId:null}};}
    throw new Error('unexpected GraphQL '+query);
  }
});
class FakeAdapter { name='codex'; id='fake-codex'; capabilities=['model','codex']; launches=0; cancelled=0; resolvers=[]; launch(t, signal) { this.launches += 1; let resolvePromise; let rejectPromise; const promise = new Promise((resolve,reject) => { resolvePromise=resolve; rejectPromise=reject; }); this.resolvers.push({resolve:resolvePromise,reject:rejectPromise}); signal.addEventListener('abort', () => { this.cancelled += 1; rejectPromise(new Error('aborted')); }, {once:true}); return {id:`exec-${this.launches}`,promise,cancel:() => {this.cancelled += 1; rejectPromise(new Error('cancelled'));}}; } }
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
test('CLI submit stores optional project and agent metadata with parent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-task-metadata-'));
  const file = join(directory, 'job.json');
  await writeFile(file, JSON.stringify(job([])));
  const result = spawn(process.execPath, [join('dist', 'cli.js'), 'submit', '--file', file, '--task-id', 'child', '--parent', 'orchestrator', '--project', 'Agents Relay', '--agent', 'codex', '--provider','openai','--model','gpt-test','--output','task-pr','--input', 'build metadata'], { cwd: process.cwd() });
  const [code] = await once(result, 'exit');
  assert.equal(code, 0);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.tasks[0].projectName, 'Agents Relay');
  assert.equal(saved.tasks[0].agentName, 'codex');
  assert.equal(saved.tasks[0].parentTaskId, 'orchestrator');
  assert.equal(saved.tasks[0].planningDecisionId, 'plan-child');
  assert.equal(saved.tasks[0].planningSource, 'orchestrator');
  assert.equal(saved.tasks[1].id, 'plan-child');
  assert.equal(saved.tasks[1].kind, 'planner');
  assert.equal(saved.tasks[1].parentTaskId, 'orchestrator');
  assert.equal(saved.tasks[1].state, 'SUCCEEDED');
});
test('CLI submit accepts orchestrator self work without a model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-orchestrator-submit-'));
  const file = join(directory, 'job.json');
  await writeFile(file, JSON.stringify(job([])));
  const result = spawn(process.execPath, [join('dist','cli.js'),'submit','--file',file,'--task-id','self','--adapter','orchestrator','--output','task-pr','--input','handle this in the top-level orchestrator'], {cwd:process.cwd()});
  const [code] = await once(result, 'exit');
  assert.equal(code, 0);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  const created = saved.tasks.find(item => item.id === 'self');
  assert.equal(created.adapter, 'orchestrator');
  assert.equal(created.routing, undefined);
  assert.equal(created.timeoutMs, 0);
  await rm(directory,{recursive:true,force:true});
});

test('reconciler assigns orchestrator work to self without launching an adapter and accepts terminal events', async () => {
  const self = task('self'); self.adapter='orchestrator'; self.routing=undefined; self.timeoutMs=0;
  const root = {...job([self]), executionMode:'fixed'};
  const store = new InMemoryStore(root); const events=[];
  const reconciler = new Reconciler(store,{owner:'test',adapters:[],emit:event=>events.push(event)});
  await reconciler.reconcile('j');
  let durable=(await store.load('j')).tasks.find(item=>item.id==='self');
  assert.equal(durable.state,'RUNNING');
  assert.equal(durable.leaseOwner,null); assert.equal(durable.executionId,null);
  assert.equal(events.some(event=>event.type==='task.orchestrator_assigned'),true);
  await reconciler.handleEvent(eventFor('j','self',null,'task.completed','succeeded','orchestrator finished','orchestrator'));
  durable=(await store.load('j')).tasks.find(item=>item.id==='self');
  assert.equal(durable.state,'SUCCEEDED'); assert.equal(durable.result.summary,'orchestrator finished');
});

test('CLI submit defaults story size to M and derives overall timeout from size', async () => {
  const dir=await mkdtemp(join(tmpdir(),'agents-relay-story-size-'));
  const file=join(dir,'job.json');
  const root=job([]); root.executionMode='fixed'; await writeFile(file,JSON.stringify(root));
  const child=spawn(process.execPath,[join('dist','cli.js'),'submit','--file',file,'--task-id','sized','--adapter','codex','--model','gpt-test','--output','task-pr','--story-size','L'],{cwd:process.cwd()});
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

test('CLI submit reopens a completed job before publishing new work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-reopen-submit-'));
  const file = join(directory, 'job.json');
  await writeFile(file, JSON.stringify({...job([]),state:'COMPLETED'}));
  const result = spawn(process.execPath, [join('dist','cli.js'),'submit','--file',file,'--task-id','review','--provider','openai','--model','gpt-test','--output','task-pr','--input','review completed job'], {cwd:process.cwd()});
  const [code] = await once(result,'exit');
  assert.equal(code,0);
  const saved = JSON.parse(await readFile(file,'utf8'));
  assert.equal(saved.state,'RUNNING');
  assert.equal(saved.tasks[0].id,'review');
  await rm(directory,{recursive:true,force:true});
});

test('CLI submit and retry reactivate failed jobs as RUNNING', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-reactivate-')); const file=join(directory,'job.json');
  const failedTask=task('failed','FAILED'); failedTask.error='old'; failedTask.attempt=1; failedTask.maxAttempts=3;
  await writeFile(file, JSON.stringify({...job([failedTask]),state:'FAILED'}));
  let child=spawn(process.execPath,[join('dist','cli.js'),'submit','--file',file,'--task-id','replacement','--provider','openai','--model','gpt-test','--output','task-pr','--input','replacement'],{cwd:process.cwd()});
  let [code]=await once(child,'exit'); assert.equal(code,0); let saved=JSON.parse(await readFile(file,'utf8')); assert.equal(saved.state,'RUNNING');
  saved.state='FAILED'; await writeFile(file,JSON.stringify(saved));
  child=spawn(process.execPath,[join('dist','cli.js'),'retry','--file',file,'--task-id','failed'],{cwd:process.cwd()});
  [code]=await once(child,'exit'); assert.equal(code,0); saved=JSON.parse(await readFile(file,'utf8')); assert.equal(saved.state,'RUNNING'); assert.equal(saved.tasks.find(t=>t.id==='failed').state,'READY');
  await rm(directory,{recursive:true,force:true});
});
test('active replacement work keeps job RUNNING despite historical failed tasks', () => {
  const old=task('old','FAILED'); const replacement=task('replacement','READY');
  assert.equal(schedule({...job([old,replacement]),state:'FAILED'}).state,'RUNNING');
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
test('healthy task states clear stale current errors without deleting history events', () => {
  for (const state of ['READY','RUNNING','SUCCEEDED']) {
    const current=task('state-'+state,'FAILED'); current.error='old failure';
    if (state==='RUNNING') current.state='READY';
    if (state==='SUCCEEDED') current.state='RUNNING';
    transitionTask(current,state);
    assert.equal(current.error,null);
  }
  const queued=task('queued-with-old-error','QUEUED'); queued.error='stale dependency error';
  const scheduled=schedule(job([queued]));
  assert.equal(scheduled.tasks[0].state,'READY');
  assert.equal(scheduled.tasks[0].error,null);
});
test('manual retry budget advances in three-attempt windows without resetting history', () => {
  assert.equal(extendRetryBudget({attempt:3,maxAttempts:3}),6);
  assert.equal(extendRetryBudget({attempt:5,maxAttempts:3}),6);
  assert.equal(extendRetryBudget({attempt:6,maxAttempts:6}),9);
  assert.equal(extendRetryBudget({attempt:8,maxAttempts:9}),12);
});
test('schedules dependencies but leaves BLOCKED manual', () => { const a=task('a','SUCCEEDED'); const b=task('b','BLOCKED',['a']); const c=task('c','QUEUED',['a']); const value=schedule(job([a,b,c])); assert.equal(b.state,'BLOCKED'); assert.equal(c.state,'READY'); assert.equal(value.state,'RUNNING'); });
test('detects cycles and requires successful dependencies', () => { assert.throws(() => detectCycles([task('a','QUEUED',['b']),task('b','QUEUED',['a'])]), /cycle/); assert.equal(dependencyReady(task('b','QUEUED',['a']),new Map([['a',task('a','RUNNING')]])),false); });
test('repository pool orders open jobs globally by durable priority', () => { const low={...job([]),id:'low',priority:'P3',createdAt:'2026-01-01T00:00:00.000Z'}; const high={...job([]),id:'high',priority:'P0',createdAt:'2026-02-01T00:00:00.000Z'}; assert.equal(compareJobPriority(high,low)<0,true); assert.deepEqual(runnableManagedJobs([{job:low,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null},{job:high,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null},{job:{...high,id:'merged'},githubState:'MERGED',draft:false,mergedAt:now(),closedAt:now()}]).map(x=>x.id),['high','low']); });
test('startup reconciliation selects expired durable RUNNING leases after daemon restart', () => {
  const expired=task('expired','RUNNING'); expired.leaseExpiresAt='2026-09-19T16:46:23.718Z';
  const live=task('live','RUNNING'); live.leaseExpiresAt='2026-09-19T17:10:00.000Z';
  assert.equal(needsLifecycleReconciliation(job([expired]),Date.parse('2026-09-19T16:59:20.000Z')),true);
  assert.equal(needsLifecycleReconciliation(job([live]),Date.parse('2026-09-19T16:59:20.000Z')),false);
});
test('completed jobs remain behind the runnable gate even if stale task data appears', () => { const review=task('review','QUEUED'); const completed={...job([review]),id:'completed-with-new-work',state:'COMPLETED'}; const item={job:completed,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null}; assert.deepEqual(runnableManagedJobs([item]),[]); });
test('failed jobs remain runnable so durable failed tasks can be recovered', () => { const failed={...job([]),id:'failed',state:'FAILED'}; const item={job:failed,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null}; assert.deepEqual(runnableManagedJobs([item]).map(x=>x.id),['failed']); });
test('draft managed PRs stay discoverable but are not runnable', () => { const held={...job([]),id:'held'}; const item={job:held,githubState:'OPEN',draft:true,mergedAt:null,closedAt:null}; assert.deepEqual(runnableManagedJobs([item]),[]); });
test('repository pool selects stale terminal jobs for lifecycle reconciliation', () => {
  const open={...job([]),id:'open'}; const merged={...job([]),id:'merged',state:'RUNNING'}; const completed={...job([]),id:'done',state:'COMPLETED'}; const closed={...job([]),id:'closed',state:'OPEN'};
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

test('repository pool routes correlated terminal events to the target reconciler', async () => {
  const bus=new MemoryEventBus();
  const calls=[];
  const client={request:async()=>{throw new Error('unexpected request');}};
  const pool=new RepositoryWorkerPool(client,['owner/repo'],new Set(['bot']),4,(_store,maxConcurrent)=>({
    reconcile:async id=>{calls.push({kind:'reconcile',id,maxConcurrent});},
    handleEvent:async event=>{calls.push({kind:'event',type:event.type,jobId:event.job_id,taskId:event.task_id,maxConcurrent});}
  }));
  const stop=await pool.watch(bus);
  await bus.publish(eventFor('job-2','task-2',null,'job.wake','queued','wake','orchestrator',{repository:'owner/repo',prNumber:43}));
  await bus.publish(eventFor('job-2','task-2',null,'task.completed','succeeded','done','orchestrator'));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(calls,[
    {kind:'reconcile',id:'job-2',maxConcurrent:4},
    {kind:'event',type:'task.completed',jobId:'job-2',taskId:'task-2',maxConcurrent:4}
  ]);
  await stop();
});

test('repository pool reconciles merged PRs even though they are not runnable', async () => {
  const root={...job([]),id:'merged-pool',state:'OPEN',prNumber:14};
  const comments=[{id:1,body:marker('agents-relay:job:v1',{...root,tasks:undefined}),updated_at:now(),user:{login:'bot'}}];
  const client=graphCommentClient(comments,14,'MERGED');
  const pool=new RepositoryWorkerPool(client,'owner/repo',new Set(['bot']),2,store=>new Reconciler(store,{owner:'test',adapters:[new FakeAdapter()]}));
  await pool.reconcile();
  const durable=comments.map(c=>c.body).map(body=>body.includes('agents-relay:job:v1') ? body : '').find(Boolean);
  assert.match(durable,/\"state\":\"COMPLETED\"/);
});
test('task priority orders ready work and inherits job priority', () => { const a=task('a'), b=task('b'), c=task('c'); a.priority='P3'; b.priority='P0'; a.createdAt='2026-01-01T00:00:00.000Z'; b.createdAt='2026-01-02T00:00:00.000Z'; c.createdAt='2025-01-01T00:00:00.000Z'; assert.deepEqual([a,b,c].sort((x,y)=>compareTaskPriority(x,y,'P1')).map(x=>x.id), ['b','c','a']); });
test('model task requires an event bus before launch', async () => {
  const t=task('no-events'); const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter();
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter]});
  await reconciler.reconcile('j');
  const durable=(await store.load('j')).tasks[0];
  assert.equal(adapter.launches,0);
  assert.equal(durable.state,'BLOCKED');
  assert.match(durable.error,/event bus/);
});

test('Relay publishes process launched and accepts only a worker-owned post-launch start acknowledgement', async () => {
  const t=task('chat-start'); t.adapter='chatgpt'; const store=new InMemoryStore(job([t])); const bus=new MemoryEventBus(); const events=[];
  const adapter={name:'chatgpt',id:'fake-chatgpt',capabilities:['model','chatgpt'],launch(_task,_signal,context){return {id:'chat-runtime',launched:Promise.resolve(),promise:(context.waitForWorkerStart ?? Promise.resolve()).then(()=>({summary:'submitted'})),cancel(){}};}};
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,startAckTimeoutMs:100});
  const stopEvents=await bus.subscribe('j',async event=>events.push(event));
  const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  assert.equal(events.some(event=>event.type==='task.started'),false);
  assert.equal(events.some(event=>event.type==='task.process.launched'),true);
  await bus.publish(eventFor('j','chat-start',null,'task.started','running','relay fake','user',{worker_owned:true},{agent:'relay',component:'agents-relay'}));
  assert.equal((await store.load('j')).tasks[0].state,'RUNNING');
  await bus.publish(eventFor('j','chat-start',null,'task.started','running','worker began','user',{worker_owned:true},{agent:'chatgpt'}));
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(events.some(event=>event.type==='task.process.async_exited'),true);
  await bus.publish(eventFor('j','chat-start',null,'task.completed','succeeded','durable output','user',undefined,{agent:'chatgpt'}));
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await store.load('j')).tasks[0].state,'SUCCEEDED');
  await stop(); await stopEvents();
});

test('after-start ChatGPT policy does not install a terminal close barrier', async () => {
  const t=task('chat-after-start'); t.adapter='chatgpt'; const store=new InMemoryStore(job([t])); const bus=new MemoryEventBus(); let terminalBarrier;
  const adapter={name:'chatgpt',id:'fake-chatgpt',capabilities:['model','chatgpt'],launch(_task,_signal,context){terminalBarrier=context.waitForTerminal; return {id:'chat-runtime',launched:Promise.resolve(),promise:(context.waitForWorkerStart ?? Promise.resolve()).then(()=>({summary:'submitted'})),cancel(){}};}};
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,startAckTimeoutMs:100,chatgptTabClosePolicy:'after-start'});
  const stop=await reconciler.watch('j'); await reconciler.reconcile('j');
  assert.equal(terminalBarrier,undefined);
  await bus.publish(eventFor('j','chat-after-start',null,'task.started','running','worker began','user',{worker_owned:true},{agent:'chatgpt'}));
  await bus.publish(eventFor('j','chat-after-start',null,'task.completed','succeeded','durable output','user',undefined,{agent:'chatgpt'}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await store.load('j')).tasks[0].state,'SUCCEEDED'); await stop();
});

test('ChatGPT start acknowledgement timeout is explicit and worker-owned', async () => {
  const t=task('chat-timeout'); t.adapter='chatgpt'; const store=new InMemoryStore(job([t])); const bus=new MemoryEventBus();
  const adapter={name:'chatgpt',id:'fake-chatgpt',capabilities:['model','chatgpt'],launch(_task,_signal,context){return {id:'chat-runtime',launched:Promise.resolve(),promise:(context.waitForWorkerStart ?? Promise.resolve()).then(()=>({summary:'submitted'})),cancel(){}};}};
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,startAckTimeoutMs:20});
  const stop=await reconciler.watch('j'); await reconciler.reconcile('j'); await new Promise(resolve=>setTimeout(resolve,50));
  const durable=(await store.load('j')).tasks[0]; assert.equal(durable.state,'FAILED'); assert.match(durable.error,/worker_start_timeout/); await stop();
});

test('ChatGPT reviewer uses the same start acknowledgement policy as normal ChatGPT tasks', async () => {
  const work=task('work','SUCCEEDED'); const store=new InMemoryStore({...job([work]),headSha:'sha-review-timeout'}); const bus=new MemoryEventBus();
  const adapter={name:'chatgpt',id:'fake-chatgpt',capabilities:['model','chatgpt'],launch(_task,_signal,context){return {id:'chat-runtime',launched:Promise.resolve(),promise:(context.waitForWorkerStart ?? Promise.resolve()).then(()=>({summary:'submitted'})),cancel(){}};}};
  const reviewer={adapter:'chatgpt',routing:{provider:'chatgpt',model:'account-defaults',decidedBy:'test',decidedAt:now()}};
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,startAckTimeoutMs:100,reviewer});
  const stop=await reconciler.watch('j'); await reconciler.reconcile('j'); await new Promise(resolve=>setTimeout(resolve,40));
  const created=(await store.load('j')).tasks.find(item=>item.agentName==='reviewer'); assert.equal(created?.state,'RUNNING');
  await bus.publish(eventFor('j',created.id,null,'task.started','running','review began','user',{worker_owned:true},{agent:'mcp'}));
  await bus.publish(eventFor('j',created.id,null,'task.completed','succeeded','review done','user',undefined,{agent:'chatgpt'}));
  await new Promise(resolve=>setTimeout(resolve,10)); await stop();
});

test('after-terminal ChatGPT tab close ignores stale and wrong-task terminal events', async () => {
  const t=task('chat-terminal'); t.adapter='chatgpt'; const store=new InMemoryStore(job([t])); const bus=new MemoryEventBus(); let released=false;
  const adapter={name:'chatgpt',id:'fake-chatgpt',capabilities:['model','chatgpt'],launch(_task,_signal,context){return {id:'chat-runtime',launched:Promise.resolve(),promise:(async()=>{await context.waitForWorkerStart; await context.waitForTerminal; released=true; return {summary:'submitted'};})(),cancel(){}};}};
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,startAckTimeoutMs:100,chatgptTabClosePolicy:'after-terminal'});
  const stop=await reconciler.watch('j'); await reconciler.reconcile('j');
  await bus.publish(eventFor('j','other',null,'task.completed','succeeded','wrong task','user'));
  await bus.publish({...eventFor('j','chat-terminal',null,'task.completed','succeeded','stale','user'),timestamp:new Date(0).toISOString()});
  assert.equal(released,false); assert.equal((await store.load('j')).tasks[0].state,'RUNNING');
  await bus.publish(eventFor('j','chat-terminal',null,'task.started','running','worker began','user',{worker_owned:true},{agent:'chatgpt'}));
  await bus.publish(eventFor('j','other',null,'task.failed','failed','wrong task','user'));
  assert.equal(released,false);
  await bus.publish(eventFor('j','chat-terminal',null,'task.completed','succeeded','durable output','user',undefined,{agent:'chatgpt'}));
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
    const reconciler = new Reconciler(store, { owner: 'test', adapters: [adapter], eventBus: bus, startAckTimeoutMs: 100 });
    const stop = await reconciler.watch('j');
    await reconciler.reconcile('j');
    const stale = new Date(0).toISOString();
    await bus.publish({ ...eventFor('j', 'chat-terminal', null, 'task.completed', 'succeeded', 'stale', 'user'), timestamp: stale });
    await bus.publish(eventFor('j', 'other-task', null, 'task.completed', 'succeeded', 'wrong task', 'user'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(released, false);
    assert.equal((await store.load('j')).tasks[0].state, 'RUNNING');
    await bus.publish(eventFor('j', 'chat-terminal', null, 'task.started', 'running', 'worker began', 'user', { worker_owned: true }, { agent: 'chatgpt' }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(released, false);
    await bus.publish(eventFor('j', 'chat-terminal', null, 'task.failed', 'failed', 'durable failure', 'user', undefined, { agent: 'chatgpt' }));
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
    const reconciler = new Reconciler(store, { owner: 'test', adapters: [adapter], eventBus: bus, startAckTimeoutMs: 100 });
    const stop = await reconciler.watch('j'); await reconciler.reconcile('j');
    await bus.publish(eventFor('j', 'chat-cancelled', null, 'task.started', 'running', 'worker began', 'user', { worker_owned: true }, { agent: 'chatgpt' }));
    await bus.publish(eventFor('j', 'chat-cancelled', null, 'task.cancelled', 'cancelled', 'cancelled by worker', 'user', undefined, { agent: 'chatgpt' }));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(released, true);
    assert.equal((await store.load('j')).tasks[0].state, 'CANCELLED');
    await stop();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('adapter runtime exit is not task completion', async () => {
  const t=task('runtime-exit'); const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus();
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
  const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  adapter.resolvers[0].resolve({summary:'process exited zero'});
  await reconciler.idle();
  assert.equal((await store.load('j')).tasks[0].state,'RUNNING');
  await stop();
});

test('normal terminal event remains authoritative when Codex exits afterward', async () => {
  const t=task('success-then-exit'); const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus(); const events=[];
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,terminalExitGraceMs:10});
  const stopEvents=await bus.subscribe('j',async event=>events.push(event)); const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  await bus.publish(eventFor('j','success-then-exit',null,'task.started','running','worker began','user'));
  await bus.publish(eventFor('j','success-then-exit',null,'task.completed','succeeded','durable output','user'));
  adapter.resolvers[0].resolve({summary:'runtime exited'});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal((await store.load('j')).tasks[0].state,'SUCCEEDED');
  assert.equal(events.filter(event=>event.type==='task.failed').length,0);
  assert.equal(events.filter(event=>event.type==='task.process.exited').length,1);
  await stop(); await stopEvents();
});

test('worker failure before Codex nonzero exit is not duplicated by the watchdog', async () => {
  const t=task('failed-then-exit'); const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus(); const events=[];
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,terminalExitGraceMs:10});
  const stopEvents=await bus.subscribe('j',async event=>events.push(event)); const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  await bus.publish(eventFor('j','failed-then-exit',null,'task.started','running','worker began','user'));
  await bus.publish(eventFor('j','failed-then-exit',null,'task.failed','failed','apply_patch could not be verified','user'));
  adapter.resolvers[0].reject(new Error('Codex exited 1'));
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal((await store.load('j')).tasks[0].state,'FAILED');
  assert.equal(events.filter(event=>event.type==='task.failed').length,1);
  await stop(); await stopEvents();
});

test('unexpected Codex exit after task.started fails after a short terminal grace window', async () => {
  const t=task('exit-without-terminal'); const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus(); const events=[];
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,terminalExitGraceMs:10});
  const stopEvents=await bus.subscribe('j',async event=>events.push(event)); const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  await bus.publish(eventFor('j','exit-without-terminal',null,'task.started','running','worker began','user'));
  adapter.resolvers[0].resolve({summary:'process exited'});
  await new Promise(resolve=>setTimeout(resolve,30));
  const durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'FAILED');
  assert.match(durable.error,/without publishing a terminal/);
  assert.equal(events.filter(event=>event.type==='task.failed').length,1);
  await stop(); await stopEvents();
});

test('Codex exit before task.started fails the lifecycle contract without waiting for task timeout', async () => {
  const t=task('exit-before-start'); t.timeoutMs=1000; const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus();
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,terminalExitGraceMs:10});
  const stop=await reconciler.watch('j'); await reconciler.reconcile('j'); adapter.resolvers[0].resolve({summary:'process exited'});
  await new Promise(resolve=>setTimeout(resolve,30));
  const durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'FAILED'); assert.match(durable.error,/before publishing task.started/); await stop();
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
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
  await reconciler.reconcile('j');
  await reconciler.idle();
  const durable=(await store.load('j')).tasks[0];
  assert.equal(durable.state,'FAILED');
  assert.match(durable.error,/Worker delivery failed/);
  assert.equal(events.some(event=>event.type==='task.failed' && event.data?.phase==='delivery'),true);
  await stop();
});


test('final review ignores explicitly superseded cancelled history', async () => {
  const succeeded=task('done','SUCCEEDED');
  const superseded=task('old','CANCELLED'); superseded.error='Superseded after objective split';
  const store=new InMemoryStore({...job([succeeded,superseded]),state:'COMPLETED',headSha:'abc1234567890'});
  const bus=new MemoryEventBus();
  const reconciler=new Reconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:bus,maxConcurrent:0,reviewer:{adapter:'chatgpt',routing:{provider:'chatgpt',model:'account-defaults',decidedBy:'test',decidedAt:now()}}});
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
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,startAckTimeoutMs:100,emit:event=>{events.push(event);}});
  await reconciler.reconcile('j'); await reconciler.idle(); await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(events.filter(event=>event.type==='task.failed').length,1);
  assert.equal((await store.load('j')).tasks[0].state,'FAILED');
});
test('late worker events recover a watchdog timeout failure', async () => {
  const t=task('late-worker','FAILED'); t.adapter='chatgpt'; t.error='Worker start-ack failed: worker_start_timeout'; t.failureReason='worker_start_timeout'; t.updatedAt='2026-09-20T20:00:00.000Z';
  const store=new InMemoryStore(job([t])); const reconciler=new Reconciler(store,{owner:'test',adapters:[new FakeAdapter()]});
  await reconciler.handleEvent({...eventFor('j','late-worker',null,'task.started','running','worker really started','user',{worker_owned:true},{agent:'chatgpt'}),timestamp:'2026-09-20T20:00:01.000Z'});
  assert.equal((await store.load('j')).tasks[0].state,'RUNNING');
  await reconciler.handleEvent({...eventFor('j','late-worker',null,'task.completed','succeeded','worker really completed','user',undefined,{agent:'chatgpt'}),timestamp:'2026-09-20T20:00:02.000Z'});
  const durable=(await store.load('j')).tasks[0]; assert.equal(durable.state,'SUCCEEDED'); assert.equal(durable.error,null);
});

test('late completed event directly recovers terminal timeout failure', async () => {
  const t=task('late-complete','FAILED'); t.adapter='chatgpt'; t.error='Task late-complete timed out waiting for the mandatory terminal worker event'; t.failureReason='terminal_event_timeout'; t.updatedAt='2026-09-20T20:00:00.000Z';
  const store=new InMemoryStore(job([t])); const reconciler=new Reconciler(store,{owner:'test',adapters:[new FakeAdapter()]});
  await reconciler.handleEvent({...eventFor('j','late-complete',null,'task.completed','succeeded','done after timeout','user',undefined,{agent:'chatgpt'}),timestamp:'2026-09-20T20:00:03.000Z'});
  assert.equal((await store.load('j')).tasks[0].state,'SUCCEEDED');
});

test('late events do not revive genuine failures or stale watchdog events', async () => {
  const genuine=task('genuine','FAILED'); genuine.adapter='chatgpt'; genuine.error='worker reported failure'; genuine.updatedAt='2026-09-20T20:00:00.000Z';
  const stale=task('stale','FAILED'); stale.adapter='chatgpt'; stale.error='Task stale timed out waiting for the mandatory terminal worker event'; stale.failureReason='terminal_event_timeout'; stale.updatedAt='2026-09-20T20:00:05.000Z';
  const store=new InMemoryStore(job([genuine,stale])); const reconciler=new Reconciler(store,{owner:'test',adapters:[new FakeAdapter()]});
  await reconciler.handleEvent({...eventFor('j','genuine',null,'task.started','running','late','user',undefined,{agent:'chatgpt'}),timestamp:'2026-09-20T20:00:01.000Z'});
  await reconciler.handleEvent({...eventFor('j','stale',null,'task.completed','succeeded','old completion','user',undefined,{agent:'chatgpt'}),timestamp:'2026-09-20T20:00:04.000Z'});
  const durable=await store.load('j'); assert.equal(durable.tasks[0].state,'FAILED'); assert.equal(durable.tasks[1].state,'FAILED');
});

test('correlated terminal completed event is authoritative', async () => {
  const t=task('event-complete'); const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus();
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
  const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  adapter.resolvers[0].resolve({summary:'runtime exited'});
  await bus.publish(eventFor('j','event-complete',null,'task.completed','succeeded','durable output written','orchestrator',{artifact:'PR'}));
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
      void bus.publish(eventFor('j',current.id,current.parentTaskId,'task.completed','succeeded','instant complete','orchestrator'));
      return {id:'runtime-id',promise:Promise.resolve({summary:'runtime exited'}),cancel(){}};
    }
  };
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
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
    const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
    const stop=await reconciler.watch('j');
    await reconciler.reconcile('j');
    await bus.publish(eventFor('j',type,null,type,type==='task.failed'?'failed':'blocked','terminal','user'));
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal((await store.load('j')).tasks[0].state,state);
    await stop();
  }
});

test('terminal event for another task cannot complete running work', async () => {
  const t=task('target'); const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus();
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
  const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  await bus.publish(eventFor('j','other',null,'task.completed','succeeded','wrong task','orchestrator'));
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await store.load('j')).tasks[0].state,'RUNNING');
  await bus.publish(eventFor('j','target',null,'task.completed','succeeded','right task','orchestrator'));
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await store.load('j')).tasks[0].state,'SUCCEEDED');
  await stop();
});

test('timeout produces explicit terminal-event failure when worker never reports terminal state', async () => {
  const t=task('timeout'); t.timeoutMs=20; const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const bus=new MemoryEventBus();
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus});
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
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus,continuations:[{kind:'command',continue:async input=>calls.push(input)}]});
  const stop=await reconciler.watch('j');
  await reconciler.reconcile('j');
  adapter.resolvers[0].resolve({summary:'runtime only'});
  await reconciler.idle();
  assert.equal(calls.length,0);
  await bus.publish(eventFor('j','child',null,'task.completed','succeeded','final result','orchestrator'));
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(calls,['final result']);
  await stop();
});

test('Codex launch requires routing metadata and applies command contract', () => {
  const t=task('model','READY'); delete t.routing;
  assert.throws(() => new CodexAdapter('definitely-not-started').launch(t, new AbortController().signal), /routing metadata/);
});

test('dashboard uses safe DOM rendering and named live events', () => { assert.equal(dashboardHtml.includes('innerHTML'),false); assert.equal(dashboardHtml.includes("addEventListener('relay'"),true); });
test('event bus wakes reconciliation and dashboard serves durable state', async () => { const store=new InMemoryStore(job([task('dash','SUCCEEDED')])); const bus=new MemoryEventBus(); const server=serveDashboard(store,0,bus,10000,'j'); await new Promise(resolve=>server.once('listening',resolve)); const address=server.address(); const port=typeof address==='object'&&address ? address.port : 0; const response=await fetch(`http://127.0.0.1:${port}/api/job`); assert.equal(response.status,200); assert.match(await response.text(),/dash/); server.close(); });
test('dashboard selected-job refresh serves the requested durable overview without a page reload', async () => { const selected={...job([task('selected','SUCCEEDED')]),id:'selected'}; const refreshed={...selected,tasks:[...selected.tasks,task('new-durable-task','QUEUED')]}; const store=new InMemoryStore(selected); const server=serveDashboard(store,0,undefined,10000,'selected',undefined,async()=>[{job:selected,githubState:'OPEN',draft:true,mergedAt:null,closedAt:null}],undefined,undefined,async id=>id==='selected'?refreshed:null); await new Promise(resolve=>server.once('listening',resolve)); const address=server.address(); const port=typeof address==='object'&&address ? address.port : 0; const response=await fetch(`http://127.0.0.1:${port}/api/job?id=selected`); assert.equal(response.status,200); const body=await response.text(); assert.match(body,/selected/); assert.match(body,/new-durable-task/); const missing=await fetch(`http://127.0.0.1:${port}/api/job?id=missing`); assert.equal(missing.status,404); server.close(); });


test('workspace webhook accepts configured repositories and forwards exact PR identity', async () => {
  const selected={...job([task('webhook-task','SUCCEEDED')]),id:'webhook-job',repository:'lalalic/agents-relay',prNumber:9};
  const store=new InMemoryStore(selected);
  const received=[];
  const secret='workspace-secret';
  const server=serveDashboard(store,0,undefined,10000,'webhook-job',undefined,async()=>[{job:selected,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null}],{secret,repositories:new Set(['lalalic/agents-relay','lalalic/neo']),wake:async event=>{received.push(event);}});
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
  const refreshed={...selected,tasks:[...selected.tasks,task('fresh-task','READY')]};
  const secret='workspace-secret'; let reconciliationFailed=false; let current=selected; let wakeResolve;
  const wakeDone=new Promise(resolve=>{wakeResolve=resolve;});
  const server=serveDashboard(new InMemoryStore(selected),0,undefined,300000,'webhook-job',undefined,async()=>[{job:current,githubState:'OPEN',draft:false,mergedAt:null,closedAt:null}],{secret,repositories:new Set(['lalalic/agents-relay']),refresh:async()=>{current=refreshed; return ['webhook-job'];},wake:async()=>{
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
  const server=serveDashboard(store,0,undefined,10000,'j'); await new Promise(resolve=>server.once('listening',resolve));
  const address=server.address(); const port=typeof address==='object'&&address?address.port:0;
  const response=await fetch(`http://127.0.0.1:${port}/api/job`); assert.equal(response.status,404); assert.match(await response.text(),/durable unavailable/);
  server.close();
});

test('dashboard usage failure returns 503 without double-sending headers', async () => {
  const store=new InMemoryStore(job()); const usageRegistry={snapshot:async()=>{throw new Error('usage unavailable');}};
  const server=serveDashboard(store,0,undefined,10000,'j',usageRegistry); await new Promise(resolve=>server.once('listening',resolve));
  const address=server.address(); const port=typeof address==='object'&&address?address.port:0;
  const response=await fetch(`http://127.0.0.1:${port}/api/usage`); assert.equal(response.status,503); assert.match(await response.text(),/usage unavailable/);
  server.close();
});


test('managed model worker input contains durable links without duplicating stored task input', async () => {
  const { managedWorkerInput } = await import('../dist/reconciler.js');
  const t=task('prompt-context'); t.adapter='chatgpt'; t.projectName='agents-relay'; t.parentTaskId='parent'; t.taskUrl='https://github.com/lalalic/agents-relay/pull/7#issuecomment-5754690474'; t.input='implement the change'; t.output={kind:'task_pr'};
  const root=job([t]); root.prNumber=7; root.repository='lalalic/agents-relay';
  const input=managedWorkerInput(root,t);
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
  const reconciler=new Reconciler(store,{owner:'test',adapters:[new FakeAdapter()]});
  const result=await reconciler.reconcile('j');
  assert.equal(result.state,'COMPLETED');
});

test('completed jobs create one SHA-bound reviewer task and suppress duplicates', async () => {
  const work = task('work', 'SUCCEEDED');
  const reviewJob = { ...job([work]), headSha: 'sha-review-1' };
  const store = new InMemoryStore(reviewJob);
  const bus = new MemoryEventBus();
  const adapter = new FakeAdapter();
  const reconciler = new Reconciler(store, { owner: 'test', adapters: [adapter], eventBus: bus, maxConcurrent: 0, reviewer: { adapter: 'chatgpt', routing: { provider: 'chatgpt', model: 'account-defaults', decidedBy: 'test', decidedAt: now() } } });
  await reconciler.reconcile('j');
  let saved = await store.load('j');
  assert.equal(saved.tasks.filter(item => item.agentName === 'reviewer').length, 1);
  const reviewer = saved.tasks.find(item => item.agentName === 'reviewer');
  assert.equal(reviewer?.reviewHeadSha, 'sha-review-1');
  assert.equal(reviewer?.adapter, 'chatgpt');
  assert.deepEqual(reviewer?.routing, { provider: 'chatgpt', model: 'account-defaults', decidedBy: 'test', decidedAt: reviewer?.routing?.decidedAt });
  assert.match(reviewer?.input ?? '', /publish task\.started.*worker_owned=true.*Emit review\.started/);
  await reconciler.reconcile('j');
  saved = await store.load('j');
  assert.equal(saved.tasks.filter(item => item.agentName === 'reviewer').length, 1);
});

test('no-review jobs complete without creating a reviewer task', async () => {
  const work=task('work','SUCCEEDED');
  const root={...job([work]),executionMode:'fixed',state:'RUNNING',headSha:'sha-no-review',reviewEnabled:false};
  const store=new InMemoryStore(root); store.pullRequestState=async()=> 'OPEN'; store.headSha=async()=> 'sha-no-review';
  const reconciler=new Reconciler(store,{owner:'test',adapters:[]});
  await reconciler.reconcile('j');
  const saved=await store.load('j');
  assert.equal(saved.state,'COMPLETED');
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

test('review changes-required creates exactly one Codex Luna fix task containing all findings', async () => {
  const reviewJob={...job([task('work','SUCCEEDED')]),headSha:'sha-fix-12345678'};
  const store=new InMemoryStore(reviewJob); const events=[];
  const reconciler=new Reconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:new MemoryEventBus(),maxConcurrent:0,emit:event=>events.push(event)});
  await reconciler.reconcile('j');
  const reviewer=(await store.load('j')).tasks.find(item=>item.agentName==='reviewer');
  assert.ok(reviewer);
  const payload={review:{headSha:'sha-fix-12345678',issues:['first bug','second bug',{summary:'third bug'}]}};
  await reconciler.handleEvent(eventFor('j',reviewer.id,null,'review.changes_required','failed','changes required','orchestrator',payload));
  let saved=await store.load('j');
  const fixes=saved.tasks.filter(item=>item.agentName==='review-fix');
  assert.equal(fixes.length,1);
  assert.equal(fixes[0].id,'review-fix-sha-fix-');
  assert.equal(fixes[0].adapter,'codex');
  assert.equal(fixes[0].routing?.model,'gpt-5.6-luna');
  assert.equal(fixes[0].routing?.reasoning,'medium');
  assert.deepEqual(fixes[0].dependencies,[reviewer.id]);
  assert.match(fixes[0].input,/1\. first bug/);
  assert.match(fixes[0].input,/2\. second bug/);
  assert.match(fixes[0].input,/3\. third bug/);
  assert.equal(saved.state,'RUNNING');
  assert.equal(events.filter(event=>event.type==='review.fix_task_created').length,1);
  await reconciler.handleEvent(eventFor('j',reviewer.id,null,'review.changes_required','failed','duplicate event','orchestrator',payload));
  saved=await store.load('j');
  assert.equal(saved.tasks.filter(item=>item.agentName==='review-fix').length,1);
});

test('review changes-required falls back to one fix task from the review message', async () => {
  const reviewJob={...job([task('work','SUCCEEDED')]),headSha:'fallback12345678'};
  const store=new InMemoryStore(reviewJob);
  const reconciler=new Reconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:new MemoryEventBus(),maxConcurrent:0});
  await reconciler.reconcile('j');
  const reviewer=(await store.load('j')).tasks.find(item=>item.agentName==='reviewer'); assert.ok(reviewer);
  await reconciler.handleEvent(eventFor('j',reviewer.id,null,'review.changes_required','failed','fix the race and add coverage','orchestrator',{review:{headSha:'fallback12345678'}}));
  const fixes=(await store.load('j')).tasks.filter(item=>item.agentName==='review-fix');
  assert.equal(fixes.length,1);
  assert.match(fixes[0].input,/fix the race and add coverage/);
});

test('approved review auto-merges by default and respects opt-out', async () => {
  for (const [autoMerge, expected] of [[undefined,1],[false,0]]) {
    const reviewJob={...job([task('work','SUCCEEDED')]),headSha:'sha-auto',autoMerge};
    const store=new InMemoryStore(reviewJob); let merges=0; let mergedSha=null;
    store.mergePullRequest=async sha=>{ merges+=1; mergedSha=sha; };
    const reconciler=new Reconciler(store,{owner:'test',adapters:[new FakeAdapter()],eventBus:new MemoryEventBus(),maxConcurrent:0});
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
  const reconciler = new Reconciler(store, { owner: 'test', adapters: [new FakeAdapter()], eventBus: bus, maxConcurrent: 0 });
  await reconciler.reconcile('j');
  const created = (await store.load('j')).tasks.find(item => item.agentName === 'reviewer');
  assert.ok(created);
  await reconciler.handleEvent(eventFor('j', created.id, null, 'review.started', 'running', 'started', 'orchestrator', { review: { headSha: 'sha-review-1', summary: 'gates passed', evidence: ['tests'] } }));
  assert.equal((await store.load('j')).review?.outcome, 'started');
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

test('open zero-task jobs remain create-only and do not consume reconciliation capacity', () => {
  const root = job([]);
  assert.equal(root.state, 'OPEN');
  assert.equal(needsLifecycleReconciliation(root), false);
  assert.deepEqual(root.tasks, []);
  assert.match(dashboardHtml, /Awaiting initial task/);
});

test('closed unmerged PR cancels queued work and job without launching', async () => {
  const t=task('closed-queued'); const store=new InMemoryStore(job([t])); store.pullRequestState=async()=> 'CLOSED'; const adapter=new FakeAdapter();
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter]}); const result=await reconciler.reconcile('j');
  assert.equal(result.state,'CANCELLED'); assert.equal(result.tasks[0].state,'CANCELLED'); assert.equal(result.tasks[0].error,'Pull request closed'); assert.equal(adapter.launches,0);
});
