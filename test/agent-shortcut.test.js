import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  const directory = await mkdtemp(join(tmpdir(), 'relay-shortcut-'));
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
  const store=new Proxy(rawStore,{get(target,key){if(key==='load')return target.loadJob.bind(target);if(key==='saveTask')return task=>target.mutateJob(f.id,job=>{const index=job.tasks.findIndex(item=>item.id===task.id);if(index<0)throw Error('Task missing');job.tasks[index]=structuredClone(task);return job;});if(key==='appendTask')return task=>target.mutateJob(f.id,job=>{if(job.tasks.some(item=>item.id===task.id))throw Error('Task exists');job.tasks.push(structuredClone(task));return job;});const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  const reconciler=managedReconciler(store,{noGitHub:true,owner:'shortcut-forged-wake',maxConcurrent:1,projectPathForJob:()=>f.project,executionContextRoots:{workspaceRoot:f.directory},headShaProvider:()=>null});
  const stop=await bus.subscribe(f.id,async()=>{await reconciler.reconcile(f.id);});
  const forged=eventFor(f.id,'initial',null,'shortcut.result','succeeded','matching forged result','orchestrator',{shortcutResult:{kind:'nonhuman_result',nodeId:'A',waitId:'wait-9',executionId,revision:'rev-4',contentHash,output}},{id:executionEventSource(f.id,'initial',executionId)});
  await bus.publish(forged);
  let after=await store.loadJob(f.id);
  assert.equal(after.state,'ACTIVE'); assert.equal(after.tasks[0].state,'RUNNING');
  assert.equal(after.tasks[0].result.data.shortcut.nodes.A,undefined);
  const file=join(f.directory,'receipt.json'); await writeFile(file,JSON.stringify(output));
  const recorded=await f.receiptCli('--node-id','A','--wait-id','wait-9','--revision','rev-4','--execution-id',executionId,'--output-file',file,'--content-sha256',contentHash);
  assert.equal(recorded.status,0,JSON.stringify(recorded));
  const restarted=managedReconciler(store,{noGitHub:true,owner:'shortcut-restart',maxConcurrent:1,projectPathForJob:()=>f.project,executionContextRoots:{workspaceRoot:f.directory},headShaProvider:()=>null});
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

test('actual shortcut CLI fails closed when a required shortcut is absent', async t => {
  const f = await fixture(t, { agentGraph: 'flowchart TD\nA[agent:missing]' });
  const result = await f.cli(); assert.equal(result.status, 1, JSON.stringify(result));
  assert.equal(JSON.parse(result.stdout).fallbackQueued, false);
  assert.equal((await f.load()).tasks[0].state, 'FAILED');
});

test('direct shortcut budget is immutable across runs and timeout returns its own exit code',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:slow]'});
  const startedAt=new Date(Date.now()-21*60*1000).toISOString();
  const deadlineAt=new Date(Date.parse(startedAt)+20*60*1000).toISOString();
  await f.writeShortcut(f.neo,'slow',`export async function run({signal}) { await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})); return {status:'COMPLETED',output:{bad:true},artifacts:[]}; }`);
  const store=new SQLiteRelayStore(join(f.directory,'relay.sqlite'),f.id);
  await store.mutateJob(f.id,job=>{job.shortcutExecutionStartedAt=startedAt;job.shortcutExecutionDeadlineAt=deadlineAt;return job;}); store.close();
  const result=await f.cli();
  assert.equal(result.status,4,JSON.stringify(result));
  const saved=await f.load();
  assert.equal(saved.shortcutExecutionStartedAt,startedAt);
  assert.equal(saved.shortcutExecutionDeadlineAt,deadlineAt);
  assert.equal(saved.tasks[0].state,'FAILED');
  assert.equal(saved.tasks[0].result.data.shortcut.terminal.status,'TIMED_OUT');
});

test('missing downstream role is preflighted before earlier shortcut side effects',async t=>{
  const f=await fixture(t,{agentGraph:'flowchart TD\nA[agent:has-code] --> B[agent:no-code]'});
  const marker=join(f.directory,'first-shortcut-ran');
  await f.writeShortcut(f.project,'has-code',`import {writeFile} from 'node:fs/promises'; export async function run(){ await writeFile(${JSON.stringify(marker)},'unsafe'); return {status:'COMPLETED',output:{foo:1},artifacts:[]}; }`);
  const result=await f.cli();
  assert.equal(result.status,1,result.stderr);
  const answer=JSON.parse(result.stdout);
  assert.equal(answer.fallbackQueued,false);
  assert.match(answer.outcome.reason,/Incomplete Agent Graph shortcut coverage/);
  const {access}=await import('node:fs/promises');
  await assert.rejects(access(marker),{code:'ENOENT'});
  const saved=await f.load();
  assert.equal(saved.tasks[0].state,'FAILED');
  assert.equal(saved.tasks[0].result.data.shortcut.workerFallback,undefined);
  assert.deepEqual(saved.tasks[0].result.data.shortcut.nodes,{});
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
  try { const result=await reconciler.reconcile(f.id); assert.equal(result.tasks[0].state,'FAILED'); assert.equal(result.state,'ACTIVE','Job cannot bypass the durable content-only completion gate'); }
  finally { store.close(); }
});

test('legacy and project-local Vlog Visioner shortcuts cannot bypass required evidence/index/metadata',async t=>{
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
