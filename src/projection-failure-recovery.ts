import type { EventBus } from './events.js';
import { eventFor } from './events.js';
import { beginProjectionRecovery } from './projection-recovery.js';
import { reconcileProjectionRecovery } from './projection-recovery-runtime.js';
import type { ProjectionFailureDeduplicator } from './projection-failure-dedupe.js';
import type { Job } from './types.js';
import { SQLiteRelayStore } from './relay-store.js';
import { classifyFailure, errorMessage, observability } from './observability.js';
import { resolveManagedProjectPath } from './workspace.js';
import type { ProjectionRecoveryOptions } from './projection-recovery-runtime.js';

export async function reconcileBindingProjectionRecovery(
  job: Job,
  store: SQLiteRelayStore,
  options: ProjectionRecoveryOptions,
): Promise<{ skip: true } | { skip: false; projectedMerge?: NonNullable<Awaited<ReturnType<typeof reconcileProjectionRecovery>>>['projectedMerge'] }> {
  const recovery = await reconcileProjectionRecovery(job, store, options);
  if (recovery && recovery.state === 'escalated') return { skip: true };
  if (recovery && !['retry', 'projected'].includes(recovery.state)) return { skip: true };
  if (recovery?.state === 'retry' && !recovery.projectedMerge) return { skip: true };
  return { skip: false, projectedMerge: recovery?.projectedMerge };
}

export async function projectBindingLocalMerge(
  job: Job,
  store: SQLiteRelayStore,
  options: ProjectionRecoveryOptions,
): Promise<{ skip: true } | { skip: false; projectedMerge: Awaited<ReturnType<ProjectionRecoveryOptions['project']>> | undefined }> {
  const recovery = await reconcileBindingProjectionRecovery(job, store, options);
  if (recovery.skip) return recovery;
  return { skip: false, projectedMerge: recovery.projectedMerge ?? await options.project(job) };
}

export async function handleGitHubProjectionFailure(
  error: unknown,
  job: Job,
  snapshotPath: string,
  options: {
    relayStores: Map<string, SQLiteRelayStore>;
    repositoryPaths: ReadonlyMap<string, string>;
    explicitProjectPath: string;
    workspaceRoot: string;
    gitText: (cwd: string, args: string[]) => Promise<string>;
    reconcileLocalJob: (jobId: string, reason: string) => Promise<void>;
    eventBus?: EventBus;
    deduplicator: ProjectionFailureDeduplicator;
  },
): Promise<void> {
  const reason = errorMessage(error), classification = classifyFailure(error).classification;
  if (job.state === 'COMPLETED' && job.localMerge?.status === 'succeeded') {
    const recoveryStore = options.relayStores.get(`${snapshotPath}#${job.id}`)
      ?? new SQLiteRelayStore(snapshotPath, job.id);
    options.relayStores.set(`${snapshotPath}#${job.id}`, recoveryStore);
    const recoveryPath = options.repositoryPaths.get(job.repository)
      ?? await resolveManagedProjectPath(job.repository, options.explicitProjectPath, options.workspaceRoot);
    const remoteSha = await options.gitText(recoveryPath, ['fetch','--no-tags','origin','+refs/heads/main:refs/remotes/origin/main'])
      .then(() => options.gitText(recoveryPath, ['rev-parse','--verify','refs/remotes/origin/main']))
      .catch(() => '');
    const recovery = await beginProjectionRecovery(recoveryStore, job.id, remoteSha, reason);
    if (recovery === 'created') {
      await options.reconcileLocalJob(job.id, 'projection.delivery_failed');
      await options.eventBus?.publish(eventFor(job.id,'projection',null,'projection.recovery_requested','queued',
        `Projection recovery task created for origin/main ${remoteSha}`,'orchestrator',
        {remoteSha, idempotencyKey:`${job.id}:${remoteSha}`},
        {agent:'relay',component:'projection-conflict'})).catch(()=>{});
    } else if (recovery === 'escalated') {
      await options.eventBus?.publish(eventFor(job.id,'projection',null,'projection.recovery_escalated','failed',
        'Projection recovery exhausted its bounded task retry budget','user',
        {idempotencyKey:`${job.id}:${remoteSha}`},
        {agent:'relay',component:'projection-conflict'})).catch(()=>{});
    }
  }
  if (!options.deduplicator.shouldReport(job.id, job.updatedAt, reason, classification)) return;
  await options.eventBus?.publish(eventFor(job.id,'projection',null,'projection.delivery_failed','failed',
    `GitHub projection failed: ${errorMessage(error)}`,'orchestrator',
    {operation:'github.projectLocalMerge',error:reason},
    {agent:'relay',component:'github-projection'}))?.catch(()=>{});
  observability().record({
    stage: 'projection', event: 'github.binding_job_failed', level: 'warn', outcome: 'failed',
    message: `GitHub binding/projection failed for ${job.id}: ${reason}`,
    correlation: { repository: job.repository, prNumber: job.prNumber, jobId: job.id },
    data: { classification, reason },
  });
}
