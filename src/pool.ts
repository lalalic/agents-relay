import { GitHubClient, GitHubStore, ManagedJobOverview, listManagedGitHubJobs, withGitHubRequestContext, type GitHubPullRequestSeed, type ManagedGitHubPullRequestSnapshot } from './store.js';
import { EventBus, eventFor } from './events.js';
import { Reconciler } from './reconciler.js';
import { Job, Priority } from './types.js';
import { GitHubWebhookWake } from './github-webhook.js';
import { ReconcileCoordinator, type ReconcileSignal } from './reconcile-coordinator.js';
import type { EventRecord } from './types.js';

const RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
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
  private watchedBus?: EventBus;
  private readonly jobTargets = new Map<string, { repository: string; prNumber: number }>();
  private readonly targetSeeds = new Map<string, GitHubPullRequestSeed>();
  constructor(
    private readonly client: GitHubClient,
    repository: string | readonly string[],
    private readonly trustedAuthors: ReadonlySet<string>,
    private readonly concurrency: number,
    private readonly makeReconciler: (store: GitHubStore, maxConcurrent: number) => Reconciler,
    private readonly isRateLimited: () => boolean = () => false,
    private readonly refreshWebhookSnapshot?: (repository: string, prNumber: number, trigger: string) => Promise<ManagedGitHubPullRequestSnapshot>,
  ) {
    this.repositories = [...new Set(typeof repository === 'string' ? [repository] : repository)];
    const reportCoordinatorError = (error: unknown, signal: ReconcileSignal): void => {
      process.stderr.write(`warning: reconcile coordinator failed for ${signal.jobId} (${signal.reason}): ${error instanceof Error ? error.message : String(error)}\n`);
    };
    this.coordinator = new ReconcileCoordinator((jobId, signals) => this.consumeSignals(jobId, signals), reportCoordinatorError);
    this.githubSignalCoordinator = new ReconcileCoordinator((_key, signals) => this.consumeGitHubSignals(signals), reportCoordinatorError);
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

  private async consumeGitHubSignals(signals: readonly ReconcileSignal[]): Promise<void> {
    if (this.isRateLimited() || signals.length === 0) return;
    const repository = signals.find(signal => signal.repository)?.repository;
    const prNumber = signals.find(signal => signal.prNumber)?.prNumber;
    if (!repository || !prNumber || !this.repositories.includes(repository)) return;
    if (!this.refreshWebhookSnapshot) {
      process.stderr.write(`warning: GitHub webhook signal refresh unavailable for ${repository}#${prNumber}\n`);
      return;
    }
    const reasons = [...new Set(signals.map(signal => signal.reason))];
    const trigger = reasons.join('+') || 'github.webhook';
    const snapshot = await this.refreshWebhookSnapshot(repository, prNumber, trigger);
    const sourceEvents = signals.map(signal => signal.event).filter((event): event is EventRecord => Boolean(event));

    for (const item of snapshot.overviews) {
      this.jobTargets.set(item.job.id, { repository, prNumber });
      this.seedTargetSnapshot(repository, prNumber, item.job.id, snapshot.seed);
      if (this.watchedBus) {
        for (const event of sourceEvents) {
          const publication = event.data?.publication;
          if (publication && typeof publication === 'object') {
            const value = publication as Record<string, unknown>;
            await this.watchedBus.publish(eventFor(
              item.job.id,
              'release',
              null,
              'package.published',
              'succeeded',
              `Published ${String(value.package ?? 'package')}@${String(value.version ?? 'unknown')}`,
              'orchestrator',
              {
                deliveryId: event.data?.deliveryId,
                repository,
                prNumber,
                package: value.package,
                version: value.version,
                registry: value.registry,
                sha: value.sha,
              },
              event.source,
            ));
          }
          await this.watchedBus.publish(eventFor(
            item.job.id,
            'github',
            null,
            'github.webhook',
            'queued',
            event.message,
            'orchestrator',
            { ...(event.data ?? {}), coordinatorIngress: false, coordinatorRouted: true },
            event.source,
          ));
        }
      }
      await this.coordinator.accept({ jobId: item.job.id, reason: trigger, repository, prNumber });
    }
  }

  private async consumeSignals(jobId: string, signals: readonly ReconcileSignal[]): Promise<void> {
    if (this.isRateLimited()) return;
    for (const signal of signals) {
      if (signal.repository && signal.prNumber && this.repositories.includes(signal.repository)) {
        this.jobTargets.set(jobId, { repository: signal.repository, prNumber: signal.prNumber });
      }
    }
    const target = this.jobTargets.get(jobId);
    if (!target || !this.repositories.includes(target.repository)) {
      process.stderr.write(`warning: reconcile signal target unknown for job ${jobId}\n`);
      return;
    }
    const seedKey = `${target.repository}#${target.prNumber}:${jobId}`;
    const mayConsumeSeed = signals.some(signal => signal.reason === 'target.request' || signal.reason.startsWith('github.webhook:'));
    const seed = mayConsumeSeed ? this.targetSeeds.get(seedKey) ?? null : null;
    if (mayConsumeSeed) this.targetSeeds.delete(seedKey);
    const store = new GitHubStore(this.client, target.repository, target.prNumber, this.trustedAuthors, seed);
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
      shouldReconcile ||= result.reconcile;
    }
    if (!shouldReconcile) return;
    const reason = [...new Set(reasons)].join('+') || 'unknown';
    await this.reconcileExclusive(jobId, async () => {
      await withGitHubRequestContext(this.client, `pool.coordinator-reconcile:${reason}`, () => reconciler.reconcile(jobId));
    });
  }

  private async reconcileDiscovered(discovered: ManagedJobOverview[]): Promise<void> {
    for (const item of discovered) this.jobTargets.set(item.job.id, { repository: item.job.repository, prNumber: item.job.prNumber });
    // Terminal PRs must be reconciled before OPEN-job scheduling. Otherwise the
    // OPEN-only runnable filter can strand durable jobs after GitHub merges/closes them.
    for (const job of terminalManagedJobs(discovered)) {
      await this.reconcileExclusive(job.id, async () => {
        const store = new GitHubStore(this.client, job.repository, job.prNumber, this.trustedAuthors);
        await withGitHubRequestContext(this.client, 'pool.terminal-reconcile', () => this.makeReconciler(store, 0).reconcile(job.id));
      });
    }
    const jobs = runnableManagedJobs(discovered);
    let capacity = Math.max(1, this.concurrency);
    for (const job of jobs) {
      if (capacity <= 0) break;
      const store = new GitHubStore(this.client, job.repository, job.prNumber, this.trustedAuthors);
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
  async reconcileKnown(discovered: ManagedJobOverview[]): Promise<void> { await this.reconcileDiscovered(discovered); }
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
      if (ingressWebhook && repository && prNumber) {
        await this.githubSignalCoordinator.acceptTransport({
          jobId: `${repository}#${prNumber}`,
          reason: this.signalReason(event),
          event,
          repository,
          prNumber,
        });
        return;
      }
      if (routedWebhook) return;
      const lifecycle = ['task.started', 'task.completed', 'task.failed', 'task.blocked', 'task.cancelled', 'review.started', 'review.approved', 'review.changes_required', 'review.blocked'].includes(event.type);
      const wake = event.type === 'job.wake' || event.type === 'github.webhook';
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
  async webhookSignal(bus: EventBus | undefined, wake: GitHubWebhookWake): Promise<void> {
    if (!wake.repository || !wake.pullRequest) return;
    const source = { id: `github/${wake.repository}/delivery/${wake.deliveryId}`, component: 'github-webhook' };
    const event = eventFor(
      'github-webhook',
      'github',
      null,
      'github.webhook',
      'queued',
      `GitHub webhook ${wake.event}${wake.action ? ':' + wake.action : ''}`,
      'orchestrator',
      {
        deliveryId: wake.deliveryId,
        event: wake.event,
        action: wake.action,
        repository: wake.repository,
        prNumber: wake.pullRequest,
        publication: wake.publication ?? null,
        coordinatorIngress: true,
      },
      source,
    );
    if (bus) {
      await bus.publish(event);
      return;
    }
    await this.githubSignalCoordinator.accept({
      jobId: `${wake.repository}#${wake.pullRequest}`,
      reason: this.signalReason(event),
      event,
      repository: wake.repository,
      prNumber: wake.pullRequest,
    });
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
      await bus.publish(eventFor(job.id, 'github', null, 'github.webhook', 'queued', `GitHub webhook ${wake.event}${wake.action ? ':' + wake.action : ''}`, 'orchestrator', { deliveryId: wake.deliveryId, event: wake.event, action: wake.action, repository: job.repository, prNumber: job.prNumber }, source));
      return;
    }
    await this.reconcileTarget(job.repository, job.prNumber, job.id, `github.webhook:${wake.event}${wake.action ? ':' + wake.action : ''}`);
  }
}
