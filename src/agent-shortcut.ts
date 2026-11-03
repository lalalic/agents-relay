import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { spawnOwnedProcess } from './owned-process.js';
import { parseAgentGraph } from './agent-graph.js';
import type { DurableStore } from './store.js';
import type { Job, Result, Task } from './types.js';
import { DurableTaskTransitionRuntime } from './workflow/durable-transition.js';
import { dispatchJobLifecycleSync } from './workflow/lifecycle.js';
import { dependencyReady } from './task-transitions.js';

export type ShortcutOutcome =
  | { status: 'COMPLETED'; output: Record<string, unknown>; artifacts: string[] }
  | { status: 'WAITING_EVENT'; event: { nodeId: string; id: string; revision: string; contentHash: string } }
  | { status: 'FAILED'; reason: string };
type ShortcutWait = { kind: 'nonhuman_result'; id: string; revision: string; contentHash: string; executionId: string };
type ShortcutReceipt = { jobId: string; taskId: string; nodeId: string; waitId: string; revision: string; executionId: string; contentSha256: string; output: Record<string, unknown>; recordedAt: string };
type Checkpoint = { version: 1; graphHash: string; inputHash: string; shortcutHash: string; workerFallback?: true; inFlight?: Record<string,string>; nodes: Record<string, Record<string, unknown>>; waits: Record<string, ShortcutWait>; receipts?: Record<string, ShortcutReceipt>; artifactHashes: Record<string, Record<string, string>> };
type ShortcutModule = { run(context: { input: Record<string, unknown>; signal: AbortSignal; runCommand(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> }): Promise<unknown> };

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const digestBytes = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value==='object') return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function checkpoint(task: Task): Checkpoint {
  const data = task.result?.data?.shortcut;
  return data && typeof data === 'object' ? structuredClone(data) as Checkpoint : { version: 1, graphHash: '', inputHash: '', shortcutHash: '', nodes: {}, waits: {}, artifactHashes: {} };
}
function validOutput(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).status === 'COMPLETED'
    && (value as Record<string, unknown>).output && typeof (value as Record<string, unknown>).output === 'object'
    && !Array.isArray((value as Record<string, unknown>).output)
    && ((Array.isArray((value as Record<string, unknown>).artifacts) && ((value as Record<string, unknown>).artifacts as unknown[]).every(item => typeof item === 'string'))
      || (Boolean((value as Record<string, unknown>).artifacts) && typeof (value as Record<string, unknown>).artifacts === 'object' && !Array.isArray((value as Record<string, unknown>).artifacts))));
}

export function shortcutContentSha256(output: unknown): string { return digest(canonical(output)); }

export async function recordShortcutReceipt(store: DurableStore, identity: {
  jobId: string; taskId: string; nodeId: string; waitId: string; revision: string; executionId: string; contentSha256: string; output: unknown;
}): Promise<ShortcutReceipt> {
  if (!store.mutateJob) throw new Error('Shortcut receipts require atomic Relay SQLite mutation');
  if (!validOutput(identity.output)) throw new Error('Shortcut receipt output must satisfy the completed shortcut result contract');
  if (!/^[0-9a-f]{64}$/i.test(identity.contentSha256) || shortcutContentSha256(identity.output) !== identity.contentSha256.toLowerCase()) throw new Error('Shortcut receipt content SHA256 does not match output');
  const receipt: ShortcutReceipt = { jobId: identity.jobId, taskId: identity.taskId, nodeId: identity.nodeId, waitId: identity.waitId,
    revision: identity.revision, executionId: identity.executionId, contentSha256: identity.contentSha256.toLowerCase(),
    output: structuredClone(identity.output), recordedAt: new Date().toISOString() };
  await store.mutateJob(identity.jobId, job => {
    const task = job.tasks.find(item => item.id === identity.taskId);
    const checkpoint = task?.result?.data?.shortcut as Checkpoint | undefined;
    const wait = checkpoint?.waits?.[identity.nodeId];
    if (job.executionMode !== 'shortcut' || job.contentOnly !== true || job.state !== 'ACTIVE' || job.pause || !task || !checkpoint || task.state !== 'RUNNING'
      || task.leaseOwner !== null || task.executionId !== identity.executionId || wait?.kind !== 'nonhuman_result'
      || wait.id !== identity.waitId || wait.revision !== identity.revision || wait.contentHash !== identity.contentSha256.toLowerCase()
      || wait.executionId !== identity.executionId) throw new Error('Shortcut receipt does not match an active persisted wait and execution');
    checkpoint.receipts ??= {};
    const existing = checkpoint.receipts[identity.nodeId];
    if (existing) {
      if (existing.jobId === receipt.jobId && existing.taskId === receipt.taskId && existing.nodeId === receipt.nodeId && existing.waitId === receipt.waitId
        && existing.revision === receipt.revision && existing.executionId === receipt.executionId && existing.contentSha256 === receipt.contentSha256
        && canonical(existing.output) === canonical(receipt.output)) return job;
      throw new Error('Conflicting shortcut receipt already exists for this wait');
    }
    if (checkpoint.nodes?.[identity.nodeId]) throw new Error('Shortcut wait result was already consumed');
    checkpoint.receipts[identity.nodeId] = receipt;
    return job;
  });
  return receipt;
}

function taskShortcutInput(input: string): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(input); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch { /* plain Task text remains available */ }
  return { taskInput: input };
}

function shortcutJobCompletionAllowed(job: Job): boolean {
  const graphs=job.tasks.filter(task=>task.agentGraph);
  return job.state==='ACTIVE' && job.executionMode==='shortcut' && job.contentOnly===true && job.prNumber===0 && !job.localMerge && job.autoMerge===false
    && job.reviewEnabled===false && !job.review && !(job.plans?.length) && job.tasks.length>0 && graphs.length>0
    && job.tasks.every(task=>task.state==='SUCCEEDED')
    && graphs.every(task=>{
      const run=task.result?.data?.shortcut as Checkpoint|undefined;
      return Boolean(run && run.graphHash && Object.keys(run.waits).length===0 && Object.keys(run.nodes).length===parseAgentGraph(task.agentGraph!).nodes.length);
    });
}

async function runCommand(args: string[], cwd: string, signal: AbortSignal): Promise<{ stdout: string; stderr: string; code: number }> {
  if (!Array.isArray(args) || args.length === 0 || args.some(item => typeof item !== 'string')) throw new Error('runCommand requires a non-empty argument array');
  const child = spawnOwnedProcess(args[0], args.slice(1), { invocation: 'shortcut.run-command', timeoutMs: 300_000, signal, spawn: { cwd, stdio: ['ignore','pipe','pipe'] } });
  let stdout = '', stderr = '';
  child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', chunk => { stdout += String(chunk); }); child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const [code] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
  return { stdout, stderr, code: code ?? -1 };
}

async function discoverShortcut(agent: string, projectPath: string, neoRoot?: string): Promise<string | null> {
  const file = `${agent}.agent.mjs`;
  const root=await realpath(projectPath);
  const project = resolve(root, 'agents', '.shortcut', file);
  if (existsSync(project)) { const actual=await realpath(project); if (!inside(root,actual)) throw new Error('Project shortcut symlink escapes project root'); return actual; }
  const shared = neoRoot ? resolve(neoRoot, 'agents', '.shortcut', file) : null;
  if (!shared || !existsSync(shared)) return null;
  const sharedRoot=await realpath(resolve(neoRoot!, 'agents', '.shortcut'));
  const actual=await realpath(shared);
  if (!inside(sharedRoot,actual)) throw new Error('Shared shortcut symlink escapes shortcut root');
  return actual;
}
function inside(root:string, path:string):boolean { const rel=relative(root,path); return rel==='' || (rel!=='..'&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel)); }
async function validateVisionerResult(result: Record<string, unknown>, projectRoot: string): Promise<void> {
  const artifacts=result.artifacts, output=result.output as Record<string,unknown>;
  if (!artifacts || Array.isArray(artifacts) || typeof artifacts!=='object' || !['vision-evidence.json','vision-segment-index.json','metadata.json'].every(name=>
    Object.prototype.hasOwnProperty.call(artifacts,name)&&typeof output[name]==='string')) throw new Error('Visioner requires evidence, index, and metadata artifacts');
  const files=artifacts as Record<string,unknown>;
  const evidence=files['vision-evidence.json'] as Record<string,unknown>|undefined;
  const index=files['vision-segment-index.json'] as Record<string,unknown>|undefined;
  const metadata=files['metadata.json'];
  if (!evidence||evidence.status!=='EVIDENCE_READY_UNREVIEWED'||evidence.stage!=='visioner'||!Array.isArray(evidence.sources)||!Array.isArray(evidence.observations)
    || !index||index.status!=='SOURCE_LINKED_UNREVIEWED'||!Array.isArray(index.sources)||!Array.isArray(index.observations)||!metadata||typeof metadata!=='object') throw new Error('Visioner artifacts do not satisfy the source-linked evidence contract');
  const artifactFiles=new Map<string,{bytes:Buffer;parsed:Record<string,unknown>}>();
  for(const name of ['vision-evidence.json','vision-segment-index.json','metadata.json']) {
    const actual=await realpath(resolve(projectRoot,String(output[name])));
    if(!inside(projectRoot,actual)) throw new Error(`Visioner artifact escapes project root: ${name}`);
    const bytes=await readFile(actual), parsed:unknown=JSON.parse(bytes.toString('utf8'));
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||canonical(parsed)!==canonical(files[name])) throw new Error(`Visioner structured artifact differs from file: ${name}`);
    artifactFiles.set(name,{bytes,parsed:parsed as Record<string,unknown>});
  }
  const evidenceFile=artifactFiles.get('vision-evidence.json')!, indexFile=artifactFiles.get('vision-segment-index.json')!, metadataFile=artifactFiles.get('metadata.json')!;
  if(evidence.vision_segment_index_sha256!==digestBytes(indexFile.bytes)||evidence.manifest_hash!==index.manifest_hash
    ||evidence.markcut_metadata_sha256!==index.markcut_metadata_sha256||index.markcut_metadata_sha256!==digestBytes(metadataFile.bytes)
    ||evidenceFile.parsed.status!=='EVIDENCE_READY_UNREVIEWED') throw new Error('Visioner evidence hashes or artifact contents do not match');
}

export async function runAgentShortcut(options: {
  store: DurableStore; job: Job; task: Task; projectPath: string; neoRoot?: string; concurrency?: number;
  leaseMs?: number; heartbeatMs?: number; resumeReceiptSelected?: true;
}): Promise<{ outcome: ShortcutOutcome; task: Task; fallback: boolean }> {
  const { store, job, task, projectPath, neoRoot } = options;
  if (!store.mutateJob) throw new Error('Shortcut execution requires atomic Relay SQLite mutation');
  const leaseMs=options.leaseMs??300_000, heartbeatMs=options.heartbeatMs??30_000;
  if(!Number.isSafeInteger(leaseMs)||leaseMs<100||!Number.isSafeInteger(heartbeatMs)||heartbeatMs<10||heartbeatMs>=leaseMs) throw new Error('Shortcut lease heartbeat must be positive and shorter than its lease');
  if (!task.agentGraph) throw new Error(`Task ${task.id} has no Agent Graph`);
  const graph = parseAgentGraph(task.agentGraph);
  const graphHash = digest(task.agentGraph);
  const inputHash = digest(task.input);
  const projectReal = await realpath(projectPath);
  const shortcuts = await Promise.all(graph.nodes.map(async node => {
    const path = await discoverShortcut(node.agent, projectReal, neoRoot);
    return { nodeId: node.id, path, hash: path ? digestBytes(await readFile(path)) : 'missing' };
  }));
  const shortcutHash = digest(canonical(shortcuts.map(item => [item.nodeId, item.hash])));
  const transitions = new DurableTaskTransitionRuntime(store);
  const owner = `shortcut-${process.pid}-${randomUUID()}`;
  let currentJob = await store.load(job.id);
  let currentTask = currentJob.tasks.find(item => item.id === task.id);
  if (!currentTask) throw new Error(`Task ${task.id} not found`);
  if (currentTask.agentGraph !== task.agentGraph || currentTask.input !== task.input)
    throw new Error('Shortcut invocation Task snapshot is stale; reload the durable Task before execution or receipt consumption');
  if(currentJob.executionMode!=='shortcut'||currentJob.contentOnly!==true) throw new Error('Shortcut execution requires durable shortcut and content-only Job policy');
  const existingShortcut=currentTask.result?.data?.shortcut as {workerFallback?:boolean}|undefined;
  if(existingShortcut?.workerFallback===true) throw new Error('Task is durably routed to the original Worker; shortcut execution is not authorized');
  if (currentJob.state!=='ACTIVE' || currentJob.pause) throw new Error(`Job ${job.id} is not runnable (${currentJob.state}${currentJob.pause?' paused':''})`);
  if (currentTask.state==='QUEUED' && !dependencyReady(currentTask,new Map(currentJob.tasks.map(item=>[item.id,item])))) throw new Error(`Task ${task.id} dependencies are not satisfied`);
  let state = checkpoint(currentTask);
  if (state.graphHash && (state.version !== 1 || state.graphHash !== graphHash || state.inputHash !== inputHash || state.shortcutHash !== shortcutHash)) throw new Error('Shortcut checkpoint fingerprint changed; refusing to reuse prior node output');
  state.version = 1; state.graphHash = graphHash; state.inputHash = inputHash; state.shortcutHash = shortcutHash;
  for (const [nodeId, receipt] of Object.entries(state.receipts ?? {})) {
    const wait = state.waits[nodeId];
    if (!wait || receipt.jobId !== job.id || receipt.taskId !== task.id || receipt.nodeId !== nodeId || receipt.waitId !== wait.id
      || receipt.revision !== wait.revision || receipt.executionId !== currentTask.executionId || receipt.executionId !== wait.executionId
      || receipt.contentSha256 !== wait.contentHash || shortcutContentSha256(receipt.output) !== receipt.contentSha256 || !validOutput(receipt.output))
      throw new Error(`Durable shortcut receipt ${nodeId} no longer matches its wait, execution, or content fingerprint`);
  }
  state.inFlight ??={};
  if(currentTask.state==='QUEUED'&&Object.keys(state.inFlight).length>0) throw new Error('Shortcut checkpoint contains an interrupted module execution; refusing automatic replay');
  state.artifactHashes ??= {};
  for (const [nodeId, hashes] of Object.entries(state.artifactHashes ?? {})) for (const [artifact, expected] of Object.entries(hashes)) {
    const actualPath = resolve(projectReal, artifact);
    let actual: string; try { actual = await realpath(actualPath); } catch { throw new Error(`Checkpoint artifact is missing: ${artifact}`); }
    if (!inside(projectReal, actual) || digestBytes(await readFile(actual)) !== expected) throw new Error(`Checkpoint artifact changed or escaped project: ${artifact}`);
    if (!state.nodes[nodeId]) throw new Error(`Checkpoint artifact has no completed node: ${nodeId}`);
  }
  if (currentTask.state === 'QUEUED') {
    await store.mutateJob(job.id, fresh => {
      const t = fresh.tasks.find(item => item.id === task.id);
      if (fresh.state!=='ACTIVE'||fresh.pause||!t||t.state !== 'QUEUED' || t.executionId !== null || t.agentGraph !== task.agentGraph || t.input !== task.input
        || !dependencyReady(t,new Map(fresh.tasks.map(item=>[item.id,item])))) throw new Error('Task is not available for shortcut claim or its input changed');
      t.attempt += 1; t.executionId = randomUUID(); t.leaseOwner = owner;
      t.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      t.executionHistory = [...(t.executionHistory ?? []), { id: t.executionId, attempt: t.attempt, startedAt: new Date().toISOString() }].slice(-8);
      return fresh;
    });
    currentTask = (await store.load(job.id)).tasks.find(item => item.id === task.id)!;
  } else if (currentTask.state !== 'RUNNING') throw new Error(`Task ${task.id} cannot run shortcuts from ${currentTask.state}`);

  if (currentTask.state === 'QUEUED') {
    if (!currentTask.executionId || !currentTask.leaseOwner || !store.reserveWorkflowLaunch) throw new Error('Shortcut execution requires the durable Graph-authorized launch claim');
    const reserved=await store.reserveWorkflowLaunch({jobId:job.id,taskId:task.id,executionId:currentTask.executionId,attempt:currentTask.attempt,leaseOwner:currentTask.leaseOwner});
    if (!reserved) throw new Error('Shortcut launch was already reserved; refusing duplicate execution');
    const started=await transitions.apply(job.id, task.id, 'task.started', { eligible: (_j, t) => t.state === 'QUEUED' && t.leaseOwner === owner });
    if (!started?.decision.accepted || !currentTask.executionId || await store.verifyWorkflowLaunch?.(job.id,task.id,currentTask.executionId)!=='Verified') throw new Error('Shortcut Task start did not verify against the durable launch claim');
  } else if (currentTask.leaseOwner && currentTask.leaseOwner !== owner) {
    throw new Error(`Task ${task.id} has an active or unreconciled execution lease`);
  } else if (!currentTask.leaseOwner) {
    if (!currentTask.executionId || !state.waits || !Object.keys(state.waits).some(nodeId => state.receipts?.[nodeId])) throw new Error('Only a persisted wait with a durable receipt can resume an unleased RUNNING Task');
    if (options.resumeReceiptSelected !== true) throw new Error('Shortcut receipt consumption must be selected by the Task Lifecycle graph');
    await store.mutateJob(job.id, fresh => {
      const t=fresh.tasks.find(item=>item.id===task.id);
      if (fresh.state!=='ACTIVE'||fresh.pause||!t || t.state!=='RUNNING' || t.executionId!==currentTask!.executionId || t.leaseOwner!==null)
        throw new Error('Shortcut wait claim was fenced by another execution');
      if (t.agentGraph !== task.agentGraph || t.input !== task.input) throw new Error('Shortcut Task input changed before receipt claim');
      t.leaseOwner=owner; t.leaseExpiresAt=new Date(Date.now()+leaseMs).toISOString(); return fresh;
    });
  }
  for (const [nodeId, receipt] of Object.entries(state.receipts ?? {})) {
    const wait = state.waits[nodeId];
    if (!wait) throw new Error(`Durable shortcut receipt ${nodeId} has no persisted wait`);
    if (state.nodes[nodeId]) throw new Error(`Shortcut receipt ${nodeId} was already consumed`);
    const artifactHashes: Record<string, string> = {};
    const output = receipt.output;
    const artifactPaths = Array.isArray(output.artifacts) ? output.artifacts as string[] : Object.entries(output.artifacts as Record<string, unknown>).map(([name, value]) => {
      if (!(name in (output.output as Record<string, unknown>)) || typeof (output.output as Record<string, unknown>)[name] !== 'string' || !value || typeof value !== 'object') throw new Error(`shortcut artifact ${name} lacks a structured artifact and output path`);
      return (output.output as Record<string, string>)[name];
    });
    for (const artifact of artifactPaths) {
      const actual = await realpath(isAbsolute(artifact) ? resolve(artifact) : resolve(projectReal, artifact));
      if (!inside(projectReal, actual)) throw new Error(`shortcut artifact outside project: ${artifact}`);
      artifactHashes[relative(projectReal, actual)] = digestBytes(await readFile(actual));
    }
    const nodeAgent=graph.nodes.find(node=>node.id===nodeId)?.agent;
    if(nodeAgent?.toLowerCase()==='visioner') await validateVisionerResult(output,projectReal);
    state.nodes[nodeId] = structuredClone(output);
    state.artifactHashes[nodeId] = artifactHashes;
    delete state.waits[nodeId];
    delete state.receipts?.[nodeId];
  }
  if (Object.keys(state.nodes).length > Object.keys(checkpoint(currentTask).nodes).length) await persist(state);

  const executionAbort=new AbortController();
  let leaseHeartbeatError:unknown;
  let heartbeatInFlight=false;
  const heartbeat=setInterval(()=>{
    if(heartbeatInFlight||executionAbort.signal.aborted)return;
    heartbeatInFlight=true;
    void store.mutateJob!(job.id,fresh=>{
      const t=fresh.tasks.find(item=>item.id===task.id);
      if(fresh.state!=='ACTIVE'||fresh.pause||!t||t.state!=='RUNNING'||t.executionId!==currentTask!.executionId||t.leaseOwner!==owner){
        throw new Error('Shortcut execution lease was fenced during module execution');
      }
      t.leaseExpiresAt=new Date(Date.now()+leaseMs).toISOString();
      return fresh;
    }).catch(error=>{leaseHeartbeatError=error;executionAbort.abort(error);}).finally(()=>{heartbeatInFlight=false;});
  },heartbeatMs);
  heartbeat.unref();
  const stopHeartbeat=():void=>clearInterval(heartbeat);
  let effectsStarted=false;
  let shortcutModuleEntered=false;

  try {
  const incoming = new Map(graph.nodes.map(node => [node.id, graph.edges.filter(edge => edge.to === node.id).map(edge => edge.from)]));
  const max = Math.max(1, Math.min(8, options.concurrency ?? 4));
  const shortcutByNode = new Map(shortcuts.map(item => [item.nodeId, item.path]));
  for (const wave of graph.waves) {
    const ready = wave.filter(id => !state.nodes[id] && !state.waits[id] && (incoming.get(id) ?? []).every(parent => Boolean(state.nodes[parent])));
    for (let offset = 0; offset < ready.length; offset += max) {
      const batch = ready.slice(offset, offset + max);
      for(const id of batch) if(shortcutByNode.get(id)) state.inFlight[id]=currentTask!.executionId!;
      if(batch.some(id=>Boolean(shortcutByNode.get(id)))) await persist(state);
      const outcomes = await Promise.all(batch.map(async id => {
        const node = graph.nodes.find(item => item.id === id)!;
        const shortcut = shortcutByNode.get(id) ?? null;
        if (!shortcut) return { id, value: null };
        try {
          shortcutModuleEntered=true;
          const module = await import(pathToFileURL(shortcut).href) as ShortcutModule;
          const predecessorOutputs = Object.fromEntries((incoming.get(id) ?? []).map(parent => [parent, state.nodes[parent]?.output]));
          const trackedRunCommand = async (args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> => {
            if(executionAbort.signal.aborted) throw new Error(`Shortcut execution was cancelled: ${String(leaseHeartbeatError??'lease lost')}`);
            effectsStarted = true;
            return runCommand(args, cwd, executionAbort.signal);
          };
          const raw = await module.run({ input: { ...taskShortcutInput(task.input), projectPath, jobId: job.id, taskId: task.id, nodeId: id, agent: node.agent, predecessorOutputs }, signal:executionAbort.signal, runCommand: trackedRunCommand });
          if(leaseHeartbeatError)throw new Error(`Shortcut lease renewal failed: ${String(leaseHeartbeatError)}`);
          if (!raw || typeof raw !== 'object') throw new Error('shortcut result must be an object');
          const result = raw as Record<string, unknown>;
          if (result.status === 'WAITING_EVENT' && result.event && typeof result.event === 'object') return { id, value: result };
          if (!validOutput(result)) throw new Error('shortcut returned an invalid COMPLETED result contract');
          const artifactPaths = Array.isArray(result.artifacts) ? result.artifacts as string[]
            : Object.entries(result.artifacts as Record<string, unknown>).map(([name, value]) => {
              if (!(name in (result.output as Record<string, unknown>)) || typeof (result.output as Record<string, unknown>)[name] !== 'string' || !value || typeof value !== 'object') throw new Error(`shortcut artifact ${name} lacks a structured artifact and output path`);
              return (result.output as Record<string, string>)[name];
            });
          const projectReal=await realpath(projectPath);
          if (node.agent.toLowerCase()==='visioner') await validateVisionerResult(result,projectReal);
          const artifactHashes: Record<string,string> = {};
          for (const artifact of artifactPaths) {
            if (!artifact) throw new Error('shortcut artifact path cannot be empty');
            const artifactPath=isAbsolute(artifact)?resolve(artifact):resolve(projectReal,artifact);
            let actual:string; try { actual=await realpath(artifactPath); } catch { throw new Error(`shortcut artifact missing: ${artifact}`); }
            if (!inside(projectReal,actual)) throw new Error(`shortcut artifact missing or outside project: ${artifact}`);
            const relativePath=relative(projectReal,actual);
            artifactHashes[relativePath]=digestBytes(await readFile(actual));
          }
          return { id, value: result, artifactHashes };
        } catch (error) { return { id, value: null, error: error instanceof Error ? error.message : String(error) }; }
      }));
      for (const result of outcomes) {
        if (!result.value) return await fallback(`No valid shortcut for ${result.id}${result.error ? `: ${result.error}` : ''}`);
        if (result.value.status === 'WAITING_EVENT') {
          const evt = result.value.event as Record<string, unknown>;
          if (evt.kind !== 'nonhuman_result') return await fallback('Shortcut event wait must be a nonhuman result; human approval must use Relay hostInvocation');
          if (typeof evt.id !== 'string' || typeof evt.revision !== 'string' || typeof evt.contentHash !== 'string'
            || (evt.nodeId!==undefined&&evt.nodeId!==result.id) || !/^[0-9a-f]{64}$/i.test(evt.contentHash)) return await fallback(`Invalid event wait from ${result.id}`);
          delete state.inFlight[result.id];
          state.waits[result.id] = { kind:'nonhuman_result', id: evt.id, revision: evt.revision, contentHash: evt.contentHash, executionId: currentTask!.executionId! };
        } else { delete state.inFlight[result.id]; state.nodes[result.id] = result.value; state.artifactHashes[result.id] = result.artifactHashes ?? {}; }
      }
      await persist(state);
    }
  }
  if (Object.keys(state.waits).length) {
    const released = await transitions.apply(job.id, task.id, 'shortcut.waiting', { eligible: (_j,t) => t.state==='RUNNING' && t.leaseOwner===owner });
    if (!released?.decision.accepted) throw new Error('Task lifecycle graph rejected shortcut.waiting');
    stopHeartbeat();
    const nodeId = Object.keys(state.waits)[0];
    return { outcome: { status: 'WAITING_EVENT', event: { nodeId, ...state.waits[nodeId] } }, task: await findTask(), fallback: false };
  }
    const finalResult: Result = { summary: `Shortcut Agent Graph completed (${graph.nodes.length} nodes)`, data: { shortcut: state } };
  const done = await transitions.apply(job.id, task.id, 'task.completed', {
    eligible: (_j,t) => t.state==='RUNNING' && t.leaseOwner===owner,
    mutate: (_j,t) => { t.result=finalResult; t.leaseOwner=null; t.leaseExpiresAt=null; t.executionId=null; }
  });
  if (!done?.decision.accepted) throw new Error('Task lifecycle graph rejected task.completed');
  stopHeartbeat();
  await store.mutateJob(job.id, current => {
    const allowed=shortcutJobCompletionAllowed(current);
    dispatchJobLifecycleSync(current, 'shortcut.completed', { shortcutCompletionAllowed: allowed });
    return current;
  });
  return { outcome: { status: 'COMPLETED', output: { nodes: state.nodes }, artifacts: Object.values(state.nodes).flatMap(node => {
    if (Array.isArray(node.artifacts)) return node.artifacts as string[];
    const output=node.output;
    return output && typeof output==='object' ? Object.values(output as Record<string,unknown>).filter((value):value is string=>typeof value==='string') : [];
  }) }, task: await findTask(), fallback: false };
  } finally { stopHeartbeat(); }

  async function persist(next: Checkpoint): Promise<void> {
    await store.mutateJob!(job.id, fresh => {
      const t = fresh.tasks.find(item => item.id === task.id);
      if (fresh.state!=='ACTIVE'||fresh.pause||!t || t.state !== 'RUNNING' || t.leaseOwner !== owner || !t.executionId) throw new Error('Shortcut checkpoint fenced by execution lease');
      const previous = t.result ?? { summary: 'Shortcut execution in progress', data: {} };
      t.result = { ...previous, data: { ...(previous.data ?? {}), shortcut: structuredClone(next) } };
      t.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      return fresh;
    });
  }
  async function findTask(): Promise<Task> { const fresh=await store.load(job.id); const found=fresh.tasks.find(item=>item.id===task.id); if (!found) throw new Error('Task disappeared'); return found; }
  async function fallback(reason: string): Promise<{ outcome: ShortcutOutcome; task: Task; fallback: boolean }> {
    const safe= !effectsStarted && !shortcutModuleEntered && Object.keys(state.inFlight??{}).length===0 && Object.keys(state.nodes).length===0;
    stopHeartbeat();
    const result=await transitions.apply(job.id,task.id,'shortcut.failed',{
      eligible:(_j,t)=>t.state==='RUNNING'&&t.leaseOwner===owner,
      facts:()=>({shortcutEffectsSafe:safe}),
      mutate:(_j,t,decision)=>{
        const workerFallback=decision.actions.includes('mutation.markShortcutWorkerFallback');
        const failure=workerFallback?reason:`Shortcut stopped after possible partial effects; Troubleshooter recovery required: ${reason}`;
        t.error=failure;
        const prior=t.result??{summary:'Shortcut execution failed',data:{}};
        t.result={...prior,data:{...(prior.data??{}),shortcut:{...state, ...(workerFallback?{workerFallback:true}:{})}}};
      },
    });
    if (!result?.decision.accepted) throw new Error(`Task lifecycle graph rejected shortcut failure: ${reason}`);
    const workerFallback=result.decision.actions.includes('mutation.markShortcutWorkerFallback');
    const failure=result.task.error??reason;
    return { outcome: { status: 'FAILED', reason:failure }, task: await findTask(), fallback: workerFallback };
  }
}

export function shortcutResumeEvent(_value: string): never {
  throw new Error('--event-json is disabled: manual JSON cannot authenticate a human approval or durable event receipt');
}
