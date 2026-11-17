#!/usr/bin/env node
import {escalationNotifierFromEnvironment} from './escalation-notifier.js';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ChatGptAdapter, CodexAdapter, ensureChatGptWebHelmReady } from './adapters.js';
import { ZAdapter } from './z-adapter.js';
import { CodexThreadContinuation, CommandContinuation, WebhookContinuation } from './continuation.js';
import { serveDashboard } from './dashboard.js';
import { RepositoryWorkerPool } from './pool.js';
import { Reconciler } from './reconciler.js';
import { dashboardManagedJobs, GitHubStore, InMemoryStore, ManagedJobOverview, resolvePullRequest, type DurableStore, type ManagedGitHubPullRequestSnapshot } from './store.js';
import { LocalAuthorityDurableStore } from './local-authority-store.js';
import { discoverLocalRelayStoreSnapshots, relayStoreDirectory, relayUnifiedStorePath, resolveUnifiedJobScope, SQLiteRelayStore } from './relay-store.js';
import { createJobIdRegistryResolver } from './local-job-registry.js';
import { reconcileCompletedLocalDelivery } from './local-merge-projection.js';
import { DisabledGitHubClient } from './no-github.js';
import { dashboardJobAction, isEntrypoint, runtimePlanner, runtimeReviewer, startService, SERVICE_DEFAULTS } from './cli.js';
import { eventBusResolutionMessage, publishTaskUnblocked, resolveEventBus } from './cli-support.js';
import { eventFor } from './events.js';
import { dispatchTaskAction } from './task-actions.js';
import { isEffectivelyBlocked, unblockTask } from './unblock.js';
import { registerBlockerDependency } from './blockers.js';
import { ensureManagedGitHubJob } from './cli-job-create.js';
import { applyJobActivateAction } from './job-actions.js';
import { managedTaskUpdateHandler } from './task-update.js';
import { dashboardJobSetState, dashboardTaskAction, dashboardTaskSetState } from './dashboard-actions.js';
import { codexAndZaiUsageRegistry } from './usage.js';
import { defaultWorkspaceRoot, ensureLocalJobSourceBranch, prepareLocalJobExecutionWorktree, resolveJobProjectRoot, resolveRepositoryProjectPath, taskRequiresManagedWorktree } from './workspace.js';
import { deriveJobRuntimeStatus } from './runtime-status.js';
import { createRuntimeStatusPublisher } from './runtime-status-events.js';
import { subscribeLocalCommits } from './local-commit-events.js';
import { decisionMode, executionDecisionEngine } from './decision.js';
import { JsonlDecisionAuditStore } from './decision-audit.js';
import { summarizeRuntime } from './runtime-summary.js';
import { executionRouterRulesPath } from './routing-policy.js';
import { workerCandidates } from './worker-routing.js';
import { discoverAgents } from './registry.js'; import { shutdownOwnedProcesses } from './owned-process.js';
import { routeExecution } from './execution-routing.js';
import { RelayObservability, classifyFailure, errorMessage, observability, setObservability } from './observability.js';
import { createWorkspaceControl } from './relayd-control.js';
import { createDashboardActions } from './relayd-dashboard-actions.js';
export { daemonHelp, normalizeDaemonArguments, overlayOperationalOverviews, mergeOperationalInventory, recoveryScanRepositories, shouldCoalescePullRequestRefresh, configureExecutionRouterRulesPath } from './relayd-utilities.js';
import { configureDaemonObservability, firstStageChoices, value, type GitHubReadPathDiagnostics, type PullRequestRefreshTrigger, daemonHelp, normalizeDaemonArguments, overlayOperationalOverviews, mergeOperationalInventory, recoveryScanRepositories, shouldCoalescePullRequestRefresh, configureExecutionRouterRulesPath } from './relayd-utilities.js';
export async function runDaemon(argv: readonly string[]): Promise<void> {
  const normalized = normalizeDaemonArguments(argv);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(daemonHelp); return; }
  configureDaemonObservability();
  configureExecutionRouterRulesPath(argv);
  try {
    await ensureChatGptWebHelmReady();
  } catch (error) {
    process.stderr.write(`WebHelm readiness check skipped: ${errorMessage(error)}\n`);
  }
  const noGitHub = true;
  const auth = null;
  const client = new DisabledGitHubClient();
  const trusted = new Set<string>();
  let githubAuthenticated: boolean | null = false;
  let githubAuthError: string | null = null;
  const concurrency = Number(value(argv,'--concurrency','4'));
  const eventResolution = await resolveEventBus([...argv]);
  const bus = eventResolution.bus;
  const stopRuntimeStatusEvents = bus ? subscribeLocalCommits(createRuntimeStatusPublisher(bus)) : () => {};
  process.stderr.write(`${eventBusResolutionMessage(eventResolution)}\n`);
  // Workspace is an optional execution/worktree placement hint, never a Job
  // discovery source. Do not stat, recursively scan, or infer a repository from
  // cwd / Workspace at daemon startup: only durable SQLite bindings select Jobs.
  const workspaceRoot = normalized.workspaceRoot ?? defaultWorkspaceRoot();
  const repositories = normalized.repository ? [normalized.repository] : [];
  const repositoryPaths = new Map<string, string>();
  const usageRegistry = codexAndZaiUsageRegistry();
  const decisionAuditStore = new JsonlDecisionAuditStore(process.env.AGENTS_RELAY_DECISION_AUDIT_PATH ?? join(homedir(), '.agents-relay', 'decision-audit.jsonl'));
  let cachedOverviews: ManagedJobOverview[] = [];
  const githubReadPaths: GitHubReadPathDiagnostics = { workspaceScans: 0, prRefreshes: 0, prRefreshesByTrigger: {}, prRefreshCoalesced: 0, prRefreshCoalescedByTrigger: {} };
  let dormantProbeIndex = 0;
  const relayStores = new Map<string, SQLiteRelayStore>();
  const runtimeStore = (repository: string, prNumber: number, seed?: import('./store.js').GitHubPullRequestSeed | null): DurableStore => {
    const key = `${repository}#${prNumber}`;
    let relay = relayStores.get(key);
    if (!relay) {
      const scope = resolveUnifiedJobScope(relayStoreDirectory(), repository, prNumber);
      relay = new SQLiteRelayStore(relayUnifiedStorePath(relayStoreDirectory()), scope);
      relayStores.set(key, relay);
    }
    const github = new GitHubStore(client, repository, prNumber, trusted, seed);
    const projected = new LocalAuthorityDurableStore(relay, github, (relatedRepository, relatedPrNumber) => runtimeStore(relatedRepository, relatedPrNumber), noGitHub);
    // SQLite PR facts are written through awaited webhook/action handlers; never seed detached remote snapshots.
    return projected;
  };
  const existingInventory = await discoverLocalRelayStoreSnapshots(relayStoreDirectory());
  for (const snapshot of existingInventory) for (const job of snapshot.jobs) {
    if (!repositories.includes(job.repository)) repositories.push(job.repository);
    // Blocker recovery needs a path for an existing repository: use the saved
    // immutable projectRoot, never a guessed Workspace-relative directory.
    if (job.projectRoot && !repositoryPaths.has(job.repository))
      repositoryPaths.set(job.repository, job.projectRoot);
  }
  const inventoryFromLocal = async (limitHistory = true): Promise<ManagedJobOverview[]> => {
    const snapshots = await discoverLocalRelayStoreSnapshots(relayStoreDirectory());
    const known = new Set(repositories);
    const entries = snapshots.flatMap(snapshot =>
      snapshot.jobs.filter(job => known.has(job.repository)).map(job => ({
        job, githubState: snapshot.facts?.state ?? 'UNKNOWN' as const,
        draft: false, mergedAt: null, closedAt: null, publication: snapshot.publications[job.id]?.latest ?? null, publicationFailure: snapshot.publications[job.id]?.failure ?? null,
      })));
    const counts = new Map<string, number>();
    for (const item of entries) if (!['COMPLETED','CANCELLED'].includes(item.job.state))
      counts.set(item.job.id, (counts.get(item.job.id) ?? 0) + 1);
    // Hide obsolete terminal snapshots only when one live authoritative Job exists.
    // Multiple live copies remain visible for diagnosis but cannot be mutated.
    const visible = entries.filter(item =>
      !['COMPLETED','CANCELLED'].includes(item.job.state) || counts.get(item.job.id) !== 1);
    return limitHistory ? dashboardManagedJobs(visible) : visible;
  };
  cachedOverviews = await inventoryFromLocal();
  const makeReconciler = (store: DurableStore, maxConcurrent: number) => new Reconciler(store,{ noGitHub, owner:`relayd-${process.pid}`, maxConcurrent, leaseMs:Number(value(argv,'--lease-ms','300000')), adapters:[new CodexAdapter(value(argv,'--codex','codex')),new ChatGptAdapter(), new ZAdapter()], continuations:[new CodexThreadContinuation(value(argv,'--codex','codex')),new CommandContinuation(),new WebhookContinuation()], planner:runtimePlanner(argv), usageSnapshotProvider: () => usageRegistry.snapshot(), runtimeSummaryProvider: () => ({ chatgptRunning: summarizeRuntime(cachedOverviews.map(item => item.job)).workers.chatgpt }), decisionEngine:executionDecisionEngine(), decisionMode:decisionMode(), decisionAuditStore, eventBus:bus, escalationNotifier:escalationNotifierFromEnvironment(), reviewer:runtimeReviewer(argv), executionContextRoots: { workspaceRoot }, agentPreferenceContextPathForJob: async job => resolveRepositoryProjectPath(await resolveJobProjectRoot(job), job.projectPath), projectPathForJob: async (job, task) => { const canonical = await resolveJobProjectRoot(job); if (!(task ? taskRequiresManagedWorktree(job, task) : Boolean(job.localMerge?.sourceRef))) return resolveRepositoryProjectPath(canonical, job.projectPath);
    const sourceRef = job.localMerge?.sourceRef ?? await ensureLocalJobSourceBranch(canonical, job);
    if (!job.localMerge?.sourceRef) {
      if (!task || !store.mutateJob) throw new Error('Managed source branch binding requires an executing code Task and atomic SQLite mutation');
      const bound = await store.mutateJob(job.id, current => {
        const activeTask = current.tasks.find(item => item.id === task.id);
        if (current.localMerge || current.state !== 'ACTIVE' || !activeTask || !['QUEUED', 'RUNNING'].includes(activeTask.state) || !taskRequiresManagedWorktree(current, activeTask)) return current;
        return {...current, localMerge: {sourceRef,targetRef:'refs/heads/main',status:'pending' as const},updatedAt:new Date().toISOString()};
      });
      if (!bound.localMerge?.sourceRef) throw new Error('Job changed before managed source branch binding');
    }
    return prepareLocalJobExecutionWorktree(canonical, await store.load(job.id), workspaceRoot); } });
  const refreshAll = async (_forceRefresh = false): Promise<ManagedJobOverview[]> => {
    cachedOverviews = await inventoryFromLocal();
    return cachedOverviews;
  };
  // Search the full SQLite inventory; keep the executor's bounded view unchanged.
  const overviews = async (_forceRefresh = false, _trigger = 'internal.unknown'): Promise<ManagedJobOverview[]> => inventoryFromLocal(false);
  const refreshPullRequestSnapshot = async (repository: string, prNumber: number, _trigger: PullRequestRefreshTrigger = 'internal', _options: { force?: boolean } = {}): Promise<ManagedGitHubPullRequestSnapshot> => {
    const inventory = await refreshAll();
    return {
      overviews: inventory.filter(item => item.job.repository === repository && item.job.prNumber === prNumber),
      seed: { prNode: {}, comments: null },
    };
  };
  const refreshPullRequest = async (repository: string, prNumber: number, trigger: PullRequestRefreshTrigger, options?: { force?: boolean }): Promise<ManagedJobOverview[]> =>
    (await refreshPullRequestSnapshot(repository, prNumber, trigger, options)).overviews;
  const localJobBinding = createJobIdRegistryResolver(relayStoreDirectory(), relayStores, { client, trustedAuthors: trusted, noGitHub });
  const requireLocalJobBinding = async (jobId: string) => {
    const binding = await localJobBinding(jobId);
    if (!binding) throw new Error('Local Job ' + jobId + ' not found or ambiguous in SQLite registry');
    return binding;
  };
  const deliverCompletedJobs = async (): Promise<void> => {
    const snapshots = await discoverLocalRelayStoreSnapshots(relayStoreDirectory());
    for (const snapshot of snapshots) for (const discovered of snapshot.jobs) {
      const delivery = discovered.remoteDelivery;
      // Historic COMPLETED records have no delivery marker. Avoid even opening
      // their writable SQLite scope during an optional delivery scan.
      if (discovered.state !== 'COMPLETED' || discovered.localMerge?.status !== 'succeeded'
          || !delivery || delivery.mergedCommitSha !== discovered.localMerge.mergedCommitSha
          || !['pending', 'failed', 'processing'].includes(delivery.status)) continue;
      const scopedKey = `${snapshot.path}#${discovered.id}`;
      let relay = relayStores.get(scopedKey);
      if (!relay) { relay = new SQLiteRelayStore(snapshot.path, discovered.id); relayStores.set(scopedKey, relay); }
      const current = await relay.loadJob(discovered.id);
      if (!current || current.state !== 'COMPLETED' || !current.remoteDelivery) continue;
      // Validation and Git inspection occur inside the claimed delivery action:
      // an inaccessible/moved checkout becomes a durable SQLite retry instead
      // of being lost as a daemon-only warning before the claim.
      try { await reconcileCompletedLocalDelivery(relay, current, current.projectRoot); }
      catch (error) {
        observability().record({ stage: 'projection', event: 'remote.delivery_scan_failed', level: 'warn', outcome: 'failed', message: errorMessage(error), correlation: { repository: current.repository, jobId: current.id }, data: { reason: errorMessage(error) } });
      }
    }
    cachedOverviews = await inventoryFromLocal();
  };
  let remoteDeliveryInFlight: Promise<void> | null = null;
  const deliverCompletedJobsSafely = async (): Promise<void> => {
    if (remoteDeliveryInFlight) return remoteDeliveryInFlight;
    remoteDeliveryInFlight = deliverCompletedJobs().catch(error => {
      observability().record({ stage: 'projection', event: 'remote.delivery_scan_failed', level: 'warn', outcome: 'failed',
        message: `Optional remote delivery scan failed: ${errorMessage(error)}` });
    }).finally(() => { remoteDeliveryInFlight = null; });
    return remoteDeliveryInFlight;
  };
  const pool = new RepositoryWorkerPool(concurrency,makeReconciler,
    inventoryFromLocal,localJobBinding);
  const initial = cachedOverviews; const fallback = initial[0]?.job;
  const dashboardStore = fallback ? (await requireLocalJobBinding(fallback.id)).store : new InMemoryStore();
  const {dashboardOverview,workspaceJobAction,workspaceJobSetState,workspaceTaskCreate,workspaceTaskAction,workspaceTaskSetState} = createDashboardActions({getOverviews: () => cachedOverviews, requireLocalJobBinding, pool, dashboardJobAction, makeReconciler, concurrency, dashboardJobSetState, refreshAll, applyJobActivateAction, bus, dashboardTaskAction, dashboardTaskSetState});
  const workspaceControl = createWorkspaceControl({client, trusted, noGitHub, repositories, repositoryPaths, refreshAll, requireLocalJobBinding, makeReconciler, concurrency, pool, bus, isEffectivelyBlocked, unblockTask, publishTaskUnblocked, dispatchTaskAction, registerBlockerDependency, discoverAgents, ensureManagedGitHubJob});
  const webhook = undefined;
  const exactJob = async (jobId: string, target?: { repository?: string; prNumber?: number }) => {
    let cached = dashboardOverview(jobId, target);
    if (!cached) cached = (await inventoryFromLocal(false)).find(item => item.job.id === jobId &&
      (!target?.repository || item.job.repository === target.repository) &&
      (!target?.prNumber || item.job.prNumber === target.prNumber));
    if (!cached && target?.repository && target.prNumber && repositories.includes(target.repository)) {
      cached = (await refreshPullRequest(target.repository, target.prNumber, 'control.job-lookup', { force: true }))
        .find(item => item.job.id === jobId && item.job.repository === target.repository && item.job.prNumber === target.prNumber);
    }
    if (!cached) return null;
    const cachedJob = () => ({ ...cached.job, githubState: cached.githubState, runtimeStatus: deriveJobRuntimeStatus(cached.job, cached.githubState), mergedAt: cached.mergedAt, closedAt: cached.closedAt, draft: cached.draft, publication: cached.publication, publicationFailure: cached.publicationFailure });
    try {
      const refreshed = (await refreshPullRequest(cached.job.repository, cached.job.prNumber, 'dashboard.selected-job', { force: true })).find(item => item.job.id === jobId);
      if (!refreshed) return cachedJob();
      return { ...refreshed.job, githubState: refreshed.githubState, runtimeStatus: deriveJobRuntimeStatus(refreshed.job, refreshed.githubState), mergedAt: refreshed.mergedAt, closedAt: refreshed.closedAt, draft: refreshed.draft, publication: refreshed.publication, publicationFailure: refreshed.publicationFailure };
    } catch (error) {
      observability().record({ stage: 'daemon', event: 'daemon.refresh_failed', level: 'warn', outcome: 'failed', message: `Selected job refresh unavailable: ${errorMessage(error)}`, data: { classification: classifyFailure(error).classification, reason: errorMessage(error) } });
      return cachedJob();
    }
  };
  const stopWatch = bus ? await pool.watch(bus) : async()=>{};
  const server = serveDashboard(dashboardStore,Number(value(argv,'--port',String(SERVICE_DEFAULTS.port))),bus,Number(value(argv,'--refresh-ms',String(SERVICE_DEFAULTS.dashboardRefreshMs))),fallback?.id,usageRegistry,overviews,webhook,()=>({ githubEnabled: !noGitHub, githubAuthenticated, githubAuthError, ...client.rateLimitStatus(), readPaths: { ...githubReadPaths } }),noGitHub ? undefined : () => client.rateLimitSnapshot(),exactJob, {
    control: workspaceControl,
    start: workspaceJobAction('start'),
    reconcile: workspaceJobAction('reconcile'),
    cancel: workspaceJobAction('cancel'),
    jobSetState: workspaceJobSetState,
    taskCreate: workspaceTaskCreate,
    taskUpdate: managedTaskUpdateHandler(async jobId => {
      const binding = await requireLocalJobBinding(jobId);
      return { store: binding.store, repository: binding.job.repository, prNumber: binding.job.prNumber };
    }, async (_repository, _prNumber, jobId) => pool.reconcileLocalJob(jobId, 'control.task.update')),
    taskRetry: workspaceTaskAction('retry'),
    taskCancel: workspaceTaskAction('cancel'),
    taskSetState: workspaceTaskSetState,
  }, async ({ jobId, taskId }) => {
    const overview = cachedOverviews.find(item => item.job.id === jobId);
    if (!overview) throw new Error('Selected Job '+jobId+' is not available');
    const job = overview.job;
    const task = job.tasks.find(item => item.id === taskId);
    if (!task) throw new Error('Selected Task '+taskId+' is not available in Job '+jobId);
    const usage = await usageRegistry.snapshot();
    const runtime = summarizeRuntime(cachedOverviews.map(item => item.job));
    const workers = workerCandidates([
      { name: 'codex', id: 'codex', capabilities: ['model', 'codex'] },
      { name: 'chatgpt', id: 'chatgpt/browser-worker', capabilities: ['model', 'chatgpt', 'webhelm'] },
    ], [], usage);
    const result = await routeExecution(workers, task.workerRequirements ?? { capabilities: task.capabilities ?? [] }, {
      decisionEngine: executionDecisionEngine(),
      decisionMode: 'active',
      taskFacts: {
        job: {
          id: job.id, title: job.title, objective: job.objective ?? null,
          description: job.description ?? null, priority: job.priority ?? null,
          repository: job.repository,
          prNumber: job.prNumber, state: job.state,
        },
        task: {
          id: task.id, kind: task.kind ?? 'work', storySize: task.storySize ?? 'M',
          priority: task.priority ?? null, agentName: task.agentName ?? null,
          parentTaskId: task.parentTaskId, dependencies: task.dependencies,
          capabilities: task.capabilities, taskCapabilities: task.taskCapabilities, workerCapabilities: task.workerCapabilities, input: task.input,
          attachments: task.attachments ?? [], output: task.output ?? null,
          state: task.state, attempt: task.attempt, maxAttempts: task.maxAttempts,
        },
        storySize: task.storySize ?? 'M',
      },
      usage,
      chatgptRunning: runtime.workers.chatgpt, historyStore: decisionAuditStore,
    });
    return {
      selected: {
        route: result.audit?.selected?.id,
        worker: result.selection.workerId,
        adapter: result.selection.adapter,
        provider: result.candidate.routing.provider,
        model: result.candidate.routing.model,
        profile: result.candidate.routing.profile,
        reasoning: result.candidate.routing.reasoning,
      },
      probabilities: result.candidate.routing.decisionEvidence?.probabilities ?? {},
      proposedFields: result.candidate.routing.decisionEvidence?.proposedFields ?? {},
      fallback: result.candidate.routing.decisionEvidence?.fallback ?? false,
      current: {
        chatgptRunning: runtime.workers.chatgpt,
        browserWorkspace: usage.browserWorkspace ?? null,
        providers: usage.providers,
        credits: usage.credits,
      },
      effectiveChoices: result.audit?.contract?.effectiveChoices ?? [],
      routingInstruction: result.audit?.contract?.routingInstruction ?? '',
      mergedChoices: firstStageChoices(result.audit?.decision_input),
      decisionInput: result.audit?.decision_input ?? null,
      gates: result.audit?.gate_results ?? [],
    };
  },
  async () => (await decisionAuditStore.read()).filter((record): record is import('./decision-audit.js').DecisionAuditRecord => record.record_type === 'decision' && record.schema_version === 5));
  await once(server,'listening');
  const reconcileSafely = async (): Promise<void> => {
    try { await pool.reconcile(); }
    catch (error) { observability().record({ stage: 'daemon', event: 'daemon.reconcile_failed', level: 'warn', outcome: 'failed', message: `Workspace reconcile unavailable: ${errorMessage(error)}`, data: { classification: classifyFailure(error).classification, reason: errorMessage(error) } }); }
  };
  const watchdogDefault = SERVICE_DEFAULTS.watchdogMs;
  let interval: NodeJS.Timeout | undefined;
  let projectionInterval: NodeJS.Timeout | undefined;
  const stop=()=>{stopRuntimeStatusEvents(); if (interval) clearInterval(interval); if (projectionInterval) clearInterval(projectionInterval); void Promise.allSettled([stopWatch(), shutdownOwnedProcesses('parent-shutdown')]).finally(()=>{ for (const store of relayStores.values()) store.close(); server.close(()=>process.exit(0)); });}; process.once('SIGINT',stop);process.once('SIGTERM',stop);
  // Start local reconciliation before optional remote effects; a slow/unreachable
  // origin must not delay the SQLite-authoritative Scheduler after daemon launch.
  await pool.reconcileKnown(cachedOverviews);
  void deliverCompletedJobsSafely();
  interval=setInterval(()=>void reconcileSafely().finally(deliverCompletedJobsSafely),Number(value(argv,'--interval',String(watchdogDefault)))); interval.unref();
  console.log('Dashboard listening; repository worker pool active');
  void refreshAll(true)
    .then(items => pool.reconcileKnown(items))
    .catch(error => observability().record({ stage: 'daemon', event: 'daemon.startup_refresh_failed', level: 'warn', outcome: 'failed', message: 'Startup local refresh unavailable: ' + errorMessage(error), data: { classification: classifyFailure(error).classification, reason: errorMessage(error) } }));
}
if (isEntrypoint(import.meta.url)) runDaemon(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
function conflictJobId(repository: string, prNumber: number): string {
  return `${repository}#${prNumber}`;
}
