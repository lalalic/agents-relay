import { GitHubClient, GitHubStore, ManagedJobOverview, listManagedGitHubJobs } from './store.js';
import { EventBus, eventFor } from './events.js';
import { Reconciler } from './reconciler.js';
import { Job, Priority } from './types.js';

const RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
export function compareJobPriority(a: Job, b: Job): number { return RANK[a.priority ?? 'P2'] - RANK[b.priority ?? 'P2'] || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id); }
function hasRunnableOrPendingTasks(job: Job): boolean { return job.tasks.some(task => !['SUCCEEDED','FAILED','CANCELLED'].includes(task.state)); }
export function runnableManagedJobs(items: ManagedJobOverview[]): Job[] { return items.filter(item => item.githubState === 'OPEN' && !item.draft && (!['COMPLETED','CANCELLED'].includes(item.job.state) || hasRunnableOrPendingTasks(item.job))).map(item => item.job).sort(compareJobPriority); }
export function terminalManagedJobs(items: ManagedJobOverview[]): Job[] { return items.filter(item => item.githubState !== 'OPEN' && ((item.githubState === 'MERGED' && item.job.state !== 'COMPLETED') || (item.githubState === 'CLOSED' && item.job.state !== 'CANCELLED'))).map(item => item.job).sort(compareJobPriority); }
export async function aggregateManagedGitHubJobs(client: GitHubClient, repositories: readonly string[], trustedAuthors: ReadonlySet<string>): Promise<ManagedJobOverview[]> {
  const uniqueRepositories = [...new Set(repositories)];
  const groups = await Promise.all(uniqueRepositories.map(repository => listManagedGitHubJobs(client, repository, trustedAuthors)));
  return groups.flat().sort((a, b) => b.job.updatedAt.localeCompare(a.job.updatedAt) || b.job.prNumber - a.job.prNumber);
}

export class RepositoryWorkerPool {
  private running = false;
  private pending = false;
  constructor(
    private readonly client: GitHubClient,
    repository: string | readonly string[],
    private readonly trustedAuthors: ReadonlySet<string>,
    private readonly concurrency: number,
    private readonly makeReconciler: (store: GitHubStore, maxConcurrent: number) => Reconciler,
  ) { this.repositories = [...new Set(typeof repository === 'string' ? [repository] : repository)]; }
  private readonly repositories: string[];
  async reconcile(): Promise<void> {
    if (this.running) { this.pending = true; return; }
    this.running = true;
    try {
      do {
        this.pending = false;
        const discovered = await aggregateManagedGitHubJobs(this.client, this.repositories, this.trustedAuthors);
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
          const ready = job.tasks.filter(task => ['READY','QUEUED','WAITING'].includes(task.state)).length;
          if (ready === 0 && job.tasks.length > 0) continue;
          const allowance = Math.max(1, Math.min(capacity, ready || 1));
          await this.makeReconciler(store, allowance).reconcile(job.id);
          capacity -= allowance;
        }
      } while (this.pending);
    } finally { this.running = false; }
  }
  async reconcileTarget(repository: string, prNumber: number, jobId: string): Promise<void> {
    if (!this.repositories.includes(repository)) return;
    const store = new GitHubStore(this.client, repository, prNumber, this.trustedAuthors);
    await this.makeReconciler(store, Math.max(1, this.concurrency)).reconcile(jobId);
  }
  async watch(bus: EventBus): Promise<() => Promise<void>> {
    return bus.subscribeAll(async event => {
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
  async webhookWake(bus: EventBus | undefined, job: Job, deliveryId: string, event: string, action: string | null): Promise<void> {
    if (bus) {
      await bus.publish(eventFor(job.id, 'github', null, 'github.webhook', 'queued', `GitHub webhook ${event}${action ? ':' + action : ''}`, 'orchestrator', { deliveryId, event, action, repository: job.repository, prNumber: job.prNumber }));
      return;
    }
    await this.reconcileTarget(job.repository, job.prNumber, job.id);
  }
}
