import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTask, marker, TASK_MARKER } from '../dist/markers.js';
import { detectCycles, dependencyReady, schedule } from '../dist/scheduler.js';
import { CodexAdapter } from '../dist/adapters.js';
import { InMemoryStore, GitHubStore } from '../dist/store.js';
import { Reconciler } from '../dist/reconciler.js';
import { MemoryEventBus, subjectToken } from '../dist/events.js';
import { serveDashboard, dashboardHtml } from '../dist/dashboard.js';
import { discoverAgents } from '../dist/registry.js';

const now = () => new Date().toISOString();
const task = (id, state='QUEUED', dependencies=[]) => ({jobId:'j',id,parentTaskId:null,dependencies,capabilities:[],adapter:'shell',input:'true',state,attempt:0,maxAttempts:2,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:null,timeoutMs:1000,createdAt:now(),updatedAt:now(),continuation:null,continuationDeliveredAt:null});
const job = (tasks=[]) => ({id:'j',title:'x',prNumber:1,repository:'owner/repo',state:'OPEN',continuation:null,createdAt:now(),updatedAt:now(),tasks});
class FakeAdapter { name='shell'; id='fake'; capabilities=['shell']; launches=0; cancelled=0; resolvers=[]; launch(t, signal) { this.launches += 1; let resolvePromise; let rejectPromise; const promise = new Promise((resolve,reject) => { resolvePromise=resolve; rejectPromise=reject; }); this.resolvers.push({resolve:resolvePromise,reject:rejectPromise}); signal.addEventListener('abort', () => { this.cancelled += 1; rejectPromise(new Error('aborted')); }, {once:true}); return {id:`exec-${this.launches}`,promise,cancel:() => {this.cancelled += 1; rejectPromise(new Error('cancelled'));}}; } }
test('parses task marker JSON', () => { const t=task('a'); assert.equal(parseTask(marker(TASK_MARKER,t)).id,'a'); });
test('discovers by hard requirements and keeps evidence explainable', () => {
  const base = { id:'a', name:'A', responsibility:'research', role:'researcher', capabilities:['research'], boundaries:['no credentials'], endpoint:{kind:'adapter',target:'codex'}, runtime:{adapter:'codex'}, availability:'available', routing:{trustDomains:['public']}, evidence:{evaluations:[],outcomes:{succeeded:0,failed:0,timedOut:0},lastObservedAt:null}, registeredAt:now(), updatedAt:now() };
  const proven = { ...base, id:'proven', evidence:{...base.evidence, evaluations:[{taskKind:'research',outcome:'success',observedAt:now()}], outcomes:{succeeded:3,failed:1,timedOut:0}} };
  assert.deepEqual(discoverAgents([base, proven], { capabilities:['research'], runtime:'codex', trustDomain:'public', taskKind:'research' }).map(item => item.agent.id), ['proven','a']);
  assert.equal(discoverAgents([base], { capabilities:['missing'] }).length, 0);
  assert.equal(discoverAgents([base], { explore:true })[0].exploratory, true);
});
test('discovery filters labels, trust domains, regions, runtime, capabilities, and availability', () => {
  const base = { id:'match', name:'Match', responsibility:'research', role:'researcher', capabilities:['research','vision'], boundaries:[], endpoint:{kind:'adapter',target:'codex'}, runtime:{adapter:'codex'}, availability:'available', routing:{labels:{tier:'gold'},trustDomains:['public','internal'],regions:['ca','us']}, evidence:{evaluations:[],outcomes:{succeeded:0,failed:0,timedOut:0},lastObservedAt:null}, registeredAt:now(), updatedAt:now() };
  const offline = { ...base, id:'offline', availability:'offline' };
  assert.deepEqual(discoverAgents([base, offline], { capabilities:['research'], runtime:'codex', availability:['available','degraded'], labels:{tier:'gold'}, trustDomains:['public'], regions:['ca'] }).map(item => item.agent.id), ['match']);
  assert.equal(discoverAgents([base], { labels:{tier:'silver'} }).length, 0);
  assert.equal(discoverAgents([base], { trustDomains:['private'] }).length, 0);
  assert.equal(discoverAgents([base], { regions:['eu'] }).length, 0);
});
test('discovery applies security/runtime hard filters and excludes offline by default', () => {
  const base = { id:'safe', name:'Safe', responsibility:'research', role:'researcher', capabilities:['research'], boundaries:['public-only','no-credentials'], endpoint:{kind:'adapter',target:'codex'}, runtime:{adapter:'codex'}, availability:'available', routing:{trustDomains:['public'],regions:['ca']}, evidence:{evaluations:[],outcomes:{succeeded:0,failed:0,timedOut:0},lastObservedAt:null}, registeredAt:now(), updatedAt:now() };
  const offline = { ...base, id:'offline', availability:'offline' };
  const command = { ...base, id:'command', endpoint:{kind:'command',target:'worker'} };
  assert.deepEqual(discoverAgents([offline, command, base]).map(item => item.agent.id), ['command','safe']);
  assert.deepEqual(discoverAgents([base, command], { endpointKinds:['adapter'], requiredBoundaries:['no-credentials'], trustDomains:['public'], regions:['ca'] }).map(item => item.agent.id), ['safe']);
  assert.equal(discoverAgents([base], { requiredBoundaries:['private-data'] }).length, 0);
});

test('discovery ranks task-specific evidence and bounds exploration to one promoted candidate', () => {
  const base = { id:'new-a', name:'New A', responsibility:'research', role:'researcher', capabilities:['research'], boundaries:[], endpoint:{kind:'adapter',target:'codex'}, runtime:{adapter:'codex'}, availability:'available', routing:{trustDomains:['public']}, evidence:{evaluations:[],outcomes:{succeeded:0,failed:0,timedOut:0},lastObservedAt:null}, registeredAt:now(), updatedAt:now() };
  const newB = { ...base, id:'new-b' };
  const strong = { ...base, id:'strong', evidence:{evaluations:[{taskKind:'research',outcome:'success',observedAt:now()},{taskKind:'research',outcome:'success',observedAt:now()}],outcomes:{succeeded:4,failed:1,timedOut:0},lastObservedAt:now()} };
  const weak = { ...base, id:'weak', evidence:{evaluations:[{taskKind:'research',outcome:'failure',observedAt:now()}],outcomes:{succeeded:8,failed:2,timedOut:0},lastObservedAt:now()} };
  assert.deepEqual(discoverAgents([weak, newB, strong, base], { taskKind:'research' }).map(item => item.agent.id), ['strong','weak','new-a','new-b']);
  const explored = discoverAgents([weak, newB, strong, base], { taskKind:'research', explore:true });
  assert.deepEqual(explored.map(item => item.agent.id), ['strong','new-a','weak','new-b']);
  assert.match(explored[1].reasons.at(-1), /controlled exploration/);
  assert.equal(explored[0].ranking.taskKindSuccessRate, 1);
  assert.equal(explored[2].ranking.taskKindSuccessRate, 0);
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
test('CLI exposes agent namespace and legacy aliases with validation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-agent-cli-'));
  const file = join(directory, 'job.json');
  await writeFile(file, JSON.stringify(job([])));
  const run = async args => {
    const child = spawn(process.execPath, [join('dist', 'cli.js'), ...args], { cwd: process.cwd() });
    let stdout=''; let stderr=''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'exit'); return { code, stdout, stderr };
  };
  const list = await run(['agent','list','--file',file]);
  assert.equal(list.code,0); assert.deepEqual(JSON.parse(list.stdout),[]);
  const discover = await run(['agent','discover','--file',file]);
  assert.equal(discover.code,0); assert.deepEqual(JSON.parse(discover.stdout),[]);
  const legacyDiscover = await run(['agent-discover','--file',file]);
  assert.equal(legacyDiscover.code,0); assert.deepEqual(JSON.parse(legacyDiscover.stdout),[]);
  const registered = await run(['agent','register','--file',file,'--agent-id','test-agent','--name','Test','--responsibility','test','--role','tester','--endpoint','shell','--labels','tier=gold','--trust-domains','public,internal','--regions','ca,us']);
  assert.equal(registered.code,0); assert.match(registered.stdout,/Registered test-agent/);
  const legacyRegister = await run(['agent-register','--file',file,'--agent-id','legacy-agent','--name','Legacy','--responsibility','test','--role','tester','--endpoint','shell']);
  assert.equal(legacyRegister.code,0); assert.match(legacyRegister.stdout,/Registered legacy-agent/);
  const badAvailability = await run(['agent','register','--file',file,'--name','Bad','--responsibility','test','--role','tester','--endpoint','shell','--availability','unknown']);
  assert.equal(badAvailability.code,1); assert.match(badAvailability.stderr,/Invalid availability/);
  const badLabels = await run(['agent','register','--file',file,'--name','Bad','--responsibility','test','--role','tester','--endpoint','shell','--labels','broken']);
  assert.equal(badLabels.code,1); assert.match(badLabels.stderr,/key=value/);
  const badEndpointKind = await run(['agent','discover','--file',file,'--endpoint-kinds','socket']);
  assert.equal(badEndpointKind.code,1); assert.match(badEndpointKind.stderr,/Invalid endpoint kind/);
});

test('CLI submit stores optional project and agent metadata with parent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-task-metadata-'));
  const file = join(directory, 'job.json');
  await writeFile(file, JSON.stringify(job([])));
  const result = spawn(process.execPath, [join('dist', 'cli.js'), 'submit', '--file', file, '--task-id', 'child', '--parent', 'orchestrator', '--project', 'Agents Relay', '--agent', 'codex', '--input', 'build metadata'], { cwd: process.cwd() });
  const [code] = await once(result, 'exit');
  assert.equal(code, 0);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.tasks[0].projectName, 'Agents Relay');
  assert.equal(saved.tasks[0].agentName, 'codex');
  assert.equal(saved.tasks[0].parentTaskId, 'orchestrator');
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
test('schedules dependencies but leaves BLOCKED manual', () => { const a=task('a','SUCCEEDED'); const b=task('b','BLOCKED',['a']); const c=task('c','QUEUED',['a']); const value=schedule(job([a,b,c])); assert.equal(b.state,'BLOCKED'); assert.equal(c.state,'READY'); assert.equal(value.state,'RUNNING'); });
test('detects cycles and requires successful dependencies', () => { assert.throws(() => detectCycles([task('a','QUEUED',['b']),task('b','QUEUED',['a'])]), /cycle/); assert.equal(dependencyReady(task('b','QUEUED',['a']),new Map([['a',task('a','RUNNING')]])),false); });
test('reconciler launches asynchronously and concurrently', async () => { const a=task('a'), b=task('b'), c=task('c'); const store=new InMemoryStore(job([a,b,c])); const adapter=new FakeAdapter(); const reconciler=new Reconciler(store,{owner:'test',maxConcurrent:2,adapters:[adapter]}); const started=Date.now(); const state=await reconciler.reconcile('j'); assert.ok(Date.now()-started < 100); assert.equal(adapter.launches,2); assert.equal((await store.load('j')).tasks.filter(t=>t.state==='RUNNING').length,2); adapter.resolvers[0].resolve({summary:'a'}); adapter.resolvers[1].resolve({summary:'b'}); await new Promise(resolve=>setTimeout(resolve,30)); adapter.resolvers[2]?.resolve({summary:'c'}); await reconciler.idle(); const done=await store.load('j'); assert.equal(done.tasks.filter(t=>t.state==='SUCCEEDED').length,3); assert.equal(state.state,'RUNNING'); });
test('timeout cancels a live execution and persists terminal failure', async () => { const t=task('slow'); t.timeoutMs=10; t.maxAttempts=1; const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter]}); await reconciler.reconcile('j'); await reconciler.idle(); const result=(await store.load('j')).tasks[0]; assert.equal(adapter.cancelled > 0,true); assert.equal(result.state,'FAILED'); });
test('expired leases recover without awaiting worker work', async () => { const t=task('expired','RUNNING'); t.attempt=1; t.maxAttempts=2; t.executionId='old'; t.leaseExpiresAt=new Date(Date.now()-1000).toISOString(); const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],maxConcurrent:1}); await reconciler.reconcile('j'); assert.equal(adapter.launches,1); assert.equal((await store.load('j')).tasks[0].state,'RUNNING'); adapter.resolvers[0].resolve({summary:'recovered'}); await reconciler.idle(); });
test('capabilities are validated before dispatch', async () => { const t=task('cap'); t.capabilities=['gpu']; const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); await new Reconciler(store,{owner:'test',adapters:[adapter]}).reconcile('j'); assert.match((await store.load('j')).tasks[0].error,/lacks capabilities/); assert.equal(adapter.launches,0); });
test('Codex launch requires routing metadata and applies command contract', () => { assert.throws(() => new CodexAdapter('definitely-not-started').launch(task('model','READY'), new AbortController().signal), /routing metadata/); });
test('GitHubStore trusts only configured authors and persists through a fresh store', async () => { const comments=[]; const client={request:async (path,init={})=>{ if (!init.method) return comments; const body=JSON.parse(String(init.body)); if(init.method==='POST'){comments.push({id:comments.length+1,body:body.body,updated_at:now(),user:{login:'bot'}});return comments.at(-1);} const id=Number(path.split('/').at(-1)); comments.find(c=>c.id===id).body=body.body; return comments.find(c=>c.id===id); }}; const store=new GitHubStore(client,'owner/repo',1,new Set(['bot'])); await store.saveJob(job()); const forged=marker(TASK_MARKER,task('forged')); comments.push({id:99,body:forged,updated_at:now(),user:{login:'attacker'}}); const t=task('persist'); await store.appendTask(t); t.state='SUCCEEDED'; t.result={summary:'durable'}; await store.saveTask(t); const fresh=new GitHubStore(client,'owner/repo',1,new Set(['bot'])); const loaded=await fresh.load('j'); assert.equal(loaded.tasks.some(item=>item.id==='forged'),false); assert.equal(loaded.tasks.find(item=>item.id==='persist').result.summary,'durable'); });
test('GitHubStore paginates comments beyond the first page', async () => { const comments=Array.from({length:101},(_,index)=>({id:index+1,body:'ordinary',updated_at:now(),user:{login:'bot'}})); const root=job(); comments[0].body=marker('agents-relay:job:v1',{...root,tasks:undefined}); const client={request:async path=>{const page=Number(new URL(`https://x${path}`).searchParams.get('page')); return comments.slice((page-1)*100,page*100);}}; const store=new GitHubStore(client,'owner/repo',1,new Set(['bot'])); assert.equal((await store.load('j')).id,'j'); });
test('continuation delivery has a durable dedupe marker', async () => { const t=task('child'); t.continuation={kind:'command',target:'echo'}; const store=new InMemoryStore(job([t])); const calls=[]; const adapter=new FakeAdapter(); const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],continuations:[{kind:'command',continue:async input=>{calls.push(input);}}]}); await reconciler.reconcile('j'); adapter.resolvers[0].resolve({summary:'result'}); await reconciler.idle(); await reconciler.reconcile('j'); assert.equal(calls.length,1); assert.ok((await store.load('j')).tasks[0].continuationDeliveredAt); });
test('continuation failures remain retryable and succeed once', async () => { const t=task('retry-cont'); t.continuation={kind:'command',target:'echo'}; const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); let attempts=0; const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],continuations:[{kind:'command',continue:async()=>{attempts+=1;if(attempts<3)throw new Error('temporary');}}]}); await reconciler.reconcile('j'); adapter.resolvers[0].resolve({summary:'result'}); await reconciler.idle(); assert.equal((await store.load('j')).tasks[0].continuationDeliveredAt,null); await reconciler.reconcile('j'); await reconciler.idle(); assert.equal(attempts,3); assert.ok((await store.load('j')).tasks[0].continuationDeliveredAt); });
test('stale completion cannot delete a replacement execution', async () => { const t=task('race'); const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter(); const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter]}); await reconciler.reconcile('j'); const old=adapter.resolvers[0]; reconciler.live.delete('race'); const durable=await store.load('j'); durable.tasks[0].state='READY'; await store.saveTask(durable.tasks[0]); await reconciler.reconcile('j'); assert.equal(adapter.launches,2); old.resolve({summary:'old'}); await new Promise(resolve=>setTimeout(resolve,20)); assert.equal(reconciler.live.has('race'),true); adapter.resolvers[1].resolve({summary:'new'}); await reconciler.idle(); assert.equal((await store.load('j')).tasks[0].result.summary,'new'); });
test('thread id persists before a failed execution is retried', async () => {
  const t=task('thread-retry'); t.adapter='chatgpt'; t.capabilities=['model','chatgpt','macbridge']; t.routing={provider:'openai',model:'gpt-5-6'};
  const store=new InMemoryStore(job([t])); let launches=0; let retriedThreadId;
  const adapter={name:'chatgpt',id:'fake-chatgpt',capabilities:['model','chatgpt','macbridge'],launch(taskState){
    launches+=1; retriedThreadId=launches===2 ? taskState.threadId : retriedThreadId;
    let execution;
    const promise=launches===1 ? new Promise((resolve,reject)=>queueMicrotask(()=>{execution.threadId='persisted-chat-thread';execution.onThreadStarted?.('persisted-chat-thread');reject(new Error('transport failed after thread creation'));})) : Promise.resolve({summary:'continued same conversation'});
    execution={id:`chat-exec-${launches}`,promise,cancel:()=>{}}; return execution;
  }};
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter]});
  await reconciler.reconcile('j'); await reconciler.idle();
  const finished=await store.load('j');
  assert.equal(launches,2); assert.equal(retriedThreadId,'persisted-chat-thread'); assert.equal(finished.tasks[0].threadId,'persisted-chat-thread'); assert.equal(finished.tasks[0].state,'SUCCEEDED');
});
test('event transport failure is advisory', async () => { const t=task('event-fail'); const store=new InMemoryStore(job([t])); const bus={publish:async()=>{throw new Error('nats down');},subscribe:async()=>{throw new Error('nats down');}}; const adapter=new FakeAdapter(); const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],eventBus:bus}); await reconciler.watch('j'); await reconciler.reconcile('j'); adapter.resolvers[0].resolve({summary:'still works'}); await reconciler.idle(); assert.equal((await store.load('j')).tasks[0].state,'SUCCEEDED'); });
test('aggregate edge cases and NATS subject safety are explicit', () => { const empty=job(); assert.equal(schedule(empty).state,'OPEN'); const cancelled=job([task('x','CANCELLED')]); assert.equal(schedule(cancelled).state,'CANCELLED'); assert.throws(()=>subjectToken('bad.id'),/Unsafe/); assert.equal(subjectToken('safe_job-1'),'safe_job-1'); });
test('live task leases do not expire before their timeout', async () => {
  const startedBeforeLaunch=Date.now(); const t=task('long'); t.timeoutMs=500; const store=new InMemoryStore(job([t])); const adapter=new FakeAdapter();
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter],leaseMs:20});
  await reconciler.reconcile('j');
  await new Promise(resolve=>setTimeout(resolve,30));
  const running=await reconciler.reconcile('j'); const taskState=running.tasks[0];
  assert.equal(adapter.launches,1); assert.equal(running.state,'RUNNING'); assert.equal(taskState.attempt,1);
  assert.ok(new Date(taskState.leaseExpiresAt).getTime() >= startedBeforeLaunch+taskState.timeoutMs);
  adapter.resolvers[0].resolve({summary:'finished'});
  await reconciler.idle();
  const finished=await store.load('j');
  assert.equal(finished.tasks[0].state,'SUCCEEDED'); assert.equal(finished.tasks[0].attempt,1);
});
test('dashboard uses safe DOM rendering and named live events', () => { assert.equal(dashboardHtml.includes('innerHTML'),false); assert.equal(dashboardHtml.includes("addEventListener('relay'"),true); });
test('event bus wakes reconciliation and dashboard serves durable state', async () => { const store=new InMemoryStore(job([task('dash','SUCCEEDED')])); const bus=new MemoryEventBus(); const server=serveDashboard(store,0,bus,10000,'j'); await new Promise(resolve=>server.once('listening',resolve)); const address=server.address(); const port=typeof address==='object'&&address ? address.port : 0; const response=await fetch(`http://127.0.0.1:${port}/api/job`); assert.equal(response.status,200); assert.match(await response.text(),/dash/); server.close(); });

test('managed model worker input includes durable PR context without changing stored task input', async () => {
  const { managedWorkerInput } = await import('../dist/reconciler.js');
  const t=task('prompt-context'); t.adapter='chatgpt'; t.projectName='agents-relay'; t.parentTaskId='parent'; t.input='implement the change';
  const root=job([t]); root.prNumber=7; root.repository='lalalic/agents-relay';
  const input=managedWorkerInput(root,t);
  assert.match(input,/PR: https:\/\/github\.com\/lalalic\/agents-relay\/pull\/7/);
  assert.match(input,/Job: j/);
  assert.match(input,/Task: prompt-context/);
  assert.match(input,/Parent task: parent/);
  assert.match(input,/Project: agents-relay/);
  assert.match(input,/implement the change$/);
  assert.equal(t.input,'implement the change');
  const shell=task('shell-context'); shell.input='printf ok';
  assert.equal(managedWorkerInput(root,shell),'printf ok');
});

test('completed jobs delete each ChatGPT task thread once and retain durable thread ids', async () => {
  const a=task('chat-a','SUCCEEDED'); a.adapter='chatgpt'; a.threadId='thread-a';
  const b=task('chat-b','SUCCEEDED'); b.adapter='chatgpt'; b.threadId='thread-b';
  const c=task('shell-done','SUCCEEDED'); c.threadId='local-thread';
  const store=new InMemoryStore(job([a,b,c])); const deleted=[];
  const adapter={name:'chatgpt',id:'fake-chatgpt',capabilities:['model','chatgpt','macbridge'],launch(){throw new Error('not launched');},deleteThread:async id=>{deleted.push(id);}};
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter]});
  const completed=await reconciler.reconcile('j');
  assert.equal(completed.state,'COMPLETED');
  assert.deepEqual(deleted,['thread-a','thread-b']);
  assert.equal(completed.tasks[0].threadId,'thread-a'); assert.ok(completed.tasks[0].threadDeletedAt);
  assert.equal(completed.tasks[1].threadId,'thread-b'); assert.ok(completed.tasks[1].threadDeletedAt);
  assert.equal(completed.tasks[2].threadDeletedAt,undefined);
  await reconciler.reconcile('j');
  assert.deepEqual(deleted,['thread-a','thread-b']);
});

test('failed terminal thread cleanup is durable and retried without reopening the job', async () => {
  const t=task('cleanup-retry','SUCCEEDED'); t.adapter='chatgpt'; t.threadId='thread-retry-delete';
  const store=new InMemoryStore(job([t])); let attempts=0;
  const adapter={name:'chatgpt',id:'fake-chatgpt',capabilities:['model','chatgpt','macbridge'],launch(){throw new Error('not launched');},deleteThread:async()=>{attempts+=1;if(attempts===1)throw new Error('delete transport down');}};
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter]});
  const first=await reconciler.reconcile('j');
  assert.equal(first.state,'COMPLETED'); assert.equal(first.tasks[0].threadCleanupError,'delete transport down'); assert.equal(first.tasks[0].threadDeletedAt,undefined);
  const second=await reconciler.reconcile('j');
  assert.equal(second.state,'COMPLETED'); assert.equal(second.tasks[0].threadCleanupError,null); assert.ok(second.tasks[0].threadDeletedAt); assert.equal(attempts,2);
});

test('merged PR cancels unfinished work and deletes existing ChatGPT threads', async () => {
  const t=task('merged-active','RUNNING'); t.adapter='chatgpt'; t.threadId='thread-merged'; t.executionId='orphan';
  const store=new InMemoryStore(job([t])); store.pullRequestState=async()=> 'MERGED'; const deleted=[];
  const adapter={name:'chatgpt',id:'fake-chatgpt',capabilities:['model','chatgpt','macbridge'],launch(){throw new Error('not launched');},deleteThread:async id=>{deleted.push(id);}};
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter]});
  const result=await reconciler.reconcile('j');
  assert.equal(result.tasks[0].state,'CANCELLED'); assert.equal(result.tasks[0].error,'Pull request merged'); assert.deepEqual(deleted,['thread-merged']); assert.ok(result.tasks[0].threadDeletedAt);
});


test('merged zero-task PR becomes COMPLETED even when scheduler would leave it OPEN', async () => {
  const root=job([]); const store=new InMemoryStore(root); store.pullRequestState=async()=> 'MERGED';
  const reconciler=new Reconciler(store,{owner:'test',adapters:[new FakeAdapter()]});
  const result=await reconciler.reconcile('j');
  assert.equal(result.state,'COMPLETED');
});

test('closed unmerged PR cancels queued work and job without launching', async () => {
  const t=task('closed-queued'); const store=new InMemoryStore(job([t])); store.pullRequestState=async()=> 'CLOSED'; const adapter=new FakeAdapter();
  const reconciler=new Reconciler(store,{owner:'test',adapters:[adapter]}); const result=await reconciler.reconcile('j');
  assert.equal(result.state,'CANCELLED'); assert.equal(result.tasks[0].state,'CANCELLED'); assert.equal(result.tasks[0].error,'Pull request closed'); assert.equal(adapter.launches,0);
});
