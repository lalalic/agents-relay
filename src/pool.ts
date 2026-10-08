import { GitHubClient, GitHubStore, ManagedJobOverview, listManagedGitHubJobs, withGitHubRequestContext, type DurableStore, type GitHubPullRequestSeed, type ManagedGitHubPullRequestSnapshot } from './store.js';
import { EventBus, eventFor } from './events.js';
import { Reconciler } from './reconciler.js';
import { Job, Priority } from './types.js';
import { GitHubWebhookWake } from './github-webhook.js';
import { runScheduledBucket } from './scheduled-jobs.js';
import { scheduleBucket } from './scheduler.js';
import { ReconcileCoordinator, type ReconcileSignal } from './reconcile-coordinator.js';
import type { EventRecord } from './types.js';
import { errorMessage, observability, withObservabilityCorrelation } from './observability.js';

const RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
type HydratableStore = DurableStore & { hydrate?: (job: Job) => Promise<void> };
export function compareJobPriority(a: Job, b: Job): number { return RANK[a.priority ?? 'P2'] - RANK[b.priority ?? 'P2'] || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id); }
export function runnableManagedJobs(items: ManagedJobOverview[]): Job[] { return items.filter(item => item.githubState === 'OPEN' && item.job.state === 'ACTIVE').map(item => item.job).sort(compareJobPriority); }
export function needsLifecycleReconciliation(job: Job, now = Date.now()): boolean {
  // DRAFT create-only Jobs stay dormant until a caller explicitly creates work.
  if (job.tasks.length === 0) return false;
  if (job.tasks.some(task => (task.state === 'QUEUED' && task.executionId === null) || (task.state === 'DRAFT' && task.dependencies.length > 0))) return true;
  return job.tasks.some(task => ['RUNNING', 'QUEUED'].includes(task.state) && task.executionId !== null && task.leaseExpiresAt !== null && new Date(task.leaseExpiresAt).getTime() <= now);
}
export function terminalManagedJobs(items: ManagedJobOverview[]): Job[] { return items.filter(item => item.githubState !== 'OPEN' && ((item.githubState === 'MERGED' && item.job.state !== 'COMPLETED') || (item.githubState === 'CLOSED' && item.job.state !== 'CANCELLED'))).map(item => item.job).sort(compareJobPriority); }
export async function aggregateManagedGitHubJobs(client: GitHubClient, repositories: readonly string[], trustedAuthors: ReadonlySet<string>): Promise<ManagedJobOverview[]> {
  const uniqueRepositories = [...new Set(repositories)];
  const groups = await Promise.all(uniqueRepositories.map(repository => listManagedGitHubJobs(client, repository, trustedAuthors)));
  return groups.flat().sort((a, b) => b.job.updatedAt.localeCompare(a.job.updatedAt) || b.job.prNumber - a.job.prNumber);
}

export class RepositoryWorkerPool {
  private running = false;
  private pending = false;
  private readonly reconcileLocks = new Map<string, Promise<void>>();
  private readonly coordinator: ReconcileCoordinator;
  private readonly githubSignalCoordinator: ReconcileCoordinator;
  private readonly scheduleSignalCoordinator: ReconcileCoordinator;
  private watchedBus?: EventBus;
  private readonly jobTargets = new Map<string, { repository: string; prNumber: number }>();
  private readonly targetSeeds = new Map<string, GitHubPullRequestSeed>();
  constructor(
    private readonly client: GitHubClient,
    repository: string | readonly string[],
    private readonly trustedAuthors: ReadonlySet<string>,
    private readonly concurrency: number,
    private readonly makeReconciler: (store: DurableStore, maxConcurrent: number) => Reconciler,
    private readonly isRateLimited: () => boolean = () => false,
    private readonly refreshWebhookSnapshot?: (repository: string, prNumber: number, trigger: string) => Promise<ManagedGitHubPullRequestSnapshot>,
    private readonly makeStore: (repository: string, prNumber: number, seed?: GitHubPullRequestSeed | null) => DurableStore = (repository, prNumber, seed) => new GitHubStore(this.client, repository, prNumber, this.trustedAuthors, seed),
  ) {
    this.repositories = [...new Set(typeof repository === 'string' ? [repository] : repository)];
    const reportCoordinatorError = (error: unknown, signal: ReconcileSignal): void => {
      observability().record({
        stage: 'reconcile', event: 'reconcile.coordinator_failed', level: 'error', outcome: 'failed',
        message: `Reconcile coordinator failed for ${signal.jobId} (${signal.reason}): ${errorMessage(error)}`,
        correlation: { repository: signal.repository, prNumber: signal.prNumber, jobId: signal.jobId },
        data: { reason: signal.reason },
      });
    };
    this.coordinator = new ReconcileCoordinator((jobId, signals) => this.consumeSignals(jobId, signals), reportCoordinatorError);
    this.githubSignalCoordinator = new ReconcileCoordinator((_key, signals) => this.consumeGitHubSignals(signals), reportCoordinatorError);
    this.scheduleSignalCoordinator = new ReconcileCoordinator((jobId, signals) => this.consumeScheduleSignals(jobId, signals), reportCoordinatorError);
  }
  private readonly repositories: string[];
  private async reconcileExclusive(jobId: string, work: () => Promise<void>): Promise<void> {
    while (this.reconcileLocks.has(jobId)) await this.reconcileLocks.get(jobId);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.reconcileLocks.set(jobId, gate);
    try { await work(); }
    finally {
      if (this.reconcileLocks.get(jobId) === gate) this.reconcileLocks.delete(jobId);
      release();
    }
  }
  private signalReason(event: EventRecord): string {
    if (event.type === 'github.webhook') {
      const webhookEvent = typeof event.data?.event === 'string' ? event.data.event : 'unknown';
      const action = typeof event.data?.action === 'string' && event.data.action ? `:${event.data.action}` : '';
      return `github.webhook:${webhookEvent}${action}`;
    }
    return `event.${event.type}`;
  }

  private async consumeScheduleSignals(jobId: string, signals: readonly ReconcileSignal[]): Promise<void> {
    if (this.isRateLimited() || signals.length === 0) return;
    const signal = [...signals].reverse().find(item => item.event?.type === 'schedule.tick');
    const event = signal?.event;
    const repository = signal?.repository ?? (typeof event?.data?.repository === 'string' ? event.data.repository : undefined);
    const prValue = signal?.prNumber ?? Number(event?.data?.prNumber);
    const prNumber = Number.isInteger(prValue) && Number(prValue) > 0 ? Number(prValue) : undefined;
    const bucket = typeof event?.data?.bucket === 'string' ? event.data.bucket : undefined;
    const tickAt = typeof event?.data?.tickAt === 'string' ? new Date(event.data.tickAt) : new Date(event?.timestamp ?? Date.now());
    if (!repository || !prNumber || !bucket || !this.repositories.includes(repository) || Number.isNaN(tickAt.getTime())) return;
    this.jobTargets.set(jobId, { repository, prNumber });
    await runScheduledBucket(
      this.client,
      repository,
      this.trustedAuthors,
      { prNumber, jobId, bucket },
      { reconcile: async () => { await this.reconcileTarget(repository, prNumber, jobId, 'schedule.tick'); }, idle: async () => {} },
      tickAt,
      () => this.makeStore(repository, prNumber),
    );
  }

  private async consumeGitHubSignals(_signals: readonly ReconcileSignal[]): Promise<void> {
    // GitHub webhooks are fact-only inputs. They must never trigger a GitHub reread.
  }

  private async consumeSignals(jobId: string, signals: readonly ReconcileSignal[]): Promise<void> {
    for (const signal of signals) {
      if (signal.repository && signal.prNumber && this.repositories.includes(signal.repository)) {
        this.jobTargets.set(jobId, { repository: signal.repository, prNumber: signal.prNumber });
      }
    }
    const target = this.jobTargets.get(jobId);
    if (!target || !this.repositories.includes(target.repository)) {
      observability().record({
        stage: 'reconcile', event: 'reconcile.signal_unrouted', level: 'warn', outcome: 'skipped',
        message: `Reconcile signal target unknown for job ${jobId}`,
        correlation: { jobId },
        data: { reasons: signals.map(signal => signal.reason) },
      });
      return;
    }
    const seedKey = `${target.repository}#${target.prNumber}:${jobId}`;
    const mayConsumeSeed = signals.some(signal => signal.reason === 'target.request' || signal.reason.startsWith('github.webhook:'));
    let seed = mayConsumeSeed ? this.targetSeeds.get(seedKey) ?? null : null;
    if (mayConsumeSeed) this.targetSeeds.delete(seedKey);
    const needsFreshPullRequestFacts = signals.some(signal => !signal.event || signal.event.type === 'task.completed');
    if (!seed && needsFreshPullRequestFacts && this.refreshWebhookSnapshot && !this.isRateLimited()) {
      const trigger = `coordinator.${signals.map(signal => signal.reason).join('+') || 'reconcile'}`;
      seed = (await this.refreshWebhookSnapshot(target.repository, target.prNumber, trigger)).seed;
    }
    const store = this.makeStore(target.repository, target.prNumber, seed);
    const reconciler = this.makeReconciler(store, Math.max(1, this.concurrency));
    let shouldReconcile = false;
    const reasons: string[] = [];
    for (const signal of signals) {
      reasons.push(signal.reason);
      if (!signal.event) {
        shouldReconcile = true;
        continue;
      }
      const result = await withGitHubRequestContext(this.client, `pool.coordinator-apply:${signal.reason}`, () => reconciler.applyEvent(signal.event!));
      if (!result.applied) observability().record({
        stage: 'transition', event: 'lifecycle.event_rejected', level: 'warn', outcome: 'skipped',
        message: `Lifecycle event ${signal.event.type} not applied: ${result.reason}`,
        correlation: { repository: target.repository, prNumber: target.prNumber, jobId, taskId: signal.event.task_id },
        data: { eventId: signal.event.event_id, sourceId: signal.event.source?.id, reason: result.reason, eventTimestamp: signal.event.timestamp },
      });
      shouldReconcile ||= result.reconcile;
    }
    if (!shouldReconcile) {
      observability().record({
        stage: 'wake', event: 'wake.signal', level: 'debug', outcome: 'noop',
        message: `Wake for ${target.repository}#${target.prNumber} produced no reconcile work`,
        correlation: { repository: target.repository, prNumber: target.prNumber, jobId },
        data: { reasons: [...new Set(reasons)] },
      });
      return;
    }
    const reason = [...new Set(reasons)].join('+') || 'unknown';
    observability().record({
      stage: 'wake', event: 'wake.signal', outcome: 'started',
      message: `Wake for ${target.repository}#${target.prNumber}: ${reason}`,
      correlation: { repository: target.repository, prNumber: target.prNumber, jobId },
      data: { reasons: [...new Set(reasons)] },
    });
    await this.reconcileExclusive(jobId, async () => {
      await withObservabilityCorrelation({ repository: target.repository, prNumber: target.prNumber, jobId }, () =>
        withGitHubRequestContext(this.client, `pool.coordinator-reconcile:${reason}`, () => reconciler.reconcile(jobId)));
    });
  }

  private async reconcileDiscovered(discovered: ManagedJobOverview[]): Promise<void> {
    for (const item of discovered) this.jobTargets.set(item.job.id, { repository: item.job.repository, prNumber: item.job.prNumber });
    // Terminal PRs must be reconciled before OPEN-job scheduling. Otherwise the
    // OPEN-only runnable filter can strand durable jobs after GitHub merges/closes them.
    for (const job of terminalManagedJobs(discovered)) {
      await this.reconcileExclusive(job.id, async () => {
        const store = this.makeStore(job.repository, job.prNumber);
        await (store as HydratableStore).hydrate?.(job);
        await withGitHubRequestContext(this.client, 'pool.terminal-reconcile', () => this.makeReconciler(store, 0).reconcile(job.id));
      });
    }
    const jobs = runnableManagedJobs(discovered);
    let capacity = Math.max(1, this.concurrency);
    for (const job of jobs) {
      if (capacity <= 0) break;
      const store = this.makeStore(job.repository, job.prNumber);
      await (store as HydratableStore).hydrate?.(job);
      const ready = job.tasks.filter(task => (task.state === 'QUEUED' && task.executionId === null) || (task.state === 'DRAFT' && task.dependencies.length > 0)).length;
      const expiredRunning = job.tasks.some(task => ['RUNNING', 'QUEUED'].includes(task.state) && task.executionId !== null && task.leaseExpiresAt !== null && new Date(task.leaseExpiresAt).getTime() <= Date.now());
      if (!needsLifecycleReconciliation(job)) continue;
      const allowance = Math.max(1, Math.min(capacity, ready || (expiredRunning ? 1 : 0) || 1));
      await this.reconcileExclusive(job.id, async () => {
        await withGitHubRequestContext(this.client, 'pool.discovered-reconcile', () => this.makeReconciler(store, allowance).reconcile(job.id));
      });
      capacity -= allowance;
    }
  }
  async reconcileKnown(discovered: ManagedJobOverview[]): Promise<void> {
    const recovered: ManagedJobOverview[] = [];
    for (const item of discovered) {
      if (item.githubState !== 'OPEN' || item.job.state !== 'ACTIVE') { recovered.push(item); continue; }
      this.jobTargets.set(item.job.id, { repository: item.job.repository, prNumber: item.job.prNumber });
      const store = this.makeStore(item.job.repository, item.job.prNumber);
      await (store as HydratableStore).hydrate?.(item.job);
      const reconciler = this.makeReconciler(store, 0);
      let recoveredJob = item.job;
      if (typeof reconciler.recoverStartupOrphans === 'function') await this.reconcileExclusive(item.job.id, async () => {
        recoveredJob = await withGitHubRequestContext(this.client, 'pool.startup-orphan-recovery', () => reconciler.recoverStartupOrphans(item.job.id));
      });
      recovered.push({ ...item, job: recoveredJob });
    }
    await this.reconcileDiscovered(recovered);
  }
  async reconcile(): Promise<void> {
    if (this.isRateLimited()) return;
    if (this.running) { this.pending = true; return; }
    this.running = true;
    try {
      do {
        this.pending = false;
        await this.reconcileDiscovered(await withGitHubRequestContext(this.client, 'pool.workspace-scan', () => aggregateManagedGitHubJobs(this.client, this.repositories, this.trustedAuthors)));
      } while (this.pending);
    } finally { this.running = false; }
  }
  seedTargetSnapshot(repository: string, prNumber: number, jobId: string, seed: GitHubPullRequestSeed): void {
    if (!this.repositories.includes(repository)) return;
    this.targetSeeds.set(`${repository}#${prNumber}:${jobId}`, seed);
  }
  async reconcileTarget(repository: string, prNumber: number, jobId: string, reason = 'target.request'): Promise<void> {
    if (this.isRateLimited() || !this.repositories.includes(repository)) return;
    this.jobTargets.set(jobId, { repository, prNumber });
    await this.coordinator.accept({ jobId, reason, repository, prNumber });
  }
  async watch(bus: EventBus): Promise<() => Promise<void>> {
    this.watchedBus = bus;
    const unsubscribe = await bus.subscribeAll(async event => {
      const repository = typeof event.data?.repository === 'string' ? event.data.repository : undefined;
      const prValue = Number(event.data?.prNumber);
      const prNumber = Number.isInteger(prValue) && prValue > 0 ? prValue : undefined;
      const routedWebhook = event.type === 'github.webhook' && event.data?.coordinatorRouted === true;
      const ingressWebhook = event.type === 'github.webhook' && event.data?.coordinatorIngress === true && !routedWebhook;
      if (event.type === 'schedule.tick' && repository && prNumber) {
        await this.scheduleSignalCoordinator.acceptTransport({ jobId: event.job_id, reason: this.signalReason(event), event, repository, prNumber });
        return;
      }
      if (ingressWebhook) return;
      if (routedWebhook) return;
      const lifecycle = ['task.started', 'task.completed', 'task.failed', 'task.blocked', 'task.unblocked', 'task.cancelled', 'review.started', 'review.approved', 'review.changes_required', 'review.blocked'].includes(event.type);
      const wake = event.type === 'job.wake' || event.type === 'github.webhook' || event.type === 'review.created';
      if (!lifecycle && !wake) return;
      if (repository && prNumber) this.jobTargets.set(event.job_id, { repository, prNumber });
      await this.coordinator.acceptTransport({
        jobId: event.job_id,
        reason: this.signalReason(event),
        event: lifecycle ? event : undefined,
        repository,
        prNumber,
      });
    });
    return async () => {
      await unsubscribe();
      if (this.watchedBus === bus) this.watchedBus = undefined;
    };
  }
  async scheduleTickSignal(bus: EventBus | undefined, job: Job, now = new Date()): Promise<void> {
    if (!job.schedule) return;
    const event = eventFor(
      job.id,
      'scheduler',
      null,
      'schedule.tick',
      'queued',
      `Schedule tick for ${job.schedule.nextRunAt}`,
      'orchestrator',
      { repository: job.repository, prNumber: job.prNumber, bucket: scheduleBucket(new Date(job.schedule.nextRunAt)), tickAt: now.toISOString() },
      { agent: 'relay', component: 'scheduler-timer' },
    );
    // Use the same coordinator-owned schedule path whether transport is available or not.
    if (bus) { await bus.publish(event); return; }
    await this.scheduleSignalCoordinator.accept({ jobId: job.id, reason: this.signalReason(event), event, repository: job.repository, prNumber: job.prNumber });
  }

  async webhookSignal(_bus: EventBus | undefined, _wake: GitHubWebhookWake): Promise<void> {
    // Uncorrelated webhook wakeups are intentionally ignored. A caller must first
    // resolve the target from local cached state and then call webhookWake().
  }

  async webhookWake(bus: EventBus | undefined, job: Job, wake: GitHubWebhookWake): Promise<void> {
    if (bus) {
      const source = { id: `github/${job.repository}/delivery/${wake.deliveryId}`, component: 'github-webhook' };
      if (wake.publication) {
        await bus.publish(eventFor(
          job.id,
          'release',
          null,
          'package.published',
          'succeeded',
          `Published ${wake.publication.package}@${wake.publication.version}`,
          'orchestrator',
          {
            deliveryId: wake.deliveryId,
            repository: job.repository,
            prNumber: job.prNumber,
            package: wake.publication.package,
            version: wake.publication.version,
            registry: wake.publication.registry,
            sha: wake.publication.sha,
          },
          source,
        ));
      }
      if (wake.publishFailure) {
        await bus.publish(eventFor(job.id, 'release', null, 'package.publish_failed', 'failed',
          `Publish workflow ${wake.publishFailure.runId} failed: ${wake.publishFailure.stage}`,
          'user', { ...wake.publishFailure, repository: job.repository, prNumber: job.prNumber, deliveryId: wake.deliveryId }, source));
      }
      await bus.publish(eventFor(job.id, 'github', null, 'github.webhook', 'queued', `GitHub webhook ${wake.event}${wake.action ? ':' + wake.action : ''}`, 'orchestrator', { deliveryId: wake.deliveryId, event: wake.event, action: wake.action, repository: job.repository, prNumber: job.prNumber }, source));
      return;
    }
    await this.reconcileTarget(job.repository, job.prNumber, job.id, `github.webhook:${wake.event}${wake.action ? ':' + wake.action : ''}`);
  }
}
