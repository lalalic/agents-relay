import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { missingShortcutNodes, recordShortcutReceipt, runAgentShortcut, shortcutResumeEvent } from './agent-shortcut.js';
import { parseAgentGraph } from './agent-graph.js';
import { tryTransitionTaskEvent } from './task-transitions.js';
import { dispatchJobLifecycleSync } from './workflow/lifecycle.js';
import type { DurableStore } from './store.js';
import type { EventBus } from './events.js';
import type { Reconciler } from './reconciler.js';
import { runShortcutModelNode } from './shortcut-node-worker.js';
import { noGitHubMode } from './no-github.js';
import { resolveManagedProjectPath, resolveRepositoryProjectPath, resolveWorkspaceRoot } from './workspace.js';
import { arg, hasArg, integerArg, publishWake, saveLocal, storeFor, textOption, withEventBus } from './cli-support.js';

function assertSqliteShortcutArgs(args: string[]): void {
  if (args.some(value => value === '--file' || value.startsWith('--file=')))
    throw new Error('Shortcut commands require the authoritative SQLite Relay store; --file is unsupported');
}

/** Apply the canonical Job Graph activate edge before the first direct run.
 * The Job is created DRAFT so creation alone cannot launch any work. */
export async function activateShortcutJobForDirectRun(store: DurableStore, jobId: string): Promise<void> {
  if (!store.mutateJob) throw new Error('Shortcut activation requires atomic SQLite Job mutation');
  await store.mutateJob(jobId, current => {
    if (current.executionMode !== 'shortcut' || current.contentOnly !== true)
      throw new Error('Only a content-only Shortcut Job may be activated by direct run');
    if (current.state === 'DRAFT') {
      const decision = dispatchJobLifecycleSync(current, 'activate');
      if (!decision.accepted || decision.target !== 'ACTIVE')
        throw new Error('Job Lifecycle graph rejected shortcut activation');
    } else if (current.state !== 'ACTIVE') {
      throw new Error(`Shortcut Job ${jobId} is not runnable (${current.state})`);
    }
    return current;
  });
}

export async function runShortcutJobCommand(args: string[], id: string, makeRunner?: (store: DurableStore, bus: EventBus | undefined) => Reconciler): Promise<void> {
  assertSqliteShortcutArgs(args);
  if (arg(args, '--mode') && arg(args, '--mode') !== 'shortcut') throw new Error('job run no longer selects an execution mode');
  const loaded = await storeFor(args, false, true);
  if (loaded.localFile !== null || !loaded.store.mutateJob || !loaded.store.reserveWorkflowLaunch)
    throw new Error('Shortcut execution requires the authoritative SQLite Relay store');
  const job = loaded.job;
  // An explicit graph start is an ordinary Job activation. Historical in-flight
  // direct Shortcut checkpoints alone continue through the archived runner below.
  const taskId = arg(args, '--task-id');
  if (!taskId) throw new Error('job run requires --task-id');
  let task = job.tasks.find(item => item.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  const legacy = hasArg(args,'--legacy-shortcut-runtime') || Boolean(task.result?.data?.shortcut);
  if (!legacy) {
    if (hasArg(args,'--event-json')) throw new Error('Normal Job activation does not accept a Shortcut runner event');
    const graphOverride = hasArg(args,'--agent-graph-file') ? await textOption(args,'--agent-graph','--agent-graph-file') : undefined;
    if(graphOverride)parseAgentGraph(graphOverride);
    const effectiveGraph=task.agentGraph??graphOverride;
    if(!effectiveGraph)throw new Error('job run requires a Task with an Agent Graph');
    const workspaceRoot=await resolveWorkspaceRoot(arg(args,'--workspace-root')||undefined);
    const projectRoot=await resolveManagedProjectPath(noGitHubMode(args)?undefined:job.repository,arg(args,'--project-path')||job.projectPath||'',workspaceRoot);
    const projectPath=resolveRepositoryProjectPath(projectRoot,job.projectPath);
    const globalRoot=arg(args,'--global-root')||process.env.AGENTS_HOME||undefined;
    const sharedRoot=arg(args,'--shared-root')||process.env.AGENTS_RELAY_SHARED_ROOT||undefined;
    await loaded.store.mutateJob(id,current=>{
      const root=current.tasks.find(t=>t.id===taskId);
      if(!root)throw Error('Graph Task disappeared');
      if(root.agentGraph && root.agentGraph!==effectiveGraph)throw Error('Graph Task changed since activation');
      if(root.state!=='QUEUED'&&root.state!=='RUNNING'&&root.state!=='DRAFT')throw Error('Graph Task is not startable: '+root.state);
      if(!root.agentGraph){if(root.state!=='QUEUED'&&root.state!=='DRAFT')throw Error('Graph cannot be replaced after Task started');root.agentGraph=effectiveGraph;}
      if(root.state==='DRAFT'){
        if(root.dependencies.length)throw Error('Graph root has unmet dependencies');
        const queued=tryTransitionTaskEvent(root,'queue',{dependenciesSatisfied:true});
        if(!queued.accepted||queued.target!=='QUEUED')throw Error('Task Lifecycle rejected Graph root queue');
      }
      const ctx={projectPath,workspaceRoot,...(sharedRoot?{sharedRoot}:{}),...(globalRoot?{globalRoot}:{}),noGitHub:noGitHubMode(args)};
      const existing=current.graphStartContext;
      if(existing&&(['projectPath','workspaceRoot','sharedRoot','globalRoot','noGitHub'] as const).some(k=>existing[k] !== ctx[k]))
        throw Error('Graph start context changed from first authorized invocation');
      if(!existing)current.graphStartContext=ctx;
      if(current.state==='DRAFT'){
        const decision=dispatchJobLifecycleSync(current,'activate');
        if(!decision.accepted||decision.target!=='ACTIVE')throw Error('Job Lifecycle rejected activation');
      }else if(current.state!=='ACTIVE')throw Error('Job is not runnable: '+current.state);
      return current;
    });
    const scheduled=await loaded.store.load(id);
    await withEventBus(args,bus=>publishWake(bus,scheduled,taskId,'Graph Job activated; ordinary Scheduler owns execution'));
    console.log(JSON.stringify({jobId:id,taskId,scheduled:true,state:scheduled.state,graphRuntime:'tasks',
      message:'Job activated; Relay Scheduler owns DAG Tasks, Reviews and recovery'},null,2));
    return;
  }
  if (job.executionMode !== 'shortcut' || job.contentOnly !== true)
    throw new Error('Legacy Shortcut runner requires its original archived Job policy');
  if (hasArg(args, '--event-json')) shortcutResumeEvent(arg(args, '--event-json'));
  if (!task.agentGraph && !hasArg(args, '--agent-graph-file')) throw new Error(`Task ${taskId} has no Agent Graph; set it on the Task or pass --agent-graph-file`);
  let resumeReceiptSelected=false;
  if(task.state==='RUNNING'&&task.leaseOwner===null&&task.executionId!==null) {
    const checkpoint=task.result?.data?.shortcut as {receipts?:Record<string,unknown>}|undefined;
    if(Object.keys(checkpoint?.receipts??{}).length>0) {
      const decision=tryTransitionTaskEvent(task,'shortcut.result',{shortcutResultCorrelated:true});
      if(!decision.accepted||!decision.actions.includes('effect.resumeShortcut')) throw new Error('Task Lifecycle graph did not select direct receipt resumption');
      resumeReceiptSelected=true;
    }
  }
  const graphOverride = hasArg(args, '--agent-graph-file') ? await textOption(args, '--agent-graph', '--agent-graph-file') : undefined;
  if (graphOverride) {
    parseAgentGraph(graphOverride);
    if (!loaded.store.mutateJob) throw new Error('Persisting an Agent Graph override requires atomic SQLite mutation');
    await loaded.store.mutateJob(id, current => {
      const durable = current.tasks.find(item => item.id === taskId);
      if (!durable) throw new Error(`Task ${taskId} not found`);
      if (durable.agentGraph && durable.agentGraph !== graphOverride) throw new Error('Cannot replace a durable Task Agent Graph');
      if (!durable.agentGraph && durable.state !== 'QUEUED') throw new Error('Agent Graph must be persisted before Task execution starts');
      durable.agentGraph = graphOverride;
      return current;
    });
    loaded.job = await loaded.store.load(id);
    task = loaded.job.tasks.find(item => item.id === taskId);
    if (!task) throw new Error(`Task ${taskId} disappeared`);
  }
  await activateShortcutJobForDirectRun(loaded.store, id);
  loaded.job = await loaded.store.load(id);
  const workspaceRoot = await resolveWorkspaceRoot(arg(args, '--workspace-root') || undefined);
  const projectRoot = await resolveManagedProjectPath(noGitHubMode(args) ? undefined : loaded.job.repository, arg(args, '--project-path') || loaded.job.projectPath || '', workspaceRoot);
  const projectPath = resolveRepositoryProjectPath(projectRoot, loaded.job.projectPath);
  const globalRoot = arg(args, '--global-root') || process.env.AGENTS_HOME || undefined;
  const sharedRoot=arg(args, '--shared-root') || process.env.AGENTS_RELAY_SHARED_ROOT || undefined;
  // The first trusted *explicit* invocation binds only resolved directories,
  // not a command. Daemon recovery must never guess a Project path or execute
  // argv serialized by an untrusted Task.
  if (!loaded.store.mutateJob) throw new Error('Shortcut Runner requires atomic context binding');
  await loaded.store.mutateJob(id,current=>{
    if(current.executionMode!=='shortcut'||current.state!=='ACTIVE')throw Error('Cannot bind context to an inactive Shortcut');
    const ctx={projectPath,workspaceRoot,...(sharedRoot?{sharedRoot}:{}),...(globalRoot?{globalRoot}:{}),noGitHub:noGitHubMode(args)};
    const old=current.shortcutRunnerContext;
    if(old && (old.projectPath!==ctx.projectPath||old.workspaceRoot!==ctx.workspaceRoot||
      old.sharedRoot!==ctx.sharedRoot||old.globalRoot!==ctx.globalRoot||old.noGitHub!==ctx.noGitHub))
      throw Error('Shortcut context changed from its original trusted launch; refusing inconsistent resume');
    if(!old)current.shortcutRunnerContext=ctx;
    return current;
  });
  // Shortcut is an explicit activation point, not a separate Task engine.
  // Previously launched, in-flight Shortcut checkpoints retain their legacy
  // foreground owner; new Jobs use the ordinary Reconciler/DAG Task path.
  const oldCheckpoint=(task.result?.data?.shortcut as object|undefined);
  const dagCheckpoint=(task.result?.data?.dag as {version?:number}|undefined);
  const unified=dagCheckpoint?.version===1 || (!hasArg(args,'--legacy-shortcut-runtime') && !oldCheckpoint && !job.shortcutExecutionStartedAt);
  if(unified){
    if(!loaded.store.mutateJob)throw Error('Unified DAG activation requires SQLite');
    const hash=createHash('sha256').update(task.agentGraph!).digest('hex');
    await loaded.store.mutateJob(id,current=>{
      const root=current.tasks.find(t=>t.id===taskId);
      if(current.state!=='ACTIVE'||!root||!root.agentGraph||root.agentGraph!==task!.agentGraph)
        throw Error('DAG activation Task identity changed');
      if(root.state!=='QUEUED' && root.state!=='RUNNING')throw Error('DAG Task cannot start from '+root.state);
      const prior=root.result?.data?.dag as {version?:number;graphHash?:string}|undefined;
      if(prior && (prior.version!==1||prior.graphHash!==hash))throw Error('DAG runtime identity changed');
      if(!prior)root.result={summary:'DAG ready',data:{...(root.result?.data??{}),dag:{version:1,graphHash:hash}}};
      if(!current.shortcutExecutionStartedAt)current.shortcutExecutionStartedAt=new Date().toISOString();
      return current;
    });
    const scheduled=await loaded.store.load(id);
    await withEventBus(args,bus=>publishWake(bus,scheduled,taskId,'Shortcut DAG activation (normal Task scheduler)'));
    console.log(JSON.stringify({jobId:id,taskId,mode:'shortcut',scheduled:true,state:scheduled.state,
      graphRuntime:'tasks',message:'Task scheduling and Review are owned by the ordinary Relay Reconciler'},null,2));
    return;
  }
  const missing = await missingShortcutNodes(task.agentGraph!, projectPath, sharedRoot, workspaceRoot, globalRoot);
  const previous = task.result?.data?.shortcut as { workerFallback?:boolean } | undefined;
  if (previous?.workerFallback === true)
    throw new Error('Legacy whole-Graph Worker fallback is not compatible with per-node Shortcut execution; retain its original recovery ownership');
  const controller=new AbortController();
  const onInterrupt=():void=>controller.abort(new Error('Interrupted by operator'));
  process.once('SIGINT',onInterrupt);process.once('SIGTERM',onInterrupt);
  const execute = async (bus: EventBus | undefined): Promise<void> => {
    const hasSemanticRevision=task?.state==='QUEUED' && task.interactiveInvocation?.status==='changes_requested' &&
      Boolean(task.interactiveInvocation.decidedAt) &&
      Object.values((task.result?.data?.shortcut as {inFlight?:Record<string,string>}|undefined)?.inFlight??{}).includes(task.interactiveInvocation.executionId);
    const workerReconciler = (missing.length || hasSemanticRevision) && bus && makeRunner ? makeRunner(loaded.store,bus) : undefined;
    const unwatch=workerReconciler ? await workerReconciler.watch(id) : undefined;
    try {
      const result = await runAgentShortcut({ store: loaded.store, job: loaded.job, task, projectPath,
        sharedRoot,
        workspaceRoot, globalRoot,
        concurrency: integerArg(args, '--concurrency', 4), signal:controller.signal,
        ...(resumeReceiptSelected?{resumeReceiptSelected:true as const}:{}),
        ...((missing.length || hasSemanticRevision) ? { runModelNode: node => {
          if (!workerReconciler) throw new Error('Model-backed node requires a reachable EventBus and existing Relay Worker Adapter');
          return runShortcutModelNode({store:loaded.store,reconciler:workerReconciler,jobId:id,parentTaskId:task!.id,node});
        } } : {}),
        onNodeEvent:event=>process.stderr.write(`shortcut.node ${JSON.stringify(event)}\n`) });
      console.log(JSON.stringify({ outcome: result.outcome, fallbackQueued: false, task: result.task }, null, 2));
      if(result.outcome.status==='FAILED') {
        const checkpoint=result.task.result?.data?.shortcut as {terminal?:{status?:string}}|undefined;
        process.exitCode=checkpoint?.terminal?.status==='TIMED_OUT'?4:checkpoint?.terminal?.status==='INTERRUPTED'?5:1;
      } else if(result.outcome.status==='WAITING_EVENT'||result.outcome.status==='WAITING_REVIEW') process.exitCode=3;
    } finally {
      await unwatch?.();
      await workerReconciler?.close();
    }
  };
  try {
    if(missing.length || (task?.state==='QUEUED' && task.interactiveInvocation?.status==='changes_requested' && Boolean(task.interactiveInvocation.decidedAt))) await withEventBus(args,execute);
    else await execute(undefined);
  } finally {process.removeListener('SIGINT',onInterrupt);process.removeListener('SIGTERM',onInterrupt);}
}

export async function recordShortcutReceiptCommand(args: string[], id: string): Promise<void> {
  assertSqliteShortcutArgs(args);
  const taskId = arg(args, '--task-id'), nodeId = arg(args, '--node-id'), waitId = arg(args, '--wait-id');
  const revision = arg(args, '--revision'), executionId = arg(args, '--execution-id'), outputFile = arg(args, '--output-file');
  const contentSha256 = arg(args, '--content-sha256');
  if (!taskId || !nodeId || !waitId || !revision || !executionId || !outputFile || !contentSha256)
    throw new Error('job shortcut-receipt requires --task-id --node-id --wait-id --revision --execution-id --output-file --content-sha256');
  if (outputFile === '-') throw new Error('--output-file requires a local file path');
  const { store, localFile } = await storeFor(args, false, true);
  if (localFile !== null || !store.mutateJob || !store.reserveWorkflowLaunch)
    throw new Error('Shortcut receipts require the authoritative SQLite Relay store');
  const bytes = await readFile(outputFile);
  const output: unknown = JSON.parse(bytes.toString('utf8'));
  const receipt = await recordShortcutReceipt(store, { jobId: id, taskId, nodeId, waitId, revision, executionId, contentSha256, output });
  const updated = await store.load(id);
  await saveLocal(localFile, updated);
  await withEventBus(args, bus => publishWake(bus, updated, taskId, 'Shortcut receipt recorded in Relay SQLite'));
  console.log(JSON.stringify({ receipt: { ...receipt, output: undefined }, jobId: id, taskId }, null, 2));
}
