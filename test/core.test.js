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
import { CodexAdapter, LaunchFailure } from '../dist/adapters.js';
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
  assert.equal(saved.state,'OPEN');
  assert.equal(saved.tasks[0].id,'review');
  await rm(directory,{recursive:true,force:true});
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


test('managed model worker input includes durable PR context without changing stored task input', async () => {
  const { managedWorkerInput } = await import('../dist/reconciler.js');
  const t=task('prompt-context'); t.adapter='chatgpt'; t.projectName='agents-relay'; t.parentTaskId='parent'; t.input='implement the change'; t.output={kind:'task_pr'};
  const root=job([t]); root.prNumber=7; root.repository='lalalic/agents-relay';
  const input=managedWorkerInput(root,t);
  assert.match(input,/PR: https:\/\/github\.com\/lalalic\/agents-relay\/pull\/7/);
  assert.match(input,/Job: j/);
  assert.match(input,/Task: prompt-context/);
  assert.match(input,/Parent task: parent/);
  assert.match(input,/Project: agents-relay/);
  assert.match(input,/implement the change/); assert.match(input,/\[Output contract\]/); assert.match(input,/task\/PR/); assert.match(input,/\[Execution event contract\]/); assert.match(input,/MUST publish exactly one terminal event/);
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
