import { DurableStore, GitHubStore } from '../store.js';
import { Reconciler } from '../reconciler.js';
import { CodexAdapter, WorkerAdapter } from '../adapters.js';
import { EventBus } from '../events.js';
import { EventRecord, JobState, TaskState } from '../types.js';
import { GatewayConfig, GatewayProject } from './config.js';
import { GitHubGatewayClient } from './github.js';
import { getPull, jobIdFromBranch, markerJobIdForPull, readJobOrNull, searchOpenPullNumbers, storeFor } from './anchor.js';

const TERMINAL_JOB_STATES: readonly JobState[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_JOB_STATES.includes(state);
}

export type JobRuntime = {
  jobId: string;
  project: GatewayProject;
  prNumber: number;
  store: GitHubStore;
  reconciler: Reconciler;
  unsubscribe: () => Promise<void>;
  watchdog: NodeJS.Timeout;
  lastActivityAt: number;
  lastKnownState: JobState;
};

export type RecoveryReport = { discovered: number; recovered: number; skippedTerminal: number; skippedUnresolved: number };

export type SupervisorOptions = {
  config: GatewayConfig;
  client: GitHubGatewayClient;
  eventBus?: EventBus;
  emit?: (event: EventRecord) => void | Promise<void>;
  adapters?: WorkerAdapter[];
  createReconciler?: (store: DurableStore, project: GatewayProject) => Reconciler;
  now?: () => number;
};

export class CapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapacityError';
  }
}

/**
 * Owns one existing GitHubStore + Reconciler per active job. The registry is a disposable cache:
 * GitHub markers remain durable truth and are enough to rebuild every runtime after a restart.
 */
export class JobSupervisor {
  private readonly runtimes = new Map<string, JobRuntime>();
  private sweep: NodeJS.Timeout | null = null;

  constructor(private readonly options: SupervisorOptions) {}

  size(): number {
    return this.runtimes.size;
  }

  has(jobId: string): boolean {
    return this.runtimes.has(jobId);
  }

  get(jobId: string): JobRuntime | undefined {
    return this.runtimes.get(jobId);
  }

  atCapacity(): boolean {
    return this.runtimes.size >= this.options.config.maxActiveJobs;
  }

  touch(jobId: string): void {
    const runtime = this.runtimes.get(jobId);
    if (runtime) runtime.lastActivityAt = this.now();
  }

  async ensure(project: GatewayProject, jobId: string, prNumber: number, initialState: JobState): Promise<{ runtime: JobRuntime; created: boolean }> {
    const existing = this.runtimes.get(jobId);
    if (existing) {
      existing.lastActivityAt = this.now();
      return { runtime: existing, created: false };
    }
    if (this.atCapacity()) throw new CapacityError(`Active job limit ${this.options.config.maxActiveJobs} reached`);
    const store = storeFor(this.options.client, project, prNumber);
    const reconciler = this.createReconciler(store, project);
    const unsubscribe = await reconciler.watch(jobId);
    const watchdog = setInterval(() => {
      void this.reconcileBounded(jobId, this.options.config.createTimeoutMs);
    }, this.options.config.watchdogMs);
    watchdog.unref();
    const runtime: JobRuntime = { jobId, project, prNumber, store, reconciler, unsubscribe, watchdog, lastActivityAt: this.now(), lastKnownState: initialState };
    this.runtimes.set(jobId, runtime);
    this.startSweep();
    return { runtime, created: true };
  }

  /** Never awaited for correctness: a timed-out or failed reconcile leaves the durable state authoritative. */
  async reconcileBounded(jobId: string, timeoutMs: number): Promise<boolean> {
    const runtime = this.runtimes.get(jobId);
    if (!runtime) return false;
    runtime.lastActivityAt = this.now();
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs));
      timer.unref();
    });
    try {
      const outcome = await Promise.race([
        runtime.reconciler.reconcile(jobId).then(job => {
          runtime.lastKnownState = job.state;
          return 'reconciled' as const;
        }),
        timeout,
      ]);
      return outcome === 'reconciled';
    } catch {
      return false;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async recover(): Promise<RecoveryReport> {
    const report: RecoveryReport = { discovered: 0, recovered: 0, skippedTerminal: 0, skippedUnresolved: 0 };
    for (const project of this.options.config.projects) {
      const numbers = await searchOpenPullNumbers(this.options.client, project);
      for (const number of numbers) {
        report.discovered += 1;
        const pull = await getPull(this.options.client, project.repository, number);
        if (!pull) {
          report.skippedUnresolved += 1;
          continue;
        }
        let jobId = jobIdFromBranch(project, pull.branch);
        if (jobId === null) {
          try {
            jobId = await markerJobIdForPull(this.options.client, project, number);
          } catch {
            jobId = null;
          }
        }
        if (jobId === null) {
          report.skippedUnresolved += 1;
          continue;
        }
        const store = storeFor(this.options.client, project, number);
        const job = await readJobOrNull(store, jobId);
        if (!job) {
          report.skippedUnresolved += 1;
          continue;
        }
        if (isTerminalJobState(job.state)) {
          report.skippedTerminal += 1;
          continue;
        }
        try {
          const { created } = await this.ensure(project, jobId, number, job.state);
          if (created) report.recovered += 1;
          await this.reconcileBounded(jobId, this.options.config.createTimeoutMs);
        } catch (error) {
          if (error instanceof CapacityError) {
            report.skippedUnresolved += 1;
            continue;
          }
          throw error;
        }
      }
    }
    return report;
  }

  evictIdle(): number {
    const now = this.now();
    let evicted = 0;
    for (const [jobId, runtime] of [...this.runtimes]) {
      if (!isTerminalJobState(runtime.lastKnownState)) continue;
      if (now - runtime.lastActivityAt < this.options.config.idleTtlMs) continue;
      this.runtimes.delete(jobId);
      void this.stopRuntime(runtime);
      evicted += 1;
    }
    return evicted;
  }

  async stop(): Promise<void> {
    if (this.sweep !== null) {
      clearInterval(this.sweep);
      this.sweep = null;
    }
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(runtimes.map(runtime => this.stopRuntime(runtime)));
  }

  private async stopRuntime(runtime: JobRuntime): Promise<void> {
    clearInterval(runtime.watchdog);
    try {
      await runtime.unsubscribe();
    } catch {
      /* unsubscribing is best effort; the durable state is unaffected */
    }
  }

  private startSweep(): void {
    if (this.sweep !== null) return;
    const interval = Math.max(5000, Math.min(this.options.config.idleTtlMs, 60000));
    this.sweep = setInterval(() => this.evictIdle(), interval);
    this.sweep.unref();
  }

  private createReconciler(store: DurableStore, project: GatewayProject): Reconciler {
    if (this.options.createReconciler) return this.options.createReconciler(store, project);
    return new Reconciler(store, {
      owner: `gateway-${process.pid}`,
      maxConcurrent: project.maxConcurrent,
      leaseMs: Math.max(300000, project.timeoutMs),
      adapters: this.options.adapters ?? [new CodexAdapter(this.options.config.codexCommand)],
      continuations: [],
      eventBus: this.options.eventBus,
      emit: this.options.emit,
    });
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}

export function isNonTerminalTaskState(state: TaskState): boolean {
  return !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(state);
}
