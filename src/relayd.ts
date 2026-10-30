#!/usr/bin/env node
import {escalationNotifierFromEnvironment} from './escalation-notifier.js';
import { once } from 'node:events';
import { spawnOwnedProcess } from './owned-process.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { ChatGptAdapter, CodexAdapter, ensureChatGptWebHelmReady } from './adapters.js';
import { CodexThreadContinuation, CommandContinuation, WebhookContinuation } from './continuation.js';
import { serveDashboard } from './dashboard.js';
import { RepositoryWorkerPool } from './pool.js';
import { Reconciler } from './reconciler.js';
import { dashboardManagedJobs, GitHubStore, InMemoryStore, ManagedJobOverview, resolvePullRequest, type DurableStore, type ManagedGitHubPullRequestSnapshot } from './store.js';
import { GitHubProjectionWriter } from './projected-store.js';
import { LocalAuthorityDurableStore } from './local-authority-store.js';
import { discoverLocalRelayStoreSnapshots, relayStoreDirectory, relayUnifiedStorePath, resolveUnifiedJobScope, SQLiteRelayStore } from './relay-store.js';
import { createJobIdRegistryResolver } from './local-job-registry.js';
import { projectAuthoritativeLocalMerge } from './local-merge-projection.js';
import { archiveDisplayPullRequest } from './github-pr-archive.js';
import { orderGitHubBindingCandidates } from './github-binding-order.js';
import { ProjectionFailureDeduplicator } from './projection-failure-dedupe.js';
import { handleGitHubProjectionFailure, projectBindingLocalMerge } from './projection-failure-recovery.js';
import { authoritativeBranchPushArgs } from './github-branch-projection.js';
import { githubAuthContext } from './github-auth.js';
import { GhApiClient } from './github-client.js';
import { DisabledGitHubClient, noGitHubMode } from './no-github.js';
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
import { discoverWorkspaceRepositories, ensureLocalJobSourceBranch, prepareLocalJobExecutionWorktree, resolveManagedProjectPath, resolveRepositoryProjectPath, resolveWorkspaceRoot, taskRequiresManagedWorktree } from './workspace.js';
import { GitHubWebhookWake } from './github-webhook.js';
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
  if (argv.includes('--help') || argv.includes('-h')) { console.log(daemonHelp); return; }
  configureDaemonObservability();
  configureExecutionRouterRulesPath(argv);
  try {
    await ensureChatGptWebHelmReady();
  } catch (error) {
    process.stderr.write(`WebHelm readiness check skipped: ${errorMessage(error)}\n`);
  }
  const noGitHub = noGitHubMode(argv);
  if (noGitHub) process.env.AGENTS_RELAY_NO_GITHUB = '1';
  const normalized = normalizeDaemonArguments(argv);
  if (normalized.pullRequest && normalized.jobId) { await startService([...argv]); return; }
  // Local authority never depends on GitHub availability, but every enabled
  // GitHub transport must use the same authenticated context as the CLI. Probe
  // identity separately so an auth outage is observable without blocking startup.
  const auth = noGitHub ? null : await githubAuthContext(argv, undefined, false);
  const client = noGitHub ? new DisabledGitHubClient() : auth!.client;
  const trusted = noGitHub ? new Set<string>() : auth!.trustedAuthors;
  let githubAuthenticated: boolean | null = noGitHub ? false : null;
  let githubAuthError: string | null = null;
  if (!noGitHub) {
    try { const login = auth?.appAuth ? await client.currentLogin() : await client.localLogin(); if (!login) throw new Error('gh authentication did not return a healthy login'); trusted.add(login); githubAuthenticated = true; }
    catch (error) { githubAuthenticated = false; githubAuthError = errorMessage(error); }
  }
  const concurrency = Number(value(argv,'--concurrency','4'));
  const eventResolution = await resolveEventBus([...argv]);
  const bus = eventResolution.bus;
  const stopRuntimeStatusEvents = bus ? subscribeLocalCommits(createRuntimeStatusPublisher(bus)) : () => {};
  process.stderr.write(`${eventBusResolutionMessage(eventResolution)}\n`);
  const workspaceRoot = await resolveWorkspaceRoot(normalized.workspaceRoot ?? undefined);
  const explicitProjectPath = value(argv,'--project-path');
  const localProjectPath = noGitHub && !explicitProjectPath && !argv.includes('--workspace') && !argv.includes('--workspace-root') && !process.env.AGENTS_RELAY_WORKSPACE_ROOT
    ? process.cwd() : explicitProjectPath || workspaceRoot;
  const discoveredRepositories = normalized.repository || noGitHub ? [] : await discoverWorkspaceRepositories(workspaceRoot).catch(() => []);
  const repositories = noGitHub && !normalized.repository ? [`local/${basename(localProjectPath)}`] : normalized.repository ? [normalized.repository] : discoveredRepositories.map(item => item.repository);
  const repositoryPaths = new Map(discoveredRepositories.map(item => [item.repository, item.path]));
  if (noGitHub) for (const repo of repositories) repositoryPaths.set(repo, localProjectPath);
  const usageRegistry = codexAndZaiUsageRegistry();
  const decisionAuditStore = new JsonlDecisionAuditStore(process.env.AGENTS_RELAY_DECISION_AUDIT_PATH ?? join(homedir(), '.agents-relay', 'decision-audit.jsonl'));
  let cachedOverviews: ManagedJobOverview[] = [];
  const githubReadPaths: GitHubReadPathDiagnostics = { workspaceScans: 0, prRefreshes: 0, prRefreshesByTrigger: {}, prRefreshCoalesced: 0, prRefreshCoalescedByTrigger: {} };
  let dormantProbeIndex = 0;
  const relayStores = new Map<string, SQLiteRelayStore>();
  const projectionWriters = new Map<string, GitHubProjectionWriter>();
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
    if (!noGitHub) projectionWriters.set(key, projected.projection);
    return projected;
  };
  const existingInventory = await discoverLocalRelayStoreSnapshots(relayStoreDirectory());
  for (const snapshot of existingInventory) for (const job of snapshot.jobs) {
    if (!repositories.includes(job.repository)) repositories.push(job.repository);
  }
  if (repositories.length === 0) repositories.push('local/' + basename(workspaceRoot));
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
  const makeReconciler = (store: DurableStore, maxConcurrent: number) => new Reconciler(store,{ noGitHub, owner:`relayd-${process.pid}`, maxConcurrent, leaseMs:Number(value(argv,'--lease-ms','300000')), adapters:[new CodexAdapter(value(argv,'--codex','codex')),new ChatGptAdapter()], continuations:[new CodexThreadContinuation(value(argv,'--codex','codex')),new CommandContinuation(),new WebhookContinuation()], planner:runtimePlanner(argv), usageSnapshotProvider: () => usageRegistry.snapshot(), runtimeSummaryProvider: () => ({ chatgptRunning: summarizeRuntime(cachedOverviews.map(item => item.job)).workers.chatgpt }), decisionEngine:executionDecisionEngine(), decisionMode:decisionMode(), decisionAuditStore, eventBus:bus, escalationNotifier:escalationNotifierFromEnvironment(), reviewer:runtimeReviewer(argv), executionContextRoots: { workspaceRoot }, projectPathForJob: async (job, task) => { const canonical = repositoryPaths.get(job.repository) ?? await resolveManagedProjectPath(job.repository, explicitProjectPath, workspaceRoot); if (!(task ? taskRequiresManagedWorktree(job, task) : Boolean(job.localMerge?.sourceRef))) return resolveRepositoryProjectPath(canonical, job.projectPath);
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
  const gitText = async (cwd: string, args: string[]): Promise<string> => await new Promise<string>((resolve, reject) => {
    const child = spawnOwnedProcess('git', ['-C', cwd, ...args], { invocation: 'workspace.git', timeoutMs: 120000, spawn: { stdio: ['ignore','pipe','pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } } });
    let stdout=''; let stderr='';
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => code===0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `git exited ${code}`)));
  });
  const refreshGitHubAuthentication = async (): Promise<void> => {
    if (noGitHub) return;
    try {
      const login = auth?.appAuth ? await client.currentLogin() : await client.localLogin();
      if (!login) throw new Error('gh authentication did not return a healthy login');
      trusted.add(login);
      githubAuthenticated = true;
      githubAuthError = null;
    } catch (error) {
      githubAuthenticated = false;
      githubAuthError = errorMessage(error);
    }
  };
  const projectionFailureDeduplicator = new ProjectionFailureDeduplicator();
  const syncGitHubBindings = async (): Promise<void> => {
    if (noGitHub) return;
    await refreshGitHubAuthentication();
    if (githubAuthenticated !== true) return;
    if (client.rateLimitStatus().limited) return;
    const snapshots = await discoverLocalRelayStoreSnapshots(relayStoreDirectory());
    const bindingCandidates = orderGitHubBindingCandidates(
      snapshots.flatMap(snapshot => snapshot.jobs.map(job => ({ snapshotPath: snapshot.path, job }))),
    );
    for (const candidate of bindingCandidates) {
      const snapshot = { path: candidate.snapshotPath };
      const discovered = candidate.job;
      try {
      if (!repositoryPaths.has(discovered.repository) || !discovered.localMerge?.sourceRef || !discovered.localMerge?.targetRef) continue;
      const sourceRef = discovered.localMerge.sourceRef, targetRef = discovered.localMerge.targetRef;
      if (!sourceRef.startsWith('refs/heads/') || !targetRef.startsWith('refs/heads/')) continue;
      if (targetRef !== 'refs/heads/main') throw new Error('GitHub sync only supports local main as merge target');
      const branch = sourceRef.slice('refs/heads/'.length), base = targetRef.slice('refs/heads/'.length);
      const scopedKey = `${snapshot.path}#${discovered.id}`;
      let relay = relayStores.get(scopedKey); if (!relay) { relay = new SQLiteRelayStore(snapshot.path, discovered.id); relayStores.set(scopedKey, relay); }
      const canonical = repositoryPaths.get(discovered.repository) ?? await resolveManagedProjectPath(discovered.repository, explicitProjectPath, workspaceRoot);
      // A completed local Job may never have had a display PR. Publish main
      // regardless: GitHub availability cannot determine SQLite completion.
      if (discovered.state === 'COMPLETED' && discovered.localMerge?.status === 'succeeded'
          && discovered.prNumber <= 0) {
        const published = projectAuthoritativeLocalMerge(canonical, discovered);
        if (relay.mutateJob && (discovered.githubProjection?.status !== 'merged_without_pr' || discovered.githubProjection.sourceSha !== published.localMergedCommitSha)) await relay.mutateJob(discovered.id, current => ({ ...current, githubProjection: { status: 'merged_without_pr', sourceSha: published.localMergedCommitSha, observedAt: new Date().toISOString() } }));
        if (published.status === 'projected') await bus?.publish(eventFor(discovered.id,'projection',null,'projection.delivered','succeeded',
          `GitHub main synchronization ${published.status}`,'orchestrator',
          {operation:'github.syncMain',deliveryStatus:published.status,mergedCommitSha:published.localMergedCommitSha},
          {agent:'relay',component:'github-projection'}));
        continue;
      }
      const terminal = ['COMPLETED','CANCELLED'].includes(discovered.state); const sourceSha = await gitText(canonical, ['rev-parse', '--verify', sourceRef]).catch(() => ''); if (!sourceSha) continue;
      let job = (await relay.loadJob(discovered.id)) ?? discovered; let prNumber = job.prNumber > 0 ? job.prNumber : 0;
      // The callback is part of the durable create intent, not daemon memory.
      // Rebuild it on every scan so a reclaimed row remains executable after a
      // crash, including when the binding mutation committed first.
      const effect = async (item: import('./projection-outbox.js').ProjectionOutboxItem): Promise<void> => {
        const payload = item.payload as { repository: string; head: string; base: string; title: string; body: string; sourceRef: string; targetRef: string };
        await gitText(canonical, ['fetch','--no-tags','origin',`+refs/heads/${payload.base}:refs/remotes/origin/${payload.base}`]);
        const remoteRef = `refs/remotes/origin/${payload.head}`;
        const remoteHeadSha = await gitText(canonical, ['rev-parse', '--verify', remoteRef]).catch(() => '');
        const remoteTreeMatchesBase = remoteHeadSha ? await gitText(canonical, ['diff','--quiet',`refs/remotes/origin/${payload.base}`,remoteRef]).then(() => true, () => false) : false;
        await gitText(canonical, authoritativeBranchPushArgs({ sourceRef: payload.sourceRef, branch: payload.head, remoteHeadSha: remoteHeadSha || null, remoteTreeMatchesBase }));
        // Lookup by head/base first: a crash after GitHub created the PR must
        // bind the existing collaboration projection rather than create one.
        const pr = await resolvePullRequest(client, payload.repository, { head: payload.head, base: payload.base, title: payload.title, body: payload.body });
        if (!relay.mutateJob) throw new Error('Atomic SQLite mutation is required for GitHub PR binding');
        await relay.mutateJob(job.id, current => ({ ...current, prNumber: pr.number, githubProjection: { status: 'pr_bound', sourceSha, observedAt: new Date().toISOString() }, updatedAt: new Date().toISOString() }));
        observability().record({ stage: 'projection', event: 'github.pr_bound', outcome: 'succeeded', message: `Bound local Job ${job.id} to GitHub PR #${pr.number}`, correlation: { repository: job.repository, prNumber: pr.number, jobId: job.id }, data: { head: branch, base } });
      };
      projectionWriters.set(`job:${job.id}`, new GitHubProjectionWriter(relay, prNumber > 0 ? new GitHubStore(client, job.repository, prNumber, trusted) : new InMemoryStore(job), undefined, true, effect));
      if (job.state === 'CANCELLED') continue; // Drain committed effects only; never push.
      if (prNumber === 0) {
        // Do not bootstrap an empty remote-only PR commit: it would diverge from
        // the real local Job branch before its first Worker commit. Publish the
        // review-only PR when there is an actual diff against main.
        const ahead = Number(await gitText(canonical, ['rev-list', '--count', `${targetRef}..${sourceRef}`]));
        if (!Number.isFinite(ahead) || ahead <= 0) {
          if (terminal && relay.mutateJob && job.githubProjection?.sourceSha !== sourceSha) await relay.mutateJob(job.id, current => ({ ...current, githubProjection: { status: current.localMerge?.status === 'succeeded' ? 'merged_without_pr' : 'no_diff', sourceSha, observedAt: new Date().toISOString() } }));
          continue;
        }
        // GitHub compares origin/main, not local main. Do not invoke the legacy
        // empty-PR bootstrap path when the published base already contains the
        // source head (for example when main was pushed by another Job).
        await gitText(canonical, ['fetch','--no-tags','origin',`+refs/heads/main:refs/remotes/origin/main`]);
        const remoteAhead = Number(await gitText(canonical, ['rev-list','--count',`refs/remotes/origin/main..${sourceRef}`]));
        if (!Number.isFinite(remoteAhead) || remoteAhead <= 0) {
          if (terminal && relay.mutateJob && job.githubProjection?.sourceSha !== sourceSha) await relay.mutateJob(job.id, current => ({ ...current, githubProjection: { status: 'merged_without_pr', sourceSha, observedAt: new Date().toISOString() } }));
          continue;
        }
        // A terminal Job may drain an already-committed intent, but terminal
        // state is never permission to create a new external PR intent.
        if (!terminal && relay.enqueueExternalActionOnce) await relay.enqueueExternalActionOnce({ idempotencyKey: `create_pull_request:${job.id}:${sourceSha}`, operation: 'create_pull_request', payload: { operation: 'create_pull_request', repository: job.repository, head: branch, base, title: job.title, body: job.objective ?? job.description ?? '', sourceRef, targetRef }, priority: 100 });
        if (terminal) continue;
        continue;
      }
      if (prNumber <= 0) continue; if ((await relay.loadPullRequestFacts())?.head?.sha !== sourceSha) {
        await gitText(canonical, ['fetch','--no-tags','origin','+refs/heads/main:refs/remotes/origin/main']);
        const remoteRef = `refs/remotes/origin/${branch}`;
        await gitText(canonical, ['fetch','--no-tags','origin',`+refs/heads/${branch}:${remoteRef}`]).catch(() => '');
        const remoteHeadSha = await gitText(canonical, ['rev-parse','--verify',remoteRef]).catch(() => '');
        const sameTree = remoteHeadSha ? await gitText(canonical, ['diff','--quiet','refs/remotes/origin/main',remoteRef]).then(() => true, () => false) : false;
        await gitText(canonical, authoritativeBranchPushArgs({ sourceRef, branch, remoteHeadSha: remoteHeadSha || null, remoteTreeMatchesBase: sameTree }));
      }
      const latestFacts = await relay.loadPullRequestFacts(); if (latestFacts?.state !== 'MERGED' && (latestFacts?.head?.sha !== sourceSha || latestFacts?.head?.ref !== branch)) {
        await relay.savePullRequestFacts({ state: latestFacts?.state === 'CLOSED' ? 'CLOSED' : 'OPEN', head: { ref: branch, sha: sourceSha }, observedAt: new Date().toISOString() });
      }
      const github = new GitHubStore(client, job.repository, prNumber, trusted);
      projectionWriters.set(`job:${job.id}`, new GitHubProjectionWriter(relay, github, undefined, true, effect));
      if (job.state === 'COMPLETED' && job.localMerge?.status === 'succeeded' && job.localMerge.projectionStrategy === 'target_ref_push') {
        const projection = await projectBindingLocalMerge(job, relay, {
          projectPath: canonical,
          project: async projectedJob => projectAuthoritativeLocalMerge(canonical, projectedJob),
          verifyObservedRemote: async sha => { try { await gitText(canonical, ['merge-base','--is-ancestor',sha,'refs/heads/main']); }
            catch { throw new Error(`Projection recovery did not preserve observed origin/main ${sha} in local main`); } }, eventBus: bus,
        });
        if (projection.skip) continue;
        const projectedMerge = projection.projectedMerge;
        if (!projectedMerge) continue;
        await bus?.publish(eventFor(job.id,'projection',null,'projection.delivered','succeeded',
          `GitHub local merge projection ${projectedMerge.status}`,'orchestrator',
          {operation:'github.projectLocalMerge',deliveryStatus:projectedMerge.status,mergedCommitSha:projectedMerge.localMergedCommitSha},
          {agent:'relay',component:'github-projection'}));
        // A review-only PR is never merged by GitHub. Close it after local main
        // has been safely published, retaining the diff, comments and commit link.
        const remotePr = await github.pullRequestState();
        await archiveDisplayPullRequest(client,job.repository,prNumber,job.id,projectedMerge.projectedCommitSha,remotePr);
        const projectedState = await github.pullRequestState();
        const projectedHead = await github.pullRequestHead();
        await relay.savePullRequestFacts({ state: projectedState, head: projectedHead, observedAt: new Date().toISOString() });
        observability().record({
          stage: 'projection', event: 'github.local_merge_projected', outcome: 'succeeded',
          message: `Projected authoritative local merge ${projectedMerge.localMergedCommitSha} to ${projectedMerge.targetRef}`,
          correlation: { repository: job.repository, prNumber, jobId: job.id },
          data: { ...projectedMerge, githubState: projectedState },
        });
      }
      } catch (error) {
        await handleGitHubProjectionFailure(error, discovered, snapshot.path, { relayStores, repositoryPaths,
          explicitProjectPath, workspaceRoot, gitText, reconcileLocalJob: (jobId, reason) => pool.reconcileLocalJob(jobId, reason),
          eventBus: bus, deduplicator: projectionFailureDeduplicator });
      }
    }
    cachedOverviews = await inventoryFromLocal();
  };
  let githubBindingSyncInFlight: Promise<void> | null = null;
  const syncGitHubBindingsSafely = async (): Promise<void> => {
    if (githubBindingSyncInFlight) return githubBindingSyncInFlight;
    githubBindingSyncInFlight = (async()=>{
      try { await syncGitHubBindings(); }
      catch (error) { observability().record({ stage: 'projection', event: 'github.binding_sync_failed', level: 'warn', outcome: 'failed', message: `GitHub Job binding sync failed: ${errorMessage(error)}`, data: { classification: classifyFailure(error).classification, reason: errorMessage(error) } }); }
      finally { githubBindingSyncInFlight = null; }
    })();
    return githubBindingSyncInFlight;
  };
  const pool = new RepositoryWorkerPool(
    concurrency,
    makeReconciler,
    inventoryFromLocal,
    localJobBinding,
  );
  const initial = cachedOverviews; const fallback = initial[0]?.job;
  const dashboardStore = fallback ? (await requireLocalJobBinding(fallback.id)).store : new InMemoryStore();
  const {dashboardOverview,workspaceJobAction,workspaceJobSetState,workspaceTaskCreate,workspaceTaskAction,workspaceTaskSetState} = createDashboardActions({getOverviews: () => cachedOverviews, requireLocalJobBinding, pool, dashboardJobAction, makeReconciler, concurrency, dashboardJobSetState, refreshAll, applyJobActivateAction, bus, dashboardTaskAction, dashboardTaskSetState});
  const workspaceControl = createWorkspaceControl({client, trusted, noGitHub, repositories, refreshAll, requireLocalJobBinding, makeReconciler, concurrency, pool, bus, isEffectivelyBlocked, unblockTask, publishTaskUnblocked, dispatchTaskAction, registerBlockerDependency, discoverAgents, ensureManagedGitHubJob});
  const secretFile = value(argv,'--github-webhook-secret-file');
  const secret = noGitHub ? '' : value(argv,'--github-webhook-secret') || process.env.AGENTS_RELAY_GITHUB_WEBHOOK_SECRET || (secretFile ? (await readFile(secretFile,'utf8')).trim() : '');
  const webhook = secret ? {
    secret,
    repositories: new Set(repositories),
    wake: async (event: GitHubWebhookWake): Promise<void> => {
      const targets = cachedOverviews.filter(item => item.job.repository === event.repository && (event.jobId ? item.job.id === event.jobId : item.job.prNumber === event.pullRequest));
      if (targets.length === 0) return;
      for (const target of targets) {
        const binding = await requireLocalJobBinding(target.job.id);
        const store = binding.store;
        if (event.pullRequestFacts && store.applyPullRequestFacts) {
          await store.applyPullRequestFacts({ ...event.pullRequestFacts,
            observedAt: event.pullRequestFacts.observedAt ?? new Date().toISOString() });
          target.githubState = await store.pullRequestState?.() ?? target.githubState;
        }
        if (event.publication || event.publishFailure) {
          const relay = binding.relay;
          try {
            const inserted = await relay.recordPublication(target.job.id, event.deliveryId, event.publication, event.publishFailure ?? null, event.publicationObservedAt);
            // Replayed webhook deliveries may retry EventBus delivery; SQLite state remains idempotent.
            const state = await relay.loadPublication(target.job.id);
            target.publication = state?.latest ?? null;
            target.publicationFailure = state?.failure ?? null;
          } finally { /* The SQLite registry owns the shared connection. */ }
        }
        // GitHub is an audit input only: no workflow or reconcile wake.
      }
      cachedOverviews = dashboardManagedJobs(cachedOverviews);
    }
  } : undefined;
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
      chatgptRunning: runtime.workers.chatgpt,
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
  const flushProjectionsSafely = async (): Promise<void> => {
    let externalActionsCompleted = 0;
    for (const writer of projectionWriters.values()) {
      try { externalActionsCompleted += (await writer.flushOnce()).projected; }
      catch (error) { observability().record({ stage: 'daemon', event: 'daemon.projection_flush_failed', level: 'warn', outcome: 'failed', message: `GitHub external action unavailable: ${errorMessage(error)}`, data: { classification: classifyFailure(error).classification, reason: errorMessage(error) } }); }
    }
    // GitHub external acknowledgements are audit-only. Never wake local Graphs.
    if (externalActionsCompleted > 0) observability().record({ stage: 'daemon', event: 'github.external_actions_recorded', level: 'info', outcome: 'succeeded', message: String(externalActionsCompleted) + ' external actions acknowledged without lifecycle reconciliation' });
  };
  const watchdogDefault = webhook ? SERVICE_DEFAULTS.webhookWatchdogMs : SERVICE_DEFAULTS.watchdogMs;
  let interval: NodeJS.Timeout | undefined;
  let projectionInterval: NodeJS.Timeout | undefined;
  const stop=()=>{stopRuntimeStatusEvents(); if (interval) clearInterval(interval); if (projectionInterval) clearInterval(projectionInterval); void Promise.allSettled([stopWatch(), shutdownOwnedProcesses('parent-shutdown')]).finally(()=>{ for (const store of relayStores.values()) store.close(); server.close(()=>process.exit(0)); });}; process.once('SIGINT',stop);process.once('SIGTERM',stop);
  await syncGitHubBindingsSafely();
  await pool.reconcileKnown(cachedOverviews);
  await flushProjectionsSafely();
  interval=setInterval(()=>void reconcileSafely().finally(flushProjectionsSafely),Number(value(argv,'--interval',String(watchdogDefault)))); interval.unref();
  if (!noGitHub) { projectionInterval=setInterval(()=>void syncGitHubBindingsSafely().then(flushProjectionsSafely),Number(value(argv,'--projection-ms',String(SERVICE_DEFAULTS.projectionFlushMs)))); projectionInterval.unref(); }
  console.log('Dashboard listening; repository worker pool active');
  void refreshAll(true)
    .then(items => pool.reconcileKnown(items))
    .catch(error => observability().record({ stage: 'daemon', event: 'daemon.startup_refresh_failed', level: 'warn', outcome: 'failed', message: 'Startup local refresh unavailable: ' + errorMessage(error), data: { classification: classifyFailure(error).classification, reason: errorMessage(error) } }));
}
if (isEntrypoint(import.meta.url)) runDaemon(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
function conflictJobId(repository: string, prNumber: number): string {
  return `${repository}#${prNumber}`;
}
