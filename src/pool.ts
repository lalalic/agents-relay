import { GitHubClient, GitHubStore, ManagedJobOverview, listManagedGitHubJobs } from './store.js';
import { EventBus, eventFor } from './events.js';
import { Reconciler } from './reconciler.js';
import { Job, Priority } from './types.js';
import { GitHubWebhookWake } from './github-webhook.js';

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
  private readonly jobTargets = new Map<string, { repository: string; prNumber: number }>();
  constructor(
    private readonly client: GitHubClient,
    repository: string | readonly string[],
    private readonly trustedAuthors: ReadonlySet<string>,
    private readonly concurrency: number,
    private readonly makeReconciler: (store: GitHubStore, maxConcurrent: number) => Reconciler,
  ) { this.repositories = [...new Set(typeof repository === 'string' ? [repository] : repository)]; }
  private readonly repositories: string[];
  private async reconcileDiscovered(discovered: ManagedJobOverview[]): Promise<void> {
    for (const item of discovered) this.jobTargets.set(item.job.id, { repository: item.job.repository, prNumber: item.job.prNumber });
    // Terminal PRs must be reconciled before OPEN-job scheduling. Otherwise the
    // OPEN-only runnable filter can strand durable jobs after GitHub merges/closes them.
    for (const job of terminalManagedJobs(discovered)) {
      const store = new GitHubStore(this.client, job.repository, job.prNumber, this.trustedAuthors);
      await this.makeReconciler(store, 0).reconcile(job.id);
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
      await this.makeReconciler(store, allowance).reconcile(job.id);
      capacity -= allowance;
    }
  }
  async reconcileKnown(discovered: ManagedJobOverview[]): Promise<void> { await this.reconcileDiscovered(discovered); }
  async reconcile(): Promise<void> {
    if (this.running) { this.pending = true; return; }
    this.running = true;
    try {
      do {
        this.pending = false;
        await this.reconcileDiscovered(await aggregateManagedGitHubJobs(this.client, this.repositories, this.trustedAuthors));
      } while (this.pending);
    } finally { this.running = false; }
  }
  async reconcileTarget(repository: string, prNumber: number, jobId: string): Promise<void> {
    if (!this.repositories.includes(repository)) return;
    this.jobTargets.set(jobId, { repository, prNumber });
    const store = new GitHubStore(this.client, repository, prNumber, this.trustedAuthors);
    await this.makeReconciler(store, Math.max(1, this.concurrency)).reconcile(jobId);
  }
  private async handleLifecycleEvent(event: import('./types.js').EventRecord): Promise<void> {
    const target = this.jobTargets.get(event.job_id);
    if (!target || !this.repositories.includes(target.repository)) {
      process.stderr.write(`warning: terminal event target unknown for job ${event.job_id}\n`);
      return;
    }
    const store = new GitHubStore(this.client, target.repository, target.prNumber, this.trustedAuthors);
    await this.makeReconciler(store, Math.max(1, this.concurrency)).handleEvent(event);
  }
  async watch(bus: EventBus): Promise<() => Promise<void>> {
    return bus.subscribeAll(async event => {
      if (['task.started', 'task.completed', 'task.failed', 'task.blocked', 'task.cancelled', 'review.started', 'review.approved', 'review.changes_required', 'review.blocked'].includes(event.type)) {
        await this.handleLifecycleEvent(event);
        return;
      }
      if (event.type === 'job.wake' || event.type === 'github.webhook') {
        const repository = typeof event.data?.repository === 'string' ? event.data.repository : '';
        const prNumber = Number(event.data?.prNumber);
        if (repository && Number.isInteger(prNumber) && prNumber > 0) {
          await this.reconcileTarget(repository, prNumber, event.job_id);
          return;
        }
      }
      if (event.type === 'job.wake' || event.type === 'github.webhook') await this.reconcile();
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
    await this.reconcileTarget(job.repository, job.prNumber, job.id);
  }
}
