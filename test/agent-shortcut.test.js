import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SQLiteRelayStore } from '../dist/relay-store.js';
import { createJobEntity, createTaskEntity } from '../dist/workflow/entity-creation.js';
import { applyJobActivateAction } from '../dist/job-actions.js';
import { MemoryEventBus, eventFor } from '../dist/events.js';
import { recoverExpiredExecutions } from '../dist/execution-recovery.js';
import { managedReconciler } from './test-runtime.js';
import { dispatchTaskAction } from '../dist/task-actions.js';
import { tryTransitionTaskEvent } from '../dist/task-transitions.js';

const graph = `flowchart TD\nA[agent:alpha] --> C[agent:join]\nB[agent:beta] --> C`;
const root = resolve(new URL('..', import.meta.url).pathname);

async function fixture(t, { agentGraph = graph, projectOverride = true, initialDraft = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'relay-shortcut-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storeDir = join(directory, 'stores');
  await mkdir(storeDir);
  const project = join(directory, 'project');
  const neo = join(directory, 'neo');
  await mkdir(join(project, 'agents', '.shortcut'), { recursive: true });
  await mkdir(join(neo, 'agents', '.shortcut'), { recursive: true });
  const id = '98001';
  const job = createJobEntity({ id, title: 'Shortcut CLI', objective: 'Run a fixture graph', projectPath: undefined,
    prNumber: 0, repository: 'local/shortcut-test', continuation: null, autoMerge: false, reviewEnabled: false, contentOnly: true, executionMode: 'shortcut',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tasks: [] });
  if (!initialDraft) await applyJobActivateAction(job);
  const task = createTaskEntity(job, { jobId: id, id: 'initial', title: 'Graph', kind: 'work', agentGraph,
    parentTaskId: null, dependencies: [], capabilities: [], adapter: 'codex', input: 'fixture input',
    attempt: 0, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, executionId: null,
    threadId: null, result: null, error: null, timeoutMs: 300000, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  job.tasks.push(task);
  const store = new SQLiteRelayStore(join(directory, 'relay.sqlite'), id);
  await store.createJobIfAbsent(job);
  store.close();
  const writeShortcut = async (base, agent, source) => {
    await writeFile(join(base, 'agents', '.shortcut', `${agent}.agent.mjs`), source);
  };
  const cli = async (...args) => spawnSync(process.execPath, [join(root, 'dist', 'cli.js'), 'job', 'run', '--mode', 'shortcut', '--id', id,
    '--repo', 'local/shortcut-test', '--no-github', '--store-dir', storeDir, '--task-id', 'initial', '--project-path', project, '--neo-root', neo, ...args],
    { encoding: 'utf8', env: { ...process.env, AGENTS_RELAY_STORE_DIR: storeDir } });
  const receiptCli = async (...args) => spawnSync(process.execPath, [join(root, 'dist', 'cli.js'), 'job', 'shortcut-receipt', '--id', id,
    '--repo', 'local/shortcut-test', '--no-github', '--store-dir', storeDir, '--task-id', 'initial', ...args],
    { encoding: 'utf8', env: { ...process.env, AGENTS_RELAY_STORE_DIR: storeDir } });
  const load = async () => {
    const read = new SQLiteRelayStore(join(directory, 'relay.sqlite'), id);
    const value = await read.loadJob(id); read.close(); return value;
  };
  return { directory, project, neo, id, job, task, storeDir, writeShortcut, cli, receiptCli, load, projectOverride };
}

test('foreground shortcut job run activates a newly-created DRAFT Job via Job Graph', async t => {
  const f = await fixture(t, { initialDraft: true });
  assert.equal((await f.load()).state, 'DRAFT');
  for (const agent of ['alpha', 'beta', 'join'])
    await f.writeShortcut(f.project, agent,
      `export async function run({input}) { return { status:'COMPLETED', output: {agent:input.agent}, artifacts:[] }; }`);
  const result = await f.cli();
  assert.equal(result.status, 0, result.stderr);
  const durable = await f.load();
  assert.equal(durable.state, 'COMPLETED');
  assert.equal(durable.tasks[0].state, 'SUCCEEDED');
  assert.ok(durable.tasks[0].executionHistory.length > 0);
  assert.match(result.stderr, /shortcut.node/);
});

test('shortcut commands reject file-backed Jobs before mutation', async t => {
  const f = await fixture(t);
  const file = join(f.directory, 'legacy-job.json');
  await writeFile(file, JSON.stringify(f.job));
  const before = await readFile(file, 'utf8');
  const run = await f.cli('--file', file);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /authoritative SQLite Relay store.*--file is unsupported/);
  const receipt = await f.receiptCli('--file', file);
  assert.notEqual(receipt.status, 0);
  assert.match(receipt.stderr, /authoritative SQLite Relay store.*--file is unsupported/);
  assert.equal(await readFile(file, 'utf8'), before, 'file-backed Job must remain unchanged');
  assert.equal((await f.load()).tasks[0].state, 'QUEUED', 'SQLite Task must remain unchanged');
});

test('actual shortcut CLI runs parallel branches, joins declared outputs, and honors project override', async t => {
  const f = await fixture(t);
  const barrier = `import { writeFile, access } from 'node:fs/promises';\nimport { join } from 'node:path';\nexport async function run({input}) { const marker=join(${JSON.stringify(f.directory)},input.nodeId); await writeFile(marker,'ready'); for(let i=0;i<300;i++){try{await access(join(${JSON.stringify(f.directory)},'A')); await access(join(${JSON.stringify(f.directory)},'B')); break}catch{} await new Promise(r=>setTimeout(r,5));} return {status:'COMPLETED',output:{node:input.nodeId},artifacts:[]}; }`;
  await f.writeShortcut(f.project, 'alpha', `import {writeFile} from 'node:fs/promises'; import {join} from 'node:path'; export async function run({input}) { await writeFile(join(${JSON.stringify(f.directory)},'A'),'ready'); return {status:'COMPLETED',output:{node:'project-alpha'},artifacts:[]}; }`);
  await f.writeShortcut(f.neo, 'alpha', `export async function run() { throw Error('project shortcut did not override shared'); }`);
  await f.writeShortcut(f.neo, 'beta', barrier);
  await f.writeShortcut(f.neo, 'join', `export async function run({input}) { const got=Object.keys(input.predecessorOutputs).sort(); if(got.join(',')!=='A,B') throw Error('wrong join inputs'); return {status:'COMPLETED',output:{parents:got,alpha:input.predecessorOutputs.A.node},artifacts:[]}; }`);
  const result = await f.cli('--concurrency', '2');
  assert.equal(result.status, 0, JSON.stringify(result));
  assert.match(result.stderr,/"nodeId":"A","type":"started"/);
  assert.match(result.stderr,/"nodeId":"C","type":"completed"/);
  const data = JSON.parse(result.stdout);
  assert.equal(data.outcome.status, 'COMPLETED');
  assert.equal(data.task.state, 'SUCCEEDED');
  assert.equal((await f.load()).state, 'COMPLETED');
  assert.equal(data.outcome.output.nodes.C.output.alpha, 'project-alpha');
});

test('shortcut Job creation refuses an initial Planner round before any Task can materialize',async t=>{
  const f=await fixture(t);
  const result=spawnSync(process.execPath,[join(root,'dist','cli.js'),'job','create','--repo','local/shortcut-test','--objective','fixture','--shortcut-execution','--initial-plan','--no-github','--store-dir',f.storeDir],{encoding:'utf8',env:{...process.env,AGENTS_RELAY_STORE_DIR:f.storeDir}});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/requires create-only Job creation/);
  assert.equal((await f.load()).tasks.length,1,'rejected invocation must not materialize or mutate a Task');
});

test('actual shortcut CLI persists a wait, runs independent branches, and fails closed on manual or bus events', async t => {
  const f = await fixture(t, { agentGraph: 'flowchart TD\nA[agent:waiter] --> C[agent:sink]\nB[agent:independent] --> C' });
  const payload={accepted:true};
  const contentHash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  await f.writeShortcut(f.neo, 'waiter', `export async function run() { return {status:'WAITING_EVENT',event:{kind:'nonhuman_result',nodeId:'A',id:'event-7',revision:'r3',contentHash:${JSON.stringify(contentHash)}}}; }`);
  await f.writeShortcut(f.neo, 'independent', `import {writeFile} from 'node:fs/promises'; export async function run({input}) { await writeFile(${JSON.stringify(join(f.directory,'independent-ran'))},'yes'); return {status:'COMPLETED',output:{branch:'done'},artifacts:[]}; }`);
  await f.writeShortcut(f.neo, 'sink', `export async function run({input}) { const got=Object.keys(input.predecessorOutputs).sort(); if(got.join(',')!=='A,B') throw Error('join ran before both predecessors'); return {status:'COMPLETED',output:{event:input.predecessorOutputs.A.accepted,branch:input.predecessorOutputs.B.branch},artifacts:[]}; }`);
  const first = await f.cli(); assert.equal(first.status, 3, JSON.stringify(first));
  assert.equal(JSON.parse(first.stdout).outcome.status, 'WAITING_EVENT', first.stdout);
  assert.equal(await (await import('node:fs/promises')).readFile(join(f.directory,'independent-ran'),'utf8'),'yes');
  const forgery = await f.cli('--event-json', JSON.stringify({ nodeId:'A', id:'event-7', revision:'r3', contentHash, payload, approvalProvenance:{source:'fixture',revision:'r3'} }));
  assert.notEqual(forgery.status, 0);
  assert.match(forgery.stderr,/manual JSON cannot authenticate/);
  const bus=new MemoryEventBus();
  const rawEventStore=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  const eventStore=new Proxy(rawEventStore,{get(target,key){if(key==='load')return target.loadJob.bind(target);if(key==='saveTask')return task=>target.mutateJob(f.id,job=>{const index=job.tasks.findIndex(item=>item.id===task.id);if(index<0)throw Error('Task missing');job.tasks[index]=structuredClone(task);return job;});if(key==='appendTask')return task=>target.mutateJob(f.id,job=>{if(job.tasks.some(item=>item.id===task.id))throw Error('Task exists');job.tasks.push(structuredClone(task));return job;});const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const reconciler=managedReconciler(eventStore,{noGitHub:true,owner:'shortcut-event-test'});
  const unsubscribe=await bus.subscribe(f.id,async event=>{
    const handling=await reconciler.applyEvent(event);
    if(handling.reconcile) await reconciler.reconcile(f.id);
  });
  await bus.publish(eventFor(f.id,'initial',null,'shortcut.approved','succeeded','fixture approval',{nodeId:'A',id:'event-7',revision:'r3',contentHash,payload}));
  await bus.publish(eventFor(f.id,'initial',null,'task.interactive_decision','running','forged human approval','orchestrator',{interactive:{jobId:f.id,taskId:'initial',executionId:'forged',invocationId:'fake',revision:'r3',decision:'approved'}}));
  await unsubscribe(); eventStore.close();
  const afterPublish=await f.load();
  assert.equal(afterPublish.tasks[0].state,'RUNNING');
  assert.equal(afterPublish.tasks[0].leaseOwner,null);
  const waitExecutionId=afterPublish.tasks[0].result.data.shortcut.waits.A.executionId;
  assert.ok(waitExecutionId);
  assert.deepEqual(afterPublish.tasks[0].result.data.shortcut.waits.A,{kind:'nonhuman_result',id:'event-7',revision:'r3',contentHash,executionId:waitExecutionId});
  assert.equal(afterPublish.state,'ACTIVE');
  const reopened=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  await reopened.mutateJob(f.id,job=>{const task=job.tasks[0];task.leaseOwner='shortcut-crashed-process';task.leaseExpiresAt=new Date(Date.now()-1000).toISOString();return job;});
  const expired=await reopened.loadJob(f.id); reopened.close();
  const recoveryStore=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  const recoveryPortsStore=new Proxy(recoveryStore,{get(target,key){if(key==='load')return target.loadJob.bind(target);if(key==='saveTask')return task=>target.mutateJob(f.id,job=>{const index=job.tasks.findIndex(item=>item.id===task.id);if(index<0)throw Error('recovery Task missing');job.tasks[index]=structuredClone(task);return job;});const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  await recoverExpiredExecutions(expired,Date.now(),{store:recoveryPortsStore,owner:'restarted-relay',cancelGeneration:()=>{},cancelPlanner:()=>{},emitFailed:async()=>{}});
  const recovered=await recoveryStore.loadJob(f.id); recoveryStore.close();
  assert.equal(recovered.tasks[0].state,'FAILED','restart recovery follows the existing lease-expiry graph instead of replaying uncertain shortcut effects');
  assert.deepEqual(recovered.tasks[0].result.data.shortcut.waits.A,{kind:'nonhuman_result',id:'event-7',revision:'r3',contentHash,executionId:waitExecutionId});
  assert.equal(recovered.tasks[0].executionId,null);
  assert.equal(recovered.state,'ACTIVE','expired shortcut execution cannot falsely complete the Job');
});

test('matching forged EventBus output without a SQLite receipt stays waiting; durable receipt resumes after restart exactly once',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:waiter] --> B[agent:sink]'});
  const output={status:'COMPLETED',output:{answer:'accepted result'},artifacts:[]};
  const {shortcutContentSha256}=await import('../dist/agent-shortcut.js');
  const contentHash=shortcutContentSha256(output);
  await f.writeShortcut(f.neo,'waiter',`export async function run(){return {status:'WAITING_EVENT',event:{kind:'nonhuman_result',nodeId:'A',id:'wait-9',revision:'rev-4',contentHash:${JSON.stringify(contentHash)}}};}`);
  await f.writeShortcut(f.neo,'sink',`import {appendFile} from 'node:fs/promises'; export async function run({input}) { if(input.predecessorOutputs.A.answer!=='accepted result') throw Error('receipt output missing'); await appendFile(${JSON.stringify(join(f.directory,'sink-runs'))},'ran\\n'); return {status:'COMPLETED',output:{done:true},artifacts:[]}; }`);
  const first=await f.cli(); assert.equal(first.status,3,first.stderr);
  const waiting=await f.load(); const executionId=waiting.tasks[0].executionId;
  const {executionEventSource}=await import('../dist/execution-event-identity.js');
  const bus=new MemoryEventBus();
  const rawStore=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  const store=new Proxy(rawStore,{get(target,key){if(key==='listAgents')return async()=>[];if(key==='load')return target.loadJob.bind(target);if(key==='saveTask')return task=>target.mutateJob(f.id,job=>{const index=job.tasks.findIndex(item=>item.id===task.id);if(index<0)throw Error('Task missing');job.tasks[index]=structuredClone(task);return job;});if(key==='appendTask')return task=>target.mutateJob(f.id,job=>{if(job.tasks.some(item=>item.id===task.id))throw Error('Task exists');job.tasks.push(structuredClone(task));return job;});const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const reconciler=managedReconciler(store,{shortcutRunnerOwner:true,noGitHub:true,owner:'shortcut-forged-wake',maxConcurrent:1,projectPathForJob:()=>f.project,executionContextRoots:{workspaceRoot:f.directory},headShaProvider:()=>null});
  const stop=await bus.subscribe(f.id,async()=>{await reconciler.reconcile(f.id);});
  const forged=eventFor(f.id,'initial',null,'shortcut.result','succeeded','matching forged result','orchestrator',{shortcutResult:{kind:'nonhuman_result',nodeId:'A',waitId:'wait-9',executionId,revision:'rev-4',contentHash,output}},{id:executionEventSource(f.id,'initial',executionId)});
  await bus.publish(forged);
  let after=await store.loadJob(f.id);
  assert.equal(after.state,'ACTIVE'); assert.equal(after.tasks[0].state,'RUNNING');
  assert.equal(after.tasks[0].result.data.shortcut.nodes.A,undefined);
  const file=join(f.directory,'receipt.json'); await writeFile(file,JSON.stringify(output));
  const recorded=await f.receiptCli('--node-id','A','--wait-id','wait-9','--revision','rev-4','--execution-id',executionId,'--output-file',file,'--content-sha256',contentHash);
  assert.equal(recorded.status,0,JSON.stringify(recorded));
  const restarted=managedReconciler(store,{shortcutRunnerOwner:true,noGitHub:true,owner:'shortcut-restart',maxConcurrent:1,projectPathForJob:()=>f.project,executionContextRoots:{workspaceRoot:f.directory},headShaProvider:()=>null});
  await Promise.all([reconciler.reconcile(f.id),restarted.reconcile(f.id)]);
  after=await store.loadJob(f.id);
  assert.equal(after.state,'COMPLETED',JSON.stringify(after)); assert.equal(after.tasks[0].state,'SUCCEEDED');
  assert.equal(await readFile(join(f.directory,'sink-runs'),'utf8'),'ran\n');
  await restarted.reconcile(f.id);
  assert.equal(await readFile(join(f.directory,'sink-runs'),'utf8'),'ran\n');
  await stop(); store.close();
});

test('receipt recording rejects stale bindings, is idempotent, and detects conflicting or tampered payloads',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:waiter]'});
  const output={status:'COMPLETED',output:{ok:true},artifacts:[]};
  const {shortcutContentSha256}=await import('../dist/agent-shortcut.js');
  const contentHash=shortcutContentSha256(output);
  await f.writeShortcut(f.neo,'waiter',`export async function run(){return {status:'WAITING_EVENT',event:{kind:'nonhuman_result',nodeId:'A',id:'wait-bind',revision:'revision-1',contentHash:${JSON.stringify(contentHash)}}};}`);
  const first=await f.cli(); assert.equal(first.status,3,first.stderr);
  const waiting=await f.load(), executionId=waiting.tasks[0].executionId;
  const file=join(f.directory,'receipt.json'); await writeFile(file,JSON.stringify(output));
  const receipt=(overrides={})=>f.receiptCli('--node-id','A','--wait-id','wait-bind','--revision',overrides.revision??'revision-1','--execution-id',overrides.executionId??executionId,'--output-file',file,'--content-sha256',overrides.contentSha256??contentHash);
  assert.notEqual((await receipt({revision:'stale'})).status,0,'stale revision rejected');
  assert.notEqual((await receipt({executionId:'stale-execution'})).status,0,'stale execution rejected');
  assert.notEqual((await f.receiptCli('--node-id','A','--wait-id','wait-bind','--revision','revision-1','--execution-id',executionId,'--output-file',file,'--content-sha256','0'.repeat(64))).status,0,'hash mismatch rejected');
  let saved=await f.load(); assert.equal(saved.tasks[0].result.data.shortcut.receipts,undefined);
  assert.equal((await receipt()).status,0,'valid receipt records');
  assert.equal((await receipt()).status,0,'identical receipt is idempotent');
  const graphFenceRaw=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  const graphFenceStore=new Proxy(graphFenceRaw,{get(target,key){if(key==='load')return target.loadJob.bind(target);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const readyJob=await graphFenceStore.load(f.id);
  await assert.rejects((await import('../dist/agent-shortcut.js')).runAgentShortcut({store:graphFenceStore,job:readyJob,task:readyJob.tasks[0],projectPath:f.project,neoRoot:f.neo}),/selected by the Task Lifecycle graph/);
  graphFenceRaw.close();
  const db=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  await db.mutateJob(f.id,job=>{job.tasks[0].result.data.shortcut.receipts.A.output={status:'COMPLETED',output:{tampered:true},artifacts:[]};return job;});
  db.close();
  assert.notEqual((await receipt()).status,0,'conflicting receipt rejected');
  saved=await f.load(); assert.equal(saved.tasks[0].state,'RUNNING'); assert.equal(saved.tasks[0].leaseOwner,null);
  const tamperedRaw=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  const tamperedStore=new Proxy(tamperedRaw,{get(target,key){if(key==='load')return target.loadJob.bind(target);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const task=saved.tasks[0];
  await assert.rejects((await import('../dist/agent-shortcut.js')).runAgentShortcut({store:tamperedStore,job:saved,task,projectPath:f.project,neoRoot:f.neo}),/no longer matches/);
  const unchanged=await tamperedRaw.loadJob(f.id); tamperedRaw.close();
  assert.equal(unchanged.tasks[0].state,'RUNNING'); assert.equal(unchanged.tasks[0].leaseOwner,null);
});

test('receipt endpoint rejects a pre-shortcut legacy Job',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:waiter]'});
  const output={status:'COMPLETED',output:{ok:true},artifacts:[]};
  const {shortcutContentSha256}=await import('../dist/agent-shortcut.js'); const contentHash=shortcutContentSha256(output);
  await f.writeShortcut(f.neo,'waiter',`export async function run(){return {status:'WAITING_EVENT',event:{kind:'nonhuman_result',nodeId:'A',id:'legacy-wait',revision:'r1',contentHash:${JSON.stringify(contentHash)}}};}`);
  const first=await f.cli(); assert.equal(first.status,3,first.stderr);
  const waiting=await f.load(), file=join(f.directory,'legacy-receipt.json'); await writeFile(file,JSON.stringify(output));
  const db=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  await db.mutateJob(f.id,job=>{job.executionMode=undefined;return job;}); db.close();
  const rejected=await f.receiptCli('--node-id','A','--wait-id','legacy-wait','--revision','r1','--execution-id',waiting.tasks[0].executionId,'--output-file',file,'--content-sha256',contentHash);
  assert.notEqual(rejected.status,0); assert.match(rejected.stderr,/active persisted wait and execution/);
});

test('missing standalone model node cannot use a global Queue or execute without EventBus', async t => {
  const f = await fixture(t, { agentGraph: 'flowchart TD\nA[agent:missing]' });
  const result = await f.cli('--events','none');
  assert.equal(result.status, 1, JSON.stringify(result));
  const output=JSON.parse(result.stdout);
  assert.match(output.outcome.reason,/reachable EventBus and existing Relay Worker Adapter/);
  const task=(await f.load()).tasks[0];
  assert.equal(task.state,'FAILED');
  assert.equal(task.attempt,1);
  assert.equal(task.result.data.shortcut.workerFallback,undefined);
  assert.equal(task.result.data.shortcut.nodes.A,undefined);
  assert.equal((await f.load()).tasks.length,1,'no model Task dispatched without EventBus');
});

test('Shortcut has no total-duration cutoff, even when historic 20m metadata is expired',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:slow]'});
  const startedAt=new Date(Date.now()-21*60*1000).toISOString();
  const oldDeadline=new Date(Date.parse(startedAt)+20*60*1000).toISOString();
  await f.writeShortcut(f.neo,'slow',`export async function run(){return {status:'COMPLETED',output:{elapsedTargetExceeded:true},artifacts:[]};}`);
  const store=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  await store.mutateJob(f.id,job=>{job.shortcutExecutionStartedAt=startedAt;job.shortcutExecutionDeadlineAt=oldDeadline;return job;});store.close();
  const result=await f.cli();
  assert.equal(result.status,0,JSON.stringify(result));
  const saved=await f.load();
  assert.equal(saved.shortcutExecutionStartedAt,startedAt);
  assert.equal(saved.tasks[0].state,'SUCCEEDED');
  assert.equal(saved.state,'COMPLETED');
  assert.equal(saved.tasks[0].result.data.shortcut.nodes.A.output.elapsedTargetExceeded,true);
});

test('missing downstream model node preserves the completed predecessor checkpoint without global Worker fallback',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:has-code] --> B[agent:no-code]'});
  const marker=join(f.directory,'first-shortcut-ran');
  await f.writeShortcut(f.project,'has-code',`import {writeFile} from 'node:fs/promises'; export async function run(){ await writeFile(${JSON.stringify(marker)},'done'); return {status:'COMPLETED',output:{foo:1},artifacts:[]}; }`);
  const result=await f.cli('--events','none');
  assert.equal(result.status,1,result.stderr);
  assert.equal(await readFile(marker,'utf8'),'done');
  const saved=await f.load();
  assert.equal(saved.tasks[0].state,'FAILED');
  assert.equal(saved.tasks[0].result.data.shortcut.workerFallback,undefined);
  assert.equal(saved.tasks[0].result.data.shortcut.nodes.A.output.foo,1);
  assert.equal(saved.tasks[0].result.data.shortcut.nodes.B,undefined);
});

test('an exception after entering an untrusted shortcut module requires recovery, not Worker replay',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:throws]'});
  await f.writeShortcut(f.neo,'throws',`export async function run(){throw new Error('validation rejected before effects');}`);
  const result=await f.cli(); assert.equal(result.status,1,JSON.stringify(result));
  assert.equal(JSON.parse(result.stdout).fallbackQueued,false);
  assert.equal((await f.load()).tasks[0].state,'FAILED');
  assert.equal((await f.load()).tasks[0].failureReason,'shortcut_requires_recovery');
});

test('direct filesystem side effects inside a shortcut cannot trigger automatic Worker replay',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:direct-effect]'});
  const output=join(f.directory,'direct-effect');
  await f.writeShortcut(f.neo,'direct-effect',`import {writeFile} from 'node:fs/promises'; export async function run(){await writeFile(${JSON.stringify(output)},'already changed');throw Error('failed after direct effect');}`);
  const result=await f.cli(); assert.equal(result.status,1,JSON.stringify(result));
  assert.equal(JSON.parse(result.stdout).fallbackQueued,false);
  assert.equal(await readFile(output,'utf8'),'already changed');
  assert.equal((await f.load()).tasks[0].state,'FAILED');
});

test('restart checkpoint with an interrupted module never automatically replays it',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:interrupted]'});
  const output=join(f.directory,'interrupted-ran');
  await f.writeShortcut(f.neo,'interrupted',`import {writeFile} from 'node:fs/promises'; export async function run(){await writeFile(${JSON.stringify(output)},'replayed');return {status:'COMPLETED',output:{ok:true},artifacts:[]};}`);
  const store=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  await store.mutateJob(f.id,job=>{job.tasks[0].result={summary:'interrupted',data:{shortcut:{version:1,graphHash:'',inputHash:'',shortcutHash:'',nodes:{},waits:{},artifactHashes:{},inFlight:{A:'old-execution'}}}};return job;});
  store.close();
  const result=await f.cli();
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/interrupted module execution/);
  await assert.rejects(readFile(output,'utf8'),{code:'ENOENT'});
  assert.equal((await f.load()).tasks[0].state,'QUEUED');
});

test('Troubleshooter exact-original recovery never changes direct shortcut mode to Worker execution',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:interrupted]'});
  const rawStore=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  const store=new Proxy(rawStore,{get(target,key){if(key==='load')return target.loadJob.bind(target);if(key==='saveTask')return task=>target.mutateJob(f.id,job=>{const index=job.tasks.findIndex(item=>item.id===task.id);if(index<0)throw Error('Task missing');job.tasks[index]=structuredClone(task);return job;});const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  await rawStore.mutateJob(f.id,job=>{
    const original=job.tasks[0]; original.state='RUNNING'; original.failureReason=undefined; original.executionId='expired-execution'; original.leaseOwner='shortcut-crashed'; original.leaseExpiresAt=new Date(Date.now()-1000).toISOString(); original.attempt=original.maxAttempts;
    original.executionHistory=[{id:'expired-execution',attempt:original.attempt,startedAt:new Date(Date.now()-30_000).toISOString()}];
    original.result={summary:'interrupted shortcut',data:{shortcut:{version:1,graphHash:'graph',inputHash:'input',shortcutHash:'shortcut',nodes:{},waits:{},artifactHashes:{},inFlight:{A:'expired-execution'}}}};
    return job;
  });
  const expired=await store.load(f.id);
  await recoverExpiredExecutions(expired,Date.now(),{store,owner:'recovery-owner',cancelGeneration:()=>{},cancelPlanner:()=>{},emitFailed:async()=>{}});
  await rawStore.mutateJob(f.id,job=>{
    const original=job.tasks[0];
    assert.equal(original.state,'FAILED');
    assert.equal(original.failureReason,'worker_outcome_unknown','real lease recovery records the generic unknown-outcome reason');
    job.tasks.push({...structuredClone(original),id:'troubleshoot-initial',title:'Troubleshoot interrupted shortcut',agentName:'troubleshooter',parentTaskId:original.id,state:'RUNNING',executionId:'troubleshooter-execution',leaseOwner:'troubleshooter-owner',leaseExpiresAt:new Date(Date.now()+60_000).toISOString(),attempt:1,result:null,error:null,failureReason:undefined});
    return job;
  });
  const recovered=await dispatchTaskAction(store,{id:'task.recover',jobId:f.id,taskId:'initial',recoveryTaskId:'troubleshoot-initial'});
  const shortcut=recovered.task.result.data.shortcut;
  assert.equal(recovered.task.state,'QUEUED');
  assert.equal(shortcut.workerFallback,undefined);
  assert.deepEqual(shortcut.inFlight,{A:'expired-execution'},'recovery preserves evidence and never clears the interrupted checkpoint');
  const dispatch=tryTransitionTaskEvent(recovered.task,'dispatch',{dispatchable:true,shortcutExecution:true,shortcutFallback:shortcut.workerFallback,shortcutHasGraph:true,shortcutDirectInvocation:true});
  assert.ok(dispatch.actions.includes('effect.launchShortcut'));
  const output=join(f.directory,'unauthorized-shortcut-ran');
  await f.writeShortcut(f.neo,'interrupted',`import {writeFile} from 'node:fs/promises'; export async function run(){await writeFile(${JSON.stringify(output)},'wrong route');return {status:'COMPLETED',output:{bad:true},artifacts:[]};}`);
  const direct=f.cli();
  const rejected=await direct;
  assert.notEqual(rejected.status,0);
  assert.match(rejected.stderr,/checkpoint fingerprint changed/);
  await assert.rejects(readFile(output,'utf8'),{code:'ENOENT'});
  rawStore.close();
});

test('shortcut execution renews its exact Task lease while a module is pending',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:slow]'});
  await f.writeShortcut(f.neo,'slow',`export async function run({signal}){await new Promise(resolve=>setTimeout(resolve,160));return {status:'COMPLETED',output:{cancelled:signal.aborted},artifacts:[]};}`);
  const rawStore=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  const started=Date.now(); let earlyRenewals=0;
  const store=new Proxy(rawStore,{get(target,key){if(key==='load')return target.loadJob.bind(target);if(key==='saveTask')return task=>target.mutateJob(f.id,job=>{const index=job.tasks.findIndex(item=>item.id===task.id);if(index<0)throw Error('Task missing');job.tasks[index]=structuredClone(task);return job;});if(key==='mutateJob')return async(jobId,mutation)=>{const before=await target.loadJob(jobId);const after=await target.mutateJob(jobId,mutation);const oldTask=before.tasks[0],newTask=after.tasks[0];if(oldTask.leaseOwner?.startsWith('shortcut-')&&newTask.leaseOwner===oldTask.leaseOwner&&Date.now()-started<80&&Date.parse(newTask.leaseExpiresAt)>Date.parse(oldTask.leaseExpiresAt))earlyRenewals++;return after;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  try {
    const {runAgentShortcut}=await import('../dist/agent-shortcut.js');
    const job=await store.load(f.id);
    const result=await runAgentShortcut({store,job,task:job.tasks[0],projectPath:f.project,neoRoot:f.neo,leaseMs:120,heartbeatMs:15});
    assert.equal(result.outcome.status,'COMPLETED');
    assert.ok(earlyRenewals>=1,`expected early lease renewal; observed ${earlyRenewals}`);
    assert.equal(result.outcome.output.nodes.A.output.cancelled,false);
  } finally { rawStore.close(); }
});

test('human approval waits fail closed to the existing Worker authority',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:approval]'});
  await f.writeShortcut(f.neo,'approval',`export async function run(){return {status:'WAITING_EVENT',event:{kind:'human_approval',nodeId:'A',id:'approval-1',revision:'r1',contentHash:${JSON.stringify('d'.repeat(64))}}};}`);
  const result=await f.cli(); assert.equal(result.status,1,JSON.stringify(result));
  assert.equal(JSON.parse(result.stdout).fallbackQueued,false);
  const task=(await f.load()).tasks[0];
  assert.equal(task.state,'FAILED');
  assert.equal(task.failureReason,'shortcut_requires_recovery');
  assert.deepEqual(task.result.data.shortcut.waits,{});
});

test('actual shortcut CLI never completes or retries the whole graph after malformed output side effects', async t => {
  const f = await fixture(t, { agentGraph: 'flowchart TD\nA[agent:bad]' });
  const effectCode=`require('node:fs').writeFileSync(${JSON.stringify(join(f.directory,'partial-effect'))},'preserve')`;
  await f.writeShortcut(f.neo, 'bad', `export async function run({runCommand}) { await runCommand([process.execPath,'-e',${JSON.stringify(effectCode)}],process.cwd()); return {status:'COMPLETED',output:{answer:42}}; }`);
  const result=await f.cli(); assert.equal(result.status,1,result.stderr);
  assert.equal(JSON.parse(result.stdout).outcome.status,'FAILED');
  assert.equal((await f.load()).tasks[0].state,'FAILED');
  assert.equal(JSON.parse(result.stdout).fallbackQueued,false);
  assert.equal(await (await import('node:fs/promises')).readFile(join(f.directory,'partial-effect'),'utf8'),'preserve');
});

test('Reconciler does not execute the direct shortcut graph or create a shortcut Worker task',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:bad]'});
  const effectCode=`require('node:fs').writeFileSync(${JSON.stringify(join(f.directory,'recovery-effect'))},'preserve')`;
  await f.writeShortcut(f.neo,'bad',`export async function run({runCommand}){await runCommand([process.execPath,'-e',${JSON.stringify(effectCode)}],process.cwd());return {status:'COMPLETED',output:{invalid:42}};}`);
  const rawStore=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  const store=new Proxy(rawStore,{get(target,key){if(key==='load')return target.loadJob.bind(target);if(key==='saveTask')return task=>target.mutateJob(f.id,job=>{const index=job.tasks.findIndex(item=>item.id===task.id);if(index<0)throw Error('Task missing');job.tasks[index]=structuredClone(task);return job;});if(key==='appendTask')return task=>target.mutateJob(f.id,job=>{if(job.tasks.some(item=>item.id===task.id))throw Error('Task already exists');job.tasks.push(structuredClone(task));return job;});const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const bus=new MemoryEventBus();
  const events=[];
  const stop=await bus.subscribe(f.id,event=>{events.push(event);});
  const reconciler=managedReconciler(store,{noGitHub:true,owner:'shortcut-recovery-wake',maxConcurrent:1,eventBus:bus,projectPathForJob:()=>f.project,executionContextRoots:{workspaceRoot:f.directory},headShaProvider:()=>null,adapters:[]});
  try {
    const held=await reconciler.reconcile(f.id);
    assert.equal(held.tasks[0].state,'QUEUED');
    assert.equal(held.tasks[0].executionId,null);
    assert.equal(held.tasks.some(task=>task.agentName==='troubleshooter'),false);
    assert.equal(events.some(event=>event.type==='job.wake'),false);
  } finally { await stop(); store.close(); }
});

test('Reconciler leaves a durable direct shortcut Job queued for the foreground runner', async t => {
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:only]'});
  await f.writeShortcut(f.neo,'only',`export async function run(){return {status:'COMPLETED',output:{source:'shortcut'},artifacts:[]};}`);
  assert.equal((await f.load()).executionMode,'shortcut');
  const rawStore=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  const store=new Proxy(rawStore,{get(target,key){if(key==='load')return target.loadJob.bind(target);if(key==='saveTask')return task=>target.mutateJob(f.id,job=>{const index=job.tasks.findIndex(item=>item.id===task.id);if(index<0)throw Error('Task missing');job.tasks[index]=structuredClone(task);return job;});const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  let workerLaunches=0;
  const reconciler=managedReconciler(store,{noGitHub:true,owner:'shortcut-daemon-test',maxConcurrent:1,projectPathForJob:()=>f.project,executionContextRoots:{workspaceRoot:f.directory},headShaProvider:()=>null,
    adapters:[{name:'codex',id:'fixture-worker',capabilities:[],launch(){workerLaunches++;throw Error('Worker must not launch');}}]});
  try {
    const result=await reconciler.reconcile(f.id);
    assert.equal(workerLaunches,0);
    assert.equal(result.tasks[0].state,'QUEUED',JSON.stringify(result.tasks[0]));
    assert.equal(result.state,'ACTIVE');
    assert.equal(result.plans?.length ?? 0,0);
  } finally { store.close(); }
});

test('a durable shortcut event wait releases only its content-only Job slot', async t=>{
  const f=await fixture(t);
  const {jobHasActiveExecution}=await import('../dist/job-execution-slot.js');
  const current=await f.load();
  current.tasks[0].state='RUNNING'; current.tasks[0].leaseOwner=null;
  current.tasks[0].result={summary:'waiting',data:{shortcut:{waits:{A:{id:'e',revision:'r',contentHash:'a'.repeat(64)}}}}};
  assert.equal(jobHasActiveExecution(current),false);
  current.executionMode=undefined;
  assert.equal(jobHasActiveExecution(current),true);
  current.executionMode='shortcut'; current.tasks[0].leaseOwner='worker';
  assert.equal(jobHasActiveExecution(current),true);
});

test('artifact tampering fails closed when a checkpoint resumes a waiting graph',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:artifact]\nB[agent:waiter]'});
  const artifact=join(f.project,'result.txt');
  await writeFile(artifact,'approved result');
  await f.writeShortcut(f.neo,'artifact',`export async function run(){return {status:'COMPLETED',output:{file:'result.txt'},artifacts:['result.txt']};}`);
  await f.writeShortcut(f.neo,'waiter',`export async function run(){return {status:'WAITING_EVENT',event:{kind:'nonhuman_result',nodeId:'B',id:'evt',revision:'r1',contentHash:${JSON.stringify('b'.repeat(64))}}};}`);
  const first=await f.cli(); assert.equal(first.status,3,first.stderr);
  assert.equal(JSON.parse(first.stdout).outcome.status,'WAITING_EVENT');
  assert.ok((await f.load()).tasks[0].result.data.shortcut.artifactHashes.A['result.txt']);
  await writeFile(artifact,'tampered');
  const retry=await f.cli();
  assert.notEqual(retry.status,0);
  assert.match(retry.stderr,/artifact changed|fingerprint changed/);
});

test('Task input mutation invalidates a persisted wait checkpoint',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:waiter]'});
  await f.writeShortcut(f.neo,'waiter',`export async function run(){return {status:'WAITING_EVENT',event:{kind:'nonhuman_result',nodeId:'A',id:'evt',revision:'r1',contentHash:${JSON.stringify('c'.repeat(64))}}};}`);
  const first=await f.cli(); assert.equal(first.status,3,first.stderr);
  const store=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  await store.mutateJob(f.id,job=>{job.tasks[0].input='changed input';return job;}); store.close();
  const retry=await f.cli(); assert.notEqual(retry.status,0);
  assert.match(retry.stderr,/checkpoint fingerprint changed/);
});

test('content-only shortcut completion requires a durable no-review no-merge policy', async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:ok]'});
  await f.writeShortcut(f.neo,'ok',`export async function run(){return {status:'COMPLETED',output:{ok:true},artifacts:[]};}`);
  const rawStore=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  await rawStore.mutateJob(f.id,job=>{job.contentOnly=false;return job;});
  const store=new Proxy(rawStore,{get(target,key){if(key==='load')return target.loadJob.bind(target);if(key==='saveTask')return task=>target.mutateJob(f.id,job=>{const index=job.tasks.findIndex(item=>item.id===task.id);if(index<0)throw Error('Task missing');job.tasks[index]=structuredClone(task);return job;});const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const reconciler=managedReconciler(store,{noGitHub:true,owner:'shortcut-no-content-gate',projectPathForJob:()=>f.project,executionContextRoots:{workspaceRoot:f.directory},headShaProvider:()=>null,adapters:[]});
  try { const result=await reconciler.reconcile(f.id); assert.equal(result.tasks[0].state,'QUEUED'); assert.equal(result.state,'ACTIVE','Background Reconciler cannot run shortcut or bypass the content-only gate'); }
  finally { store.close(); }
});

test('legacy and project-local Vlog Visioner shortcuts cannot bypass source evidence/normalized media/metadata',async t=>{
  for (const agent of ['visioner','vlog-visioner']) {
    await t.test(agent,async t=>{
      const f=await fixture(t,{agentGraph:`flowchart TD\nA[agent:${agent}]`});
      await f.writeShortcut(agent==='visioner'?f.neo:f.project,agent,
        `export async function run(){return {status:'COMPLETED',output:{answer:'looks fine'},artifacts:[]};}`);
      const result=await f.cli(); assert.equal(result.status,1,JSON.stringify(result));
      assert.equal(JSON.parse(result.stdout).fallbackQueued,false);
      assert.equal((await f.load()).state,'ACTIVE');
      assert.equal((await f.load()).tasks[0].state,'FAILED');
    });
  }
});

test('Vlog Visioner accepts current source-linked evidence and normalized manifest without legacy index',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:vlog-visioner]'});
  const sha='a'.repeat(64),manifestSha='b'.repeat(64);
  const metadata={'001':{duration:9.7,perception:{desc:'Observed trees',segments:{'0to9700':{vision:'Trees'}}}}};
  const metadataBytes=Buffer.from(JSON.stringify(metadata));
  const evidence={stage:'visioner',status:'EVIDENCE_READY_UNREVIEWED',
    manifest_hash:manifestSha,markcut_metadata_sha256:createHash('sha256').update(metadataBytes).digest('hex'),
    sources:[{source_id:'001',source_sha256:sha}],observations:[],summary:[]};
  const normalized={profile:'markcut-vision-normalized-v1',usage:'vision-understanding-only',
    sourceManifestSha256:manifestSha,sources:[{sourceId:'001',sourceSha256:sha,normalizedSha256:'c'.repeat(64)}]};
  const artifacts={'vision-evidence.json':evidence,'vision-normalized-manifest.json':normalized,'metadata.json':metadata};
  const output={};
  for(const [name,value] of Object.entries(artifacts)){
    const path=join(await realpath(f.project),name);await writeFile(path,JSON.stringify(value));output[name]=path;
  }
  await f.writeShortcut(f.project,'vlog-visioner',
    `export async function run(){return {status:'COMPLETED',output:${JSON.stringify(output)},artifacts:${JSON.stringify(artifacts)}};}`);
  const result=await f.cli();
  assert.equal(result.status,0,JSON.stringify({stderr:result.stderr,stdout:result.stdout?.slice(-1500)}));
  assert.equal((await f.load()).tasks[0].state,'SUCCEEDED');
});

test('ordinary Relay queue never dispatches a queued shortcut Worker fallback or its Troubleshooter', async t => {
  const f = await fixture(t, { agentGraph: 'flowchart TD\nA[agent:missing]' });
  const rawStore = new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  await rawStore.mutateJob(f.id, job => {
    job.tasks[0].result={summary:'foreground only',data:{shortcut:{workerFallback:true}}};
    job.tasks.push({...structuredClone(job.tasks[0]),id:'troubleshoot-initial',title:'Troubleshooter',agentName:'troubleshooter',parentTaskId:'initial',agentGraph:undefined,result:null});
    return job;
  });
  const store=new Proxy(rawStore,{get(target,key){if(key==='load')return target.loadJob.bind(target);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  let launches=0;
  const reconciler=managedReconciler(store,{owner:'ordinary-daemon',noGitHub:true,adapters:[{name:'codex',id:'codex',capabilities:['model'],launch(){launches++;throw Error('not owned');}}],eventBus:new MemoryEventBus(),maxConcurrent:2});
  const before=await store.load(f.id);
  const after=await reconciler.reconcile(f.id);
  assert.equal(launches,0);
  assert.deepEqual(after.tasks.map(task=>[task.id,task.state,task.attempt]),before.tasks.map(task=>[task.id,task.state,task.attempt]));
  assert.equal(after.tasks.length,2);
  rawStore.close();
});

test('foreground owner launches existing model Worker and proves terminal Job state',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:missing]'});
  const {driveShortcutWorkers}=await import('../dist/shortcut-worker-runner.js');
  const bus=new MemoryEventBus(), rawStore=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  await rawStore.mutateJob(f.id,job=>{
    const task=job.tasks[0];
    task.result={summary:'Worker fallback',data:{shortcut:{workerFallback:true}}};
    task.routing={provider:'openai',model:'fixture-model',decidedBy:'test'};
    task.output={kind:'task_pr'};
    return job;
  });
  const store=new Proxy(rawStore,{get(target,key){if(key==='listAgents')return async()=>[];if(key==='load')return target.loadJob.bind(target);if(key==='saveTask')return task=>target.mutateJob(f.id,job=>{const index=job.tasks.findIndex(item=>item.id===task.id);if(index<0)throw Error('Task missing');job.tasks[index]=structuredClone(task);return job;});if(key==='appendTask')return task=>target.mutateJob(f.id,job=>{if(job.tasks.some(item=>item.id===task.id))throw Error('Task exists');job.tasks.push(structuredClone(task));return job;});const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  let launches=0;
  const adapter={name:'codex',id:'codex',capabilities:['model','codex'],launch(current){
    launches++;
    const source={id:(`job/${f.id}/task/${current.id}/execution/${current.executionId}`)};
    void bus.publish(eventFor(f.id,current.id,current.parentTaskId,'task.started','running','started','user',undefined,source))
      .then(()=>bus.publish(eventFor(f.id,current.id,current.parentTaskId,'task.completed','succeeded','completed by worker','orchestrator',{},source)));
    return {id:'fake-exec',launched:Promise.resolve(),promise:Promise.resolve({summary:'runtime exited'}),cancel(){}};
  }};
  const reconciler=managedReconciler(store,{shortcutRunnerOwner:true,owner:'foreground-fixture',noGitHub:true,maxConcurrent:1,adapters:[adapter],eventBus:bus,projectPathForJob:()=>f.project,headShaProvider:()=>null});
  try {
    const result=await driveShortcutWorkers({store,jobId:f.id,taskId:'initial',reconciler,signal:AbortSignal.timeout(2000)});
    assert.equal(result.status,'COMPLETED',JSON.stringify(result.job.tasks.map(t=>({id:t.id,state:t.state,error:t.error,attempt:t.attempt,routing:t.routing}))));
    assert.equal(launches,1);
    assert.equal(result.job.tasks[0].state,'SUCCEEDED');
    assert.ok(result.job.shortcutExecutionStartedAt);
    assert.equal(result.job.shortcutExecutionDeadlineAt,undefined);
    assert.equal(result.job.executionMode,'shortcut');
  } finally {rawStore.close();}
});

test('foreground Shortcut Runner exclusively launches failure Troubleshooter with the existing Adapter',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:missing]'});
  const {driveShortcutWorkers}=await import('../dist/shortcut-worker-runner.js');
  const bus=new MemoryEventBus(), rawStore=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  await rawStore.mutateJob(f.id,job=>{
    const work=job.tasks[0];
    work.result={summary:'Worker fallback',data:{shortcut:{workerFallback:true}}};
    work.routing={provider:'openai',model:'fixture-model',decidedBy:'test'};
    work.output={kind:'task_pr'};
    return job;
  });
  const store=new Proxy(rawStore,{get(target,key){
    if(key==='listAgents')return async()=>[];
    if(key==='load')return target.loadJob.bind(target);
    if(key==='saveTask')return task=>target.mutateJob(f.id,job=>{const i=job.tasks.findIndex(item=>item.id===task.id);if(i<0)throw Error('Missing');job.tasks[i]=structuredClone(task);return job;});
    if(key==='appendTask')return task=>target.mutateJob(f.id,job=>{if(job.tasks.some(item=>item.id===task.id))throw Error('Duplicate');job.tasks.push(structuredClone(task));return job;});
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const launches=[];
  const controller=new AbortController();
  const adapter={name:'codex',id:'codex',capabilities:['model','codex'],launch(current){
    launches.push({id:current.id,agent:current.agentName,executionId:current.executionId});
    const source={id:`job/${f.id}/task/${current.id}/execution/${current.executionId}`};
    const failed=current.agentName!=='troubleshooter';
    void bus.publish(eventFor(f.id,current.id,current.parentTaskId,'task.started','running','started','user',undefined,source))
      .then(()=>bus.publish(eventFor(f.id,current.id,current.parentTaskId,failed?'task.failed':'task.completed',failed?'failed':'succeeded',failed?'fixture worker failure':'recovery reviewed','orchestrator',{},source)))
      .then(()=>{if(!failed)controller.abort();});
    return {id:'fake-'+current.id,launched:Promise.resolve(),promise:Promise.resolve({summary:'runtime exited'}),cancel(){}};
  }};
  const reconciler=managedReconciler(store,{shortcutRunnerOwner:true,owner:'foreground-recovery',noGitHub:true,maxConcurrent:1,adapters:[adapter],eventBus:bus,projectPathForJob:()=>f.project,headShaProvider:()=>null});
  try {
    await driveShortcutWorkers({store,jobId:f.id,taskId:'initial',reconciler,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(2000)])});
    assert.ok(launches.some(x=>x.id==='initial'));
    assert.ok(launches.some(x=>x.id==='troubleshoot-initial'),JSON.stringify(launches));
    const latest=await store.load(f.id);
    assert.equal(latest.executionMode,'shortcut');
    assert.equal(latest.tasks.find(x=>x.id==='troubleshoot-initial').agentName,'troubleshooter');
  } finally {rawStore.close();}
});

test('D02 integration: graph executes code, existing Worker child, then code from correlated Worker output',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:source] --> M[agent:model]\nM --> C[agent:finish]'});
  const {runAgentShortcut}=await import('../dist/agent-shortcut.js');
  const {runShortcutModelNode}=await import('../dist/shortcut-node-worker.js');
  const {mkdir}=await import('node:fs/promises');
  const {dirname}=await import('node:path');
  const bus=new MemoryEventBus(),rawStore=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  await rawStore.mutateJob(f.id,job=>{job.tasks[0].output={kind:'file',path:join(f.directory,'final.json')};return job;});
  const store=new Proxy(rawStore,{get(target,key){
    if(key==='listAgents')return async()=>[];
    if(key==='load')return target.loadJob.bind(target);
    if(key==='saveTask')return task=>target.mutateJob(f.id,job=>{const i=job.tasks.findIndex(x=>x.id===task.id);if(i<0)throw Error('Missing Task');job.tasks[i]=structuredClone(task);return job;});
    if(key==='appendTask')return task=>target.mutateJob(f.id,job=>{if(job.tasks.some(x=>x.id===task.id))throw Error('Duplicate Task');job.tasks.push(structuredClone(task));return job;});
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  await writeFile(join(f.project,'agents','model.agent.md'),'---\nname: model\ndescription: Synthetic model role\ntype: worker\n---\nProduce a checked JSON node result.\n');
  await f.writeShortcut(f.project,'source',`export async function run(){return {status:'COMPLETED',output:{token:'from-code'},artifacts:[]};}`);
  await f.writeShortcut(f.project,'finish',`export async function run({input}){if(input.predecessorOutputs.M.token!=='from-worker')throw Error('Worker output missing');return {status:'COMPLETED',output:{last:true},artifacts:[]};}`);
  const launches=[];
  const adapter={name:'codex',id:'codex',capabilities:['model','codex'],launch(task){
    launches.push({id:task.id,agent:task.agentName,input:task.input});
    const source={id:`job/${f.id}/task/${task.id}/execution/${task.executionId}`};
    void (async()=>{
      await bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.started','running','started','user',undefined,source));
      await mkdir(dirname(task.output.path),{recursive:true});
      await writeFile(task.output.path,JSON.stringify({status:'COMPLETED',output:{token:'from-worker'},artifacts:[]}));
      await bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.completed','succeeded','model completed','orchestrator',{},source));
    })().catch(error=>{throw error;});
    return {id:'fake-'+task.id,launched:Promise.resolve(),promise:Promise.resolve({summary:'fake adapter exited'}),cancel(){}};
  }};
  const reconciler=managedReconciler(store,{shortcutRunnerOwner:true,owner:'mixed-dag-fixture',noGitHub:true,maxConcurrent:1,
    adapters:[adapter],eventBus:bus,projectPathForJob:()=>f.project,headShaProvider:()=>null});
  const unwatch=await reconciler.watch(f.id);
  try{
    const before=await store.load(f.id);
    const controller=AbortSignal.timeout(2500);
    const events=[];
    const result=await runAgentShortcut({store,job:before,task:before.tasks[0],projectPath:f.project,neoRoot:f.neo,
      signal:controller,onNodeEvent:event=>events.push(event),
      runModelNode:node=>runShortcutModelNode({store,reconciler,jobId:f.id,parentTaskId:'initial',node})});
    assert.equal(result.outcome.status,'COMPLETED',JSON.stringify({outcome:result.outcome,tasks:(await store.load(f.id)).tasks.map(x=>({id:x.id,state:x.state,attempt:x.attempt,executionId:x.executionId,leaseOwner:x.leaseOwner,error:x.error,workerSelection:x.workerSelection})),launches,events}));
    const after=await store.load(f.id);
    assert.equal(after.state,'COMPLETED');assert.equal(after.tasks[0].state,'SUCCEEDED');
    assert.equal(after.tasks[1].id,'shortcut-initial-M');assert.equal(after.tasks[1].state,'SUCCEEDED');
    assert.equal(after.tasks[1].agentName,'model');
    assert.deepEqual(launches.map(l=>l.id),['shortcut-initial-M']);
    assert.equal(JSON.parse(after.tasks[1].input).predecessorOutputs.A.token,'from-code');
    assert.deepEqual(events.filter(e=>e.type==='completed').map(e=>e.nodeId),['A','M','C']);
    assert.equal(after.tasks[0].result.data.shortcut.nodes.C.output.last,true);
  } finally {await unwatch();rawStore.close();}
});

async function mixedFixture(t,graphFile){
  const agentGraph=await readFile(join(root,'test','fixtures','shortcut-dags',graphFile),'utf8');
  const f=await fixture(t,{agentGraph});
  const rawStore=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  await rawStore.mutateJob(f.id,job=>{job.tasks[0].output={kind:'file',path:join(f.directory,'final.json')};return job;});
  const store=new Proxy(rawStore,{get(target,key){
    if(key==='listAgents')return async()=>[];
    if(key==='load')return target.loadJob.bind(target);
    if(key==='saveTask')return task=>target.mutateJob(f.id,job=>{const i=job.tasks.findIndex(item=>item.id===task.id);if(i<0)throw Error('Task missing');job.tasks[i]=structuredClone(task);return job;});
    if(key==='appendTask')return task=>target.mutateJob(f.id,job=>{if(job.tasks.some(item=>item.id===task.id))throw Error('Duplicate Task');job.tasks.push(structuredClone(task));return job;});
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  await writeFile(join(f.project,'agents','model.agent.md'),'---\nname: model\ndescription: Synthetic model role\ntype: worker\n---\nProduce only the required synthetic output.\n');
  await writeFile(join(f.project,'agents','troubleshooter.agent.md'),'---\nname: troubleshooter\ndescription: Synthetic recovery role\ntype: worker\n---\nDiagnose synthetic failure.\n');
  const bus=new MemoryEventBus();
  const {runAgentShortcut}=await import('../dist/agent-shortcut.js');
  const {runShortcutModelNode}=await import('../dist/shortcut-node-worker.js');
  const execute=async(reconciler,signal=AbortSignal.timeout(3000))=>{
    const before=await store.load(f.id);
    const events=[];
    const result=await runAgentShortcut({store,job:before,task:before.tasks[0],projectPath:f.project,neoRoot:f.neo,signal,
      onNodeEvent:event=>events.push(event),
      runModelNode:node=>runShortcutModelNode({store,reconciler,jobId:f.id,parentTaskId:'initial',node})});
    return {result,events,job:await store.load(f.id)};
  };
  const makeReconciler=adapter=>managedReconciler(store,{shortcutRunnerOwner:true,owner:'mixed-test',noGitHub:true,
    maxConcurrent:1,adapters:[adapter],eventBus:bus,projectPathForJob:()=>f.project,headShaProvider:()=>null});
  t.after(()=>rawStore.close());
  return {...f,store,rawStore,bus,execute,makeReconciler};
}

test('D03 integration: code and Worker branches run concurrently, join waits for both outputs',async t=>{
  const f=await mixedFixture(t,'D03-parallel-code-model.mmd');
  const {mkdir}=await import('node:fs/promises');
  const {dirname}=await import('node:path');
  const codeReady=join(f.directory,'code-ready'),workerReady=join(f.directory,'worker-ready');
  await f.writeShortcut(f.project,'code',`import {writeFile,access} from 'node:fs/promises';
    export async function run(){
      let launched=false; for(let i=0;i<120;i++){try{await access(${JSON.stringify(workerReady)});launched=true;break;}catch{} await new Promise(r=>setTimeout(r,5));}
      if(!launched)throw Error('model branch did not launch while code was running');
      await writeFile(${JSON.stringify(codeReady)},'yes');
      return {status:'COMPLETED',output:{code:true},artifacts:[]};
    }`);
  await f.writeShortcut(f.project,'join',`export async function run({input}){
    if(!input.predecessorOutputs.A.code||!input.predecessorOutputs.M.model)throw Error('join before both inputs');
    return {status:'COMPLETED',output:{done:true},artifacts:[]};
  }`);
  const launches=[];
  const adapter={name:'codex',id:'codex',capabilities:['model','codex'],launch(task){
    launches.push(task.id);
    const source={id:`job/${f.id}/task/${task.id}/execution/${task.executionId}`};
    void (async()=>{
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.started','running','mock started','user',undefined,source));
      await writeFile(workerReady,'yes');
      let codeFinished=false;
      for(let i=0;i<120;i++){try{await readFile(codeReady);codeFinished=true;break;}catch{}await new Promise(r=>setTimeout(r,5));}
      if(!codeFinished)throw Error('code branch did not run while model in flight');
      await mkdir(dirname(task.output.path),{recursive:true});
      await writeFile(task.output.path,JSON.stringify({status:'COMPLETED',output:{model:true},artifacts:[]}));
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.completed','succeeded','mock succeeded','orchestrator',{},source));
    })().catch(error=>{throw error;});
    return {id:'fake-model',launched:Promise.resolve(),promise:Promise.resolve({summary:'mock exit'}),cancel(){}};
  }};
  const reconciler=f.makeReconciler(adapter),stop=await reconciler.watch(f.id);
  try{
    const {result,job,events}=await f.execute(reconciler);
    assert.equal(result.outcome.status,'COMPLETED',JSON.stringify({result:result.outcome,states:job.tasks.map(x=>[x.id,x.state])}));
    assert.equal(job.state,'COMPLETED');
    assert.deepEqual(launches,['shortcut-initial-M']);
    assert.equal(job.tasks[0].result.data.shortcut.nodes.J.output.done,true);
    assert.equal(events.find(e=>e.nodeId==='J'&&e.type==='completed')!==undefined,true);
    assert.equal(await readFile(codeReady,'utf8'),'yes');
  } finally {await stop();}
});

test('D02 fault F01: Worker terminal success without valid node output cannot run downstream',async t=>{
  const f=await mixedFixture(t,'D02-code-model-code.mmd');
  const {mkdir}=await import('node:fs/promises');const {dirname}=await import('node:path');
  await f.writeShortcut(f.project,'source',`export async function run(){return {status:'COMPLETED',output:{ready:true},artifacts:[]};}`);
  const marker=join(f.directory,'unsafe-finish');
  await f.writeShortcut(f.project,'finish',`import {writeFile} from 'node:fs/promises';export async function run(){await writeFile(${JSON.stringify(marker)},'bad');return {status:'COMPLETED',output:{bad:true},artifacts:[]};}`);
  let launched=0;
  const adapter={name:'codex',id:'codex',capabilities:['model','codex'],launch(task){
    launched++;
    const source={id:`job/${f.id}/task/${task.id}/execution/${task.executionId}`};
    void (async()=>{
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.started','running','mock started','user',undefined,source));
      await mkdir(dirname(task.output.path),{recursive:true});
      await writeFile(task.output.path,JSON.stringify({status:'COMPLETED',output:null,artifacts:[]}));
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.completed','succeeded','mock succeeded','orchestrator',{},source));
    })().catch(error=>{throw error;});
    return {id:'mock-success-invalid-payload',launched:Promise.resolve(),promise:Promise.resolve({summary:'mock exited'}),cancel(){}};
  }};
  const reconciler=f.makeReconciler(adapter),stop=await reconciler.watch(f.id);
  try{
    const {result,job}=await f.execute(reconciler);
    assert.equal(result.outcome.status,'FAILED');
    assert.match(result.outcome.reason,/contract-valid node output/);
    assert.equal(job.tasks.find(x=>x.id==='shortcut-initial-M').state,'SUCCEEDED','terminal event really succeeded');
    assert.equal(job.tasks[0].result.data.shortcut.nodes.A.output.ready,true);
    assert.equal(job.tasks[0].result.data.shortcut.nodes.C,undefined);
    assert.equal(existsSync(marker),false);
    assert.equal(launched,1);
  } finally{await stop();}
});

test('D02 fault F02: failed Worker spawns foreground-owned Troubleshooter but never replays model without recovery',async t=>{
  const f=await mixedFixture(t,'D02-code-model-code.mmd');
  await f.writeShortcut(f.project,'source',`export async function run(){return {status:'COMPLETED',output:{ready:true},artifacts:[]};}`);
  const marker=join(f.directory,'unsafe-finish');
  await f.writeShortcut(f.project,'finish',`import {writeFile} from 'node:fs/promises';export async function run(){await writeFile(${JSON.stringify(marker)},'bad');return {status:'COMPLETED',output:{bad:true},artifacts:[]};}`);
  const controller=new AbortController(),launched=[];
  const adapter={name:'codex',id:'codex',capabilities:['model','codex'],launch(task){
    launched.push({id:task.id,agent:task.agentName});
    const source={id:`job/${f.id}/task/${task.id}/execution/${task.executionId}`};
    void (async()=>{
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.started','running','mock started','user',undefined,source));
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,task.agentName==='troubleshooter'?'task.completed':'task.failed',task.agentName==='troubleshooter'?'succeeded':'failed','fault injected','orchestrator',{},source));
      if(task.agentName==='troubleshooter')controller.abort(new Error('Stop after recovery evidence is durable'));
    })().catch(error=>{throw error;});
    return {id:'mock-'+task.id,launched:Promise.resolve(),promise:Promise.resolve({summary:'mock exit'}),cancel(){}};
  }};
  const reconciler=f.makeReconciler(adapter),stop=await reconciler.watch(f.id);
  try{
    const {result,job}=await f.execute(reconciler,AbortSignal.any([controller.signal,AbortSignal.timeout(3000)]));
    assert.equal(result.outcome.status,'FAILED');
    assert.equal(job.tasks.find(x=>x.id==='shortcut-initial-M').state,'FAILED');
    assert.equal(job.tasks.find(x=>x.id==='troubleshoot-shortcut-initial-M').state,'SUCCEEDED');
    assert.deepEqual(launched.map(x=>x.id),['shortcut-initial-M','troubleshoot-shortcut-initial-M']);
    assert.equal(job.tasks[0].result.data.shortcut.nodes.C,undefined);
    assert.equal(existsSync(marker),false);
  } finally{await stop();}
});

test('D02 fault F03: model failure recovered by foreground Troubleshooter retries same Worker node and completes DAG',async t=>{
  const f=await mixedFixture(t,'D02-code-model-code.mmd');
  const {mkdir}=await import('node:fs/promises'),{dirname}=await import('node:path');
  const {dispatchTaskAction}=await import('../dist/task-actions.js');
  await f.writeShortcut(f.project,'source',`export async function run(){return {status:'COMPLETED',output:{source:true},artifacts:[]};}`);
  const marker=join(f.directory,'finish-times');
  await f.writeShortcut(f.project,'finish',`import {appendFile} from 'node:fs/promises';export async function run({input}){
    if(!input.predecessorOutputs.M.recovered)throw Error('missing recovered Worker result');
    await appendFile(${JSON.stringify(marker)},'x');return {status:'COMPLETED',output:{done:true},artifacts:[]};}`);
  let modelAttempts=0,troubleshootAttempts=0;
  const adapter={name:'codex',id:'codex',capabilities:['model','codex'],launch(task){
    const source={id:`job/${f.id}/task/${task.id}/execution/${task.executionId}`};
    void (async()=>{
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.started','running','mock started','user',undefined,source));
      if(task.agentName==='troubleshooter'){
        troubleshootAttempts++;
        await dispatchTaskAction(f.store,{id:'task.recover',jobId:f.id,taskId:'shortcut-initial-M',
          recoveryTaskId:task.id,recoveryDiagnosis:{failureKind:'model_failure',reason:'injected model failure',evidence:'synthetic event transcript',reroute:false,excludeCurrentRoute:false}});
        await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.completed','succeeded','recovery accepted','orchestrator',{},source));
        return;
      }
      modelAttempts++;
      if(modelAttempts===1){
        await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.failed','failed','injected failure','orchestrator',{reason:'model_failure'},source));
      }else{
        await mkdir(dirname(task.output.path),{recursive:true});
        await writeFile(task.output.path,JSON.stringify({status:'COMPLETED',output:{recovered:true},artifacts:[]}));
        await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.completed','succeeded','model recovered','orchestrator',{},source));
      }
    })().catch(error=>{throw error;});
    return {id:`mock-${task.id}`,launched:Promise.resolve(),promise:Promise.resolve({summary:'mock exited'}),cancel(){}};
  }};
  const reconciler=f.makeReconciler(adapter),stop=await reconciler.watch(f.id);
  try{
    const {result,job}=await f.execute(reconciler,AbortSignal.timeout(4000));
    assert.equal(result.outcome.status,'COMPLETED',JSON.stringify({outcome:result.outcome,tasks:job.tasks.map(x=>[x.id,x.state,x.attempt,x.error])}));
    assert.equal(job.state,'COMPLETED');
    assert.equal(modelAttempts,2);
    assert.equal(troubleshootAttempts,1);
    assert.equal(job.tasks.filter(x=>x.id==='shortcut-initial-M').length,1);
    assert.equal(job.tasks.find(x=>x.id==='shortcut-initial-M').state,'SUCCEEDED');
    assert.equal(job.tasks.find(x=>x.id==='troubleshoot-shortcut-initial-M').state,'SUCCEEDED');
    assert.equal(job.tasks[0].result.data.shortcut.nodes.C.output.done,true);
    assert.equal(await readFile(marker,'utf8'),'x','downstream module must run exactly once');
  } finally {await stop();}
});

test('D02 live-regression: foreground Graph parent never receives ordinary Worker inactivity watchdog (timeoutMs=0)',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:source] --> M[agent:model]'});
  const rawStore=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  await rawStore.mutateJob(f.id,job=>{
    const task=job.tasks[0];
    task.state='RUNNING';task.timeoutMs=0;task.attempt=1;
    task.executionId='direct-parent-execution';task.leaseOwner='shortcut-foreground-owner';
    task.leaseExpiresAt=new Date(Date.now()+60_000).toISOString();
    task.executionHistory=[{id:'direct-parent-execution',attempt:1,startedAt:new Date().toISOString()}];
    task.result={summary:'Graph checkpoint',data:{shortcut:{version:1,graphHash:'synthetic',inputHash:'synthetic',shortcutHash:'synthetic',nodes:{A:{status:'COMPLETED',output:{ok:true},artifacts:[]}},waits:{},workerNodes:{M:'shortcut-initial-M'},inFlight:{M:'direct-parent-execution'},artifactHashes:{}}}};
    return job;
  });
  const store=new Proxy(rawStore,{get(target,key){if(key==='load')return target.loadJob.bind(target);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const bus=new MemoryEventBus();
  const reconciler=managedReconciler(store,{shortcutRunnerOwner:true,noGitHub:true,owner:'watchdog-regression',eventBus:bus,
    adapters:[],maxConcurrent:1,headShaProvider:()=>null,projectPathForJob:()=>f.project});
  const unwatch=await reconciler.watch(f.id);
  try {
    await reconciler.reconcile(f.id);
    await new Promise(resolve=>setTimeout(resolve,90));
    const actual=await store.load(f.id);
    assert.equal(actual.tasks[0].state,'RUNNING',JSON.stringify(actual.tasks.map(x=>({id:x.id,state:x.state,error:x.error}))));
    assert.equal(actual.tasks.some(x=>x.agentName==='troubleshooter'),false);
  } finally {await unwatch();rawStore.close();}
});

test('D02 fault F04: Worker {path,type} file records normalize with checked artifact hashes and unblock code successor',async t=>{
  const f=await mixedFixture(t,'D02-code-model-code.mmd');
  const {mkdir}=await import('node:fs/promises'),{dirname}=await import('node:path');
  const artifact=join(f.project,'director-story.txt');
  await f.writeShortcut(f.project,'source',`export async function run(){return {status:'COMPLETED',output:{source:true},artifacts:[]};}`);
  await f.writeShortcut(f.project,'finish',`export async function run({input}){
    if(input.predecessorOutputs.M.good!==true)throw Error('Model output missing at code successor');
    return {status:'COMPLETED',output:{end:true},artifacts:[]};}`);
  const adapter={name:'codex',id:'codex',capabilities:['model','codex'],launch(task){
    const source={id:`job/${f.id}/task/${task.id}/execution/${task.executionId}`};
    void (async()=>{
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.started','running','fixture start','user',undefined,source));
      await mkdir(dirname(task.output.path),{recursive:true});
      await writeFile(artifact,'verified file bytes');
      await writeFile(task.output.path,JSON.stringify({status:'COMPLETED',output:{good:true},artifacts:[{path:artifact,type:'file'}]}));
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.completed','succeeded','fixture terminal','orchestrator',{},source));
    })().catch(error=>{throw error;});
    return {id:'mock-record-output',launched:Promise.resolve(),promise:Promise.resolve({summary:'mock ended'}),cancel(){}};
  }};
  const reconciler=f.makeReconciler(adapter),stop=await reconciler.watch(f.id);
  try {
    const {result,job}=await f.execute(reconciler);
    assert.equal(result.outcome.status,'COMPLETED',JSON.stringify(result.outcome));
    assert.equal(job.state,'COMPLETED');
    assert.equal(job.tasks[0].result.data.shortcut.nodes.M.artifacts[0],artifact);
    assert.ok(job.tasks[0].result.data.shortcut.artifactHashes.M['director-story.txt']);
    assert.equal(job.tasks[0].result.data.shortcut.nodes.C.output.end,true);
  } finally {await stop();}
});

test('D02 fault F04b: Worker exact {path} file records normalize with checked artifact hashes and unblock code successor',async t=>{
  const f=await mixedFixture(t,'D02-code-model-code.mmd');
  const {mkdir}=await import('node:fs/promises'),{dirname}=await import('node:path');
  const artifact=join(f.project,'director-story.txt');
  await f.writeShortcut(f.project,'source',`export async function run(){return {status:'COMPLETED',output:{source:true},artifacts:[]};}`);
  await f.writeShortcut(f.project,'finish',`export async function run({input}){
    if(input.predecessorOutputs.M.good!==true)throw Error('Model output missing at code successor');
    return {status:'COMPLETED',output:{end:true},artifacts:[]};}`);
  const adapter={name:'codex',id:'codex',capabilities:['model','codex'],launch(task){
    const source={id:`job/${f.id}/task/${task.id}/execution/${task.executionId}`};
    void (async()=>{
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.started','running','fixture start','user',undefined,source));
      await mkdir(dirname(task.output.path),{recursive:true});
      await writeFile(artifact,'verified file bytes');
      await writeFile(task.output.path,JSON.stringify({status:'COMPLETED',output:{good:true},artifacts:[{path:artifact}]}));
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.completed','succeeded','fixture terminal','orchestrator',{},source));
    })().catch(error=>{throw error;});
    return {id:'mock-path-only-output',launched:Promise.resolve(),promise:Promise.resolve({summary:'mock ended'}),cancel(){}};
  }};
  const reconciler=f.makeReconciler(adapter),stop=await reconciler.watch(f.id);
  try {
    const {result,job}=await f.execute(reconciler);
    assert.equal(result.outcome.status,'COMPLETED',JSON.stringify(result.outcome));
    assert.equal(job.state,'COMPLETED');
    assert.equal(job.tasks[0].result.data.shortcut.nodes.M.artifacts[0],artifact);
    assert.ok(job.tasks[0].result.data.shortcut.artifactHashes.M['director-story.txt']);
    assert.equal(job.tasks[0].result.data.shortcut.nodes.C.output.end,true);
  } finally {await stop();}
});

test('D02 F04c: a canonical Project Run Worker may return Run-relative Editor artifacts',async t=>{
  const f=await mixedFixture(t,'D02-code-model-code.mmd');
  const {mkdir}=await import('node:fs/promises');
  const {dirname}=await import('node:path');
  const canonicalRun=join(f.project,'runs','2026-11-07-editor-e2e');
  await mkdir(canonicalRun,{recursive:true});
  await f.store.mutateJob(f.id,job=>{
    job.tasks[0].output={kind:'file',path:join(canonicalRun,'job-output.json')};
    job.tasks[0].input=`- Canonical run: ${canonicalRun}`;
    return job;
  });
  const file=join(canonicalRun,'edit-decision-list.json');
  await f.writeShortcut(f.project,'source',`export async function run(){return {status:'COMPLETED',output:{source:true},artifacts:[]};}`);
  await f.writeShortcut(f.project,'finish',`export async function run({input}){
    if(input.predecessorOutputs.M.edited!==true)throw Error('missing Editor result');
    return {status:'COMPLETED',output:{end:true},artifacts:[]};}`);
  let launches=0;
  const adapter={name:'codex',id:'codex',capabilities:['model','codex'],launch(task){
    launches++;
    const source={id:`job/${f.id}/task/${task.id}/execution/${task.executionId}`};
    void (async()=>{
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.started','running','fixture start','user',undefined,source));
      await mkdir(dirname(task.output.path),{recursive:true});
      await writeFile(file,'verified Editor output');
      await writeFile(task.output.path,JSON.stringify({status:'COMPLETED',output:{edited:true},artifacts:['edit-decision-list.json']}));
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.completed','succeeded','fixture complete','orchestrator',{},source));
    })().catch(error=>{throw error;});
    return {id:'mock-run-relative-editor',launched:Promise.resolve(),promise:Promise.resolve({summary:'exit'}),cancel(){}};
  }};
  const reconciler=f.makeReconciler(adapter),stop=await reconciler.watch(f.id);
  try{
    const {result,job}=await f.execute(reconciler);
    assert.equal(result.outcome.status,'COMPLETED',JSON.stringify(result.outcome));
    assert.equal(job.state,'COMPLETED');
    assert.equal(launches,1);
    assert.equal(job.tasks[0].result.data.shortcut.artifactHashes.M['runs/2026-11-07-editor-e2e/edit-decision-list.json'].length,64);
    assert.equal(job.tasks[0].result.data.shortcut.nodes.C.output.end,true);
  }finally{await stop();}
});

test('D02 F04d: Worker {path,kind:description} identifies only actual run files and validates SHA',async t=>{
  const f=await mixedFixture(t,'D02-code-model-code.mmd');
  const {mkdir}=await import('node:fs/promises');
  const {dirname}=await import('node:path');
  const run=join(f.project,'runs','2026-11-07-test');await mkdir(run,{recursive:true});
  await f.store.mutateJob(f.id,job=>{job.tasks[0].output={kind:'file',path:join(run,'finished.json')};return job;});
  await f.writeShortcut(f.project,'source',`export async function run(){return {status:'COMPLETED',output:{source:true},artifacts:[]};}`);
  await f.writeShortcut(f.project,'finish',`export async function run({input}){if(!input.predecessorOutputs.M.story)throw Error('missing verified story');return {status:'COMPLETED',output:{ok:true},artifacts:[]};}`);
  const file=join(run,'story.md');
  const adapter={name:'codex',id:'codex',capabilities:['model','codex'],launch(task){
    const source={id:`job/${f.id}/task/${task.id}/execution/${task.executionId}`};
    void (async()=>{
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.started','running','fixture start','user',undefined,source));
      await mkdir(dirname(task.output.path),{recursive:true});
      await writeFile(file,'source verified story');
      await writeFile(task.output.path,JSON.stringify({status:'COMPLETED',output:{story:true},artifacts:[{path:'story.md',kind:'complete first-person narrative'}]}));
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.completed','succeeded','fixture end','orchestrator',{},source));
    })().catch(error=>{throw error;});
    return {id:'mock-kind-description',launched:Promise.resolve(),promise:Promise.resolve({summary:'exit'}),cancel(){}};
  }};
  const reconciler=f.makeReconciler(adapter),stop=await reconciler.watch(f.id);
  try{
    const {result,job}=await f.execute(reconciler);
    assert.equal(result.outcome.status,'COMPLETED',JSON.stringify(result.outcome));
    assert.equal(job.state,'COMPLETED');
    assert.equal(job.tasks[0].result.data.shortcut.artifactHashes.M['runs/2026-11-07-test/story.md'].length,64);
  }finally{await stop();}
});

test('D02 fault F05: non-file artifact records are rejected despite terminal success',async t=>{
  const f=await mixedFixture(t,'D02-code-model-code.mmd');
  const {mkdir}=await import('node:fs/promises'),{dirname}=await import('node:path');
  await f.writeShortcut(f.project,'source',`export async function run(){return {status:'COMPLETED',output:{source:true},artifacts:[]};}`);
  const marker=join(f.directory,'bad-successor');
  await f.writeShortcut(f.project,'finish',`import {writeFile} from 'node:fs/promises';export async function run(){await writeFile(${JSON.stringify(marker)},'bad');return {status:'COMPLETED',output:{bad:true},artifacts:[]};}`);
  const adapter={name:'codex',id:'codex',capabilities:['model','codex'],launch(task){
    const source={id:`job/${f.id}/task/${task.id}/execution/${task.executionId}`};
    void (async()=>{
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.started','running','fixture start','user',undefined,source));
      await mkdir(dirname(task.output.path),{recursive:true});
      await writeFile(task.output.path,JSON.stringify({status:'COMPLETED',output:{fake:true},artifacts:[{path:'/tmp/not-a-file',type:'external'}]}));
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.completed','succeeded','fixture terminal','orchestrator',{},source));
    })().catch(error=>{throw error;});
    return {id:'mock-invalid-record',launched:Promise.resolve(),promise:Promise.resolve({summary:'mock ended'}),cancel(){}};
  }};
  const reconciler=f.makeReconciler(adapter),stop=await reconciler.watch(f.id);
  try {
    const {result,job}=await f.execute(reconciler);
    assert.equal(result.outcome.status,'FAILED');
    assert.match(result.outcome.reason,/unsupported artifact entry/);
    assert.equal(job.tasks.find(x=>x.id==='shortcut-initial-M').state,'SUCCEEDED');
    assert.equal(job.tasks[0].result.data.shortcut.nodes.C,undefined);
    assert.equal(existsSync(marker),false);
  } finally {await stop();}
});

test('D02 fault F06: retry failed parent retains completed Worker and Code nodes without duplicate effects',async t=>{
  const f=await mixedFixture(t,'D02-code-model-code.mmd');
  const {mkdir}=await import('node:fs/promises'),{dirname}=await import('node:path');
  const {dispatchTaskAction}=await import('../dist/task-actions.js');
  const sourceRuns=join(f.directory,'source-runs'),finishRuns=join(f.directory,'finish-runs');
  await f.writeShortcut(f.project,'source',`import {appendFile} from 'node:fs/promises';export async function run(){await appendFile(${JSON.stringify(sourceRuns)},'s');return {status:'COMPLETED',output:{source:'one'},artifacts:[]};}`);
  await f.writeShortcut(f.project,'finish',`import {appendFile,readFile} from 'node:fs/promises';export async function run({input}){await appendFile(${JSON.stringify(finishRuns)},'f');const times=(await readFile(${JSON.stringify(finishRuns)},'utf8')).length;if(times===1)throw Error('injected final code fault');if(input.predecessorOutputs.M.model!=='one')throw Error('lost Worker predecessor');return {status:'COMPLETED',output:{done:true},artifacts:[]};}`);
  let workerLaunches=0;
  const adapter={name:'codex',id:'codex',capabilities:['model','codex'],launch(task){
    workerLaunches++;
    const source={id:`job/${f.id}/task/${task.id}/execution/${task.executionId}`};
    void (async()=>{
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.started','running','started','user',undefined,source));
      await mkdir(dirname(task.output.path),{recursive:true});
      await writeFile(task.output.path,JSON.stringify({status:'COMPLETED',output:{model:'one'},artifacts:[]}));
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.completed','succeeded','completed','orchestrator',{},source));
    })().catch(error=>{throw error;});
    return {id:'fake-worker',launched:Promise.resolve(),promise:Promise.resolve({summary:'exit'}),cancel(){}};
  }};
  const reconciler=f.makeReconciler(adapter),stop=await reconciler.watch(f.id);
  try{
    const first=await f.execute(reconciler);
    assert.equal(first.result.outcome.status,'FAILED');
    assert.match(first.result.outcome.reason,/injected final code fault/);
    assert.equal(first.job.tasks[0].state,'FAILED');
    assert.deepEqual(Object.keys(first.job.tasks[0].result.data.shortcut.nodes),['A','M']);
    assert.equal(first.job.tasks.find(x=>x.id==='shortcut-initial-M').state,'SUCCEEDED');
    assert.equal(workerLaunches,1);
    const firstStart=first.job.shortcutExecutionStartedAt;
    await dispatchTaskAction(f.store,{id:'task.retry',jobId:f.id,taskId:'initial'});
    const second=await f.execute(reconciler);
    assert.equal(second.result.outcome.status,'COMPLETED',JSON.stringify(second.result.outcome));
    assert.equal(second.job.state,'COMPLETED');
    assert.equal(second.job.tasks[0].result.data.shortcut.terminal,undefined,'retry terminal must not retain the previous failed verdict');
    assert.equal(second.job.shortcutExecutionStartedAt,firstStart);
    assert.equal(second.job.tasks.filter(x=>x.id==='shortcut-initial-M').length,1);
    assert.equal(workerLaunches,1,'existing Worker node must not be reexecuted on parent retry');
    assert.equal(await readFile(sourceRuns,'utf8'),'s','completed Code node must not replay');
    assert.equal(await readFile(finishRuns,'utf8'),'ff','only failed code successor should retry');
    assert.equal(second.job.tasks[0].result.data.shortcut.nodes.C.output.done,true);
  }finally{await stop();}
});

test('D02 fault F08: Worker {kind:file,path} records normalize and validate hashes before code successor',async t=>{
  const f=await mixedFixture(t,'D02-code-model-code.mmd');
  const {mkdir}=await import('node:fs/promises'),{dirname}=await import('node:path');
  const artifact=join(f.project,'editor-decision.json');
  await f.writeShortcut(f.project,'source',`export async function run(){return {status:'COMPLETED',output:{source:true},artifacts:[]};}`);
  await f.writeShortcut(f.project,'finish',`export async function run({input}){
    if(input.predecessorOutputs.M.good!==true)throw Error('Model output missing at code successor');
    return {status:'COMPLETED',output:{end:true},artifacts:[]};}`);
  const adapter={name:'codex',id:'codex',capabilities:['model','codex'],launch(task){
    const source={id:`job/${f.id}/task/${task.id}/execution/${task.executionId}`};
    void (async()=>{
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.started','running','fixture start','user',undefined,source));
      await mkdir(dirname(task.output.path),{recursive:true});
      await writeFile(artifact,'verified file bytes');
      await writeFile(task.output.path,JSON.stringify({status:'COMPLETED',output:{good:true},artifacts:[{path:artifact,kind:'file'}]}));
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.completed','succeeded','fixture terminal','orchestrator',{},source));
    })().catch(error=>{throw error;});
    return {id:'mock-record-output',launched:Promise.resolve(),promise:Promise.resolve({summary:'mock ended'}),cancel(){}};
  }};
  const reconciler=f.makeReconciler(adapter),stop=await reconciler.watch(f.id);
  try {
    const {result,job}=await f.execute(reconciler);
    assert.equal(result.outcome.status,'COMPLETED',JSON.stringify(result.outcome));
    assert.equal(job.state,'COMPLETED');
    assert.equal(job.tasks[0].result.data.shortcut.nodes.M.artifacts[0],artifact);
    assert.ok(job.tasks[0].result.data.shortcut.artifactHashes.M['editor-decision.json']);
    assert.equal(job.tasks[0].result.data.shortcut.nodes.C.output.end,true);
  } finally {await stop();}
});

test('D02 fault F09: Worker may read checked canonical Run evidence without violating predecessor-only DAG outputs',async t=>{
  const f=await mixedFixture(t,'D02-code-model-code.mmd');
  const {mkdir}=await import('node:fs/promises'),{dirname}=await import('node:path');
  const manifest=join(f.directory,'source-manifest.json'),story=join(f.directory,'story.md'),ref=join(f.directory,'source-reference.json');
  await writeFile(manifest,JSON.stringify({source_use:{approved:true,scope:'private fixture'},media:[{id:'fixture',sha256:'synthetic'}]}));
  await writeFile(story,'# Provenance-tagged director stage evidence\n');
  await writeFile(ref,JSON.stringify({sourceRunPath:f.directory}));
  await f.rawStore.mutateJob(f.id,job=>{job.tasks[0].input=`Process canonical Run.\n- Canonical run: ${f.directory}\n- Private input evidence: ${ref}\n`;return job;});
  await f.writeShortcut(f.project,'source',`export async function run(){return {status:'COMPLETED',output:{fromSource:'A'},artifacts:[]};}`);
  await f.writeShortcut(f.project,'finish',`export async function run({input}){if(input.predecessorOutputs.M.readRunEvidence!==true)throw Error('missing stage evidence receipt');return {status:'COMPLETED',output:{okay:true},artifacts:[]};}`);
  let observed;
  const adapter={name:'codex',id:'codex',capabilities:['model','codex'],launch(task){
    const source={id:`job/${f.id}/task/${task.id}/execution/${task.executionId}`};
    void (async()=>{
      const durable=await f.store.load(f.id),data=JSON.parse(durable.tasks.find(x=>x.id===task.id).input);
      const md=JSON.parse(await readFile(join(data.canonicalRunPath,'source-manifest.json'),'utf8'));
      const prior=await readFile(join(data.canonicalRunPath,'story.md'),'utf8');
      observed={run:data.canonicalRunPath,reference:data.sourceEvidencePath,predecessors:Object.keys(data.predecessorOutputs),instruction:data.instruction};
      if(!md.source_use.approved||!prior.startsWith('# Provenance'))throw Error('Canonical Run input evidence unavailable');
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.started','running','observed evidence','user',undefined,source));
      await mkdir(dirname(task.output.path),{recursive:true});
      await writeFile(task.output.path,JSON.stringify({status:'COMPLETED',output:{readRunEvidence:true},artifacts:[]}));
      await f.bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.completed','succeeded','fixture succeeded','orchestrator',{},source));
    })().catch(error=>{throw error;});
    return {id:'mock-read-run',launched:Promise.resolve(),promise:Promise.resolve({summary:'mock exited'}),cancel(){}};
  }};
  const reconciler=f.makeReconciler(adapter),stop=await reconciler.watch(f.id);
  try{
    const {result,job}=await f.execute(reconciler);
    assert.equal(result.outcome.status,'COMPLETED',JSON.stringify(result.outcome));
    assert.equal(job.state,'COMPLETED');
    assert.equal(observed.run,f.directory);
    assert.equal(observed.reference,ref);
    assert.deepEqual(observed.predecessors,['A']);
    assert.match(observed.instruction,/prior stage artifact files/);
    assert.match(observed.instruction,/never infer an undeclared sibling dependency/);
    assert.equal(job.tasks[0].result.data.shortcut.nodes.C.output.okay,true);
  }finally{await stop();}
});

test('D02 fault F10: canonical Run path mismatch fails before model Worker creation or dispatch',async t=>{
  const f=await mixedFixture(t,'D02-code-model-code.mmd');
  await f.rawStore.mutateJob(f.id,job=>{job.tasks[0].input=`Process canonical Run.\n- Canonical run: ${f.directory}/not-the-bound-run\n`;return job;});
  await f.writeShortcut(f.project,'source',`export async function run(){return {status:'COMPLETED',output:{fromSource:'A'},artifacts:[]};}`);
  await f.writeShortcut(f.project,'finish',`export async function run(){throw Error('should not execute');}`);
  let launched=0;
  const adapter={name:'codex',id:'codex',capabilities:['model','codex'],launch(){launched++;throw Error('Worker launch must be impossible');}};
  const reconciler=f.makeReconciler(adapter),stop=await reconciler.watch(f.id);
  try{
    const {result,job}=await f.execute(reconciler);
    assert.equal(result.outcome.status,'FAILED');
    assert.match(result.outcome.reason,/canonical run does not match/);
    assert.equal(launched,0);
    assert.equal(job.tasks.length,1,'no wrong-run Worker Task may be created');
    assert.equal(job.tasks[0].result.data.shortcut.nodes.C,undefined);
  }finally{await stop();}
});
