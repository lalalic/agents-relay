import { GitHubClient, ManagedJobOverview, listManagedGitHubJobs, type DurableStore } from './store.js';
import { EventBus, eventFor } from './events.js';
import { Reconciler } from './reconciler.js';
import { Job, Priority } from './types.js';
import { GitHubWebhookWake } from './github-webhook.js';
import { runScheduledBucketFromStore } from './scheduled-jobs.js';
import { scheduleBucket } from './scheduler.js';
import { ReconcileCoordinator, type ReconcileSignal } from './reconcile-coordinator.js';
import type { EventRecord } from './types.js';
import { errorMessage, observability, withObservabilityCorrelation } from './observability.js';
import { jobHasActiveExecution } from './job-execution-slot.js';

const RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
type HydratableStore = DurableStore & { hydrate?: (job: Job) => Promise<void> };
export function compareJobPriority(a: Job, b: Job): number { return RANK[a.priority ?? 'P2'] - RANK[b.priority ?? 'P2'] || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id); }
export function runnableManagedJobs(items: ManagedJobOverview[]): Job[] { return items.filter(item => item.job.state === 'ACTIVE').map(item => item.job).sort(compareJobPriority); }
export function needsLifecycleReconciliation(job: Job, now = Date.now()): boolean {
  // DRAFT create-only Jobs stay dormant until a caller explicitly creates work.
  if (job.tasks.length === 0) return false;
  if (job.tasks.some(task => (task.state === 'QUEUED' && task.executionId === null)
    || (task.state === 'RUNNING' && task.adapter === 'orchestrator' && task.executionId === null)
    || (task.state === 'DRAFT' && task.dependencies.length > 0))) return true;
  return job.tasks.some(task => ['RUNNING', 'QUEUED'].includes(task.state) && task.executionId !== null && task.leaseExpiresAt !== null && new Date(task.leaseExpiresAt).getTime() <= now);
}
export function terminalManagedJobs(_items: ManagedJobOverview[]): Job[] { return []; }
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
  private readonly scheduleSignalCoordinator: ReconcileCoordinator;
  private dispatchTail: Promise<void> = Promise.resolve();
  private watchedBus?: EventBus;
  constructor(
    private readonly concurrency: number,
    private readonly makeReconciler: (store: DurableStore, maxConcurrent: number) => Reconciler,
    private readonly localInventory: () => Promise<ManagedJobOverview[]>,
    private readonly resolveLocalJob: (jobId: string) => Promise<{ job: Job; store: DurableStore } | null>,
  ) {
    const reportCoordinatorError = (error: unknown, signal: ReconcileSignal): void => {
      observability().record({
        stage: 'reconcile', event: 'reconcile.coordinator_failed', level: 'error', outcome: 'failed',
        message: `Reconcile coordinator failed for ${signal.jobId} (${signal.reason}): ${errorMessage(error)}`,
        correlation: { repository: signal.repository, prNumber: signal.prNumber, jobId: signal.jobId },
        data: { reason: signal.reason },
      });
    };
    this.coordinator = new ReconcileCoordinator((jobId, signals) => this.consumeSignals(jobId, signals), reportCoordinatorError);
    this.scheduleSignalCoordinator = new ReconcileCoordinator((jobId, signals) => this.consumeScheduleSignals(jobId, signals), reportCoordinatorError);
  }
  private async localTarget(jobId: string): Promise<{ job: Job; store: DurableStore } | null> {
    return this.resolveLocalJob(jobId);
  }
  private async requireLocalStore(jobId: string): Promise<DurableStore> {
    const resolved = await this.localTarget(jobId);
    if (!resolved) throw new Error('Authoritative SQLite Job is not registered: ' + jobId);
    return resolved.store;
  }
  private async withDispatchGate(work: () => Promise<void>): Promise<void> {
    const previous = this.dispatchTail;
    let release!: () => void;
    this.dispatchTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { await work(); } finally { release(); }
  }
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
    const event = [...signals].reverse().find(item => item.event?.type === 'schedule.tick')?.event;
    const bucket = typeof event?.data?.bucket === 'string' ? event.data.bucket : null;
    const tickAt = new Date(typeof event?.data?.tickAt === 'string' ? event.data.tickAt : event?.timestamp ?? Date.now());
    if (!bucket || Number.isNaN(tickAt.getTime())) return;
    const target = await this.localTarget(jobId);
    if (!target) return;
    await runScheduledBucketFromStore(target.store, { jobId, bucket }, {
      reconcile: async () => this.reconcileLocalJob(jobId, 'schedule.tick'),
      idle: async () => {},
    }, tickAt);
  }

  async reconcileLocalJob(jobId: string, reason = 'local.request'): Promise<void> {
    const target = await this.localTarget(jobId);
    if (!target) throw new Error('Local job not found: ' + jobId);
    await this.withDispatchGate(async () => {
      await this.reconcileExclusive(jobId, async () => {
        await withObservabilityCorrelation({ jobId, repository: target.job.repository },
          () => this.makeReconciler(target.store, 0).reconcile(jobId));
      });
      await this.reconcileDiscovered(await this.localInventory());
    });
    void reason;
  }

  private async consumeSignals(jobId: string, signals: readonly ReconcileSignal[]): Promise<void> {
    const target = await this.localTarget(jobId);
    if (!target) return;
    const reconciler = this.makeReconciler(target.store, Math.max(1, this.concurrency));
    let shouldReconcile = false;
    for (const signal of signals) {
      if (!signal.event) { shouldReconcile = true; continue; }
      if (signal.event.type === 'github.webhook') continue;
      const outcome = await reconciler.applyEvent(signal.event);
      shouldReconcile ||= outcome.reconcile;
    }
    if (shouldReconcile) await this.reconcileLocalJob(jobId, 'local.signal');
  }

  private async reconcileDiscovered(discovered: ManagedJobOverview[]): Promise<void> {
    const jobs = runnableManagedJobs(discovered);
    let capacity = Math.max(0, this.concurrency - jobs.filter(job => jobHasActiveExecution(job)).length);
    for (const job of jobs) {
      if (capacity <= 0) break;
      const store = await this.requireLocalStore(job.id);
      await (store as HydratableStore).hydrate?.(job);
      const ready = job.tasks.filter(task => (task.state === 'QUEUED' && task.executionId === null) || (task.state === 'DRAFT' && task.dependencies.length > 0)).length;
      const expiredRunning = job.tasks.some(task => ['RUNNING', 'QUEUED'].includes(task.state) && task.executionId !== null && task.leaseExpiresAt !== null && new Date(task.leaseExpiresAt).getTime() <= Date.now());
      if (!needsLifecycleReconciliation(job)) continue;
      const allowance = Math.max(1, Math.min(capacity, ready || (expiredRunning ? 1 : 0) || 1));
      try {
        await this.reconcileExclusive(job.id, async () => {
          await this.makeReconciler(store, allowance).reconcile(job.id);
        });
      } catch (error) {
        observability().record({
          stage: 'reconcile', event: 'reconcile.job_failed', level: 'error', outcome: 'failed',
          message: `Reconcile failed for ${job.id}: ${errorMessage(error)}`,
          correlation: { jobId: job.id, repository: job.repository, prNumber: job.prNumber },
          data: { classification: 'job-isolated' },
        });
      }
      capacity -= allowance;
    }
  }
  async reconcileKnown(discovered: ManagedJobOverview[]): Promise<void> {
    const recovered: ManagedJobOverview[] = [];
    for (const item of discovered) {
      if (item.job.state !== 'ACTIVE') { recovered.push(item); continue; }
      const store = await this.requireLocalStore(item.job.id);
      await (store as HydratableStore).hydrate?.(item.job);
      const reconciler = this.makeReconciler(store, 0);
      let recoveredJob = item.job;
      if (typeof reconciler.recoverStartupOrphans === 'function') await this.reconcileExclusive(item.job.id, async () => {
        recoveredJob = await reconciler.recoverStartupOrphans(item.job.id);
      });
      recovered.push({ ...item, job: recoveredJob });
    }
    await this.reconcileDiscovered(recovered);
  }
  async reconcile(): Promise<void> {
    if (this.running) { this.pending = true; return; }
    this.running = true;
    try {
      do {
        this.pending = false;
        await this.withDispatchGate(async () => this.reconcileDiscovered(await this.localInventory()));
      } while (this.pending);
    } finally { this.running = false; }
  }
  async reconcileTarget(_repository: string, _prNumber: number, jobId: string, reason = 'target.request'): Promise<void> {
    // Transport metadata is never used for routing; reject observational wakeups.
    if (reason.startsWith('github.webhook:')) return;
    await this.coordinator.accept({ jobId, reason });
  }
  async watch(bus: EventBus): Promise<() => Promise<void>> {
    this.watchedBus = bus;
    const unsubscribe = await bus.subscribeAll(async event => {
      const routedWebhook = event.type === 'github.webhook' && event.data?.coordinatorRouted === true;
      const ingressWebhook = event.type === 'github.webhook' && event.data?.coordinatorIngress === true && !routedWebhook;
      if (event.type === 'schedule.tick') {
        await this.scheduleSignalCoordinator.acceptTransport({ jobId: event.job_id, reason: this.signalReason(event), event });
        return;
      }
      if (ingressWebhook) return;
      if (routedWebhook) return;
      const lifecycle = ['task.started', 'task.completed', 'task.failed', 'task.blocked', 'task.unblocked', 'task.cancelled', 'review.started', 'review.approved', 'review.changes_required', 'review.blocked'].includes(event.type);
      // GitHub transport is observational. It must never wake lifecycle execution.
      if (event.type === 'github.webhook') return;
      const wake = event.type === 'job.wake' || event.type === 'review.created' || event.type === 'planner.completed';
      if (!lifecycle && !wake) return;
      await this.coordinator.acceptTransport({
        jobId: event.job_id,
        reason: this.signalReason(event),
        event: lifecycle ? event : undefined,
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
      { bucket: scheduleBucket(new Date(job.schedule.nextRunAt)), tickAt: now.toISOString() },
      { agent: 'relay', component: 'scheduler-timer' },
    );
    // Use the same coordinator-owned schedule path whether transport is available or not.
    if (bus) { await bus.publish(event); return; }
    await this.scheduleSignalCoordinator.accept({ jobId: job.id, reason: this.signalReason(event), event });
  }

  async webhookSignal(_bus: EventBus | undefined, _wake: GitHubWebhookWake): Promise<void> {
    // Uncorrelated webhook wakeups are intentionally ignored. A caller must first
    // resolve the target from local cached state and then call webhookWake().
  }

  async webhookWake(bus: EventBus | undefined, job: Job, wake: GitHubWebhookWake): Promise<void> {
    if (bus) {
      const source = { id: `github/${job.repository}/delivery/${wake.deliveryId}`, component: 'github-webhook' };
      if (wake.publication) {
        const publishEvent = eventFor(
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
        );
        publishEvent.event_id = 'github:' + job.id + ':' + wake.deliveryId + ':package.published';
        await bus.publish(publishEvent);
      }
      if (wake.publishFailure) {
        const failedEvent = eventFor(job.id, 'release', null, 'package.publish_failed', 'failed',
          `Publish workflow ${wake.publishFailure.runId} failed: ${wake.publishFailure.stage}`,
          'user', { ...wake.publishFailure, repository: job.repository, prNumber: job.prNumber, deliveryId: wake.deliveryId }, source);
        failedEvent.event_id = 'github:' + job.id + ':' + wake.deliveryId + ':package.publish_failed';
        await bus.publish(failedEvent);
      }
      await bus.publish(eventFor(job.id, 'github', null, 'github.webhook', 'queued', `GitHub webhook ${wake.event}${wake.action ? ':' + wake.action : ''}`, 'orchestrator', { deliveryId: wake.deliveryId, event: wake.event, action: wake.action, repository: job.repository, prNumber: job.prNumber }, source));
      return;
    }
    // Without EventBus the GitHub observation stays in SQLite; it does not wake execution.
  }
}
