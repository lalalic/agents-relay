import type { EventBus } from './events.js';
import { eventFor } from './events.js';
import { deliverLocalMerge, localSourceHead } from './local-git-merge.js';
import { projectAuthoritativeLocalMerge } from './local-merge-projection.js';
import type { Job } from './types.js';
import type { RelayStore } from './relay-store.js';
import { dispatchWorkflowGraph } from './workflow/dispatcher.js';
import { projectionConflictV2 } from './workflow/projection-conflict-v2.js';

type ProjectionReceipt = ReturnType<typeof projectAuthoritativeLocalMerge>;
export type ProjectionRecoveryOptions = {
  projectPath: string;
  project: (job: Job) => Promise<ProjectionReceipt>;
  verifyObservedRemote: (sha: string) => Promise<void>;
  eventBus?: EventBus;
};

/** Executes only the retry or escalation selected by the projection-conflict graph. */
export async function reconcileProjectionRecovery(
  job: Job,
  store: RelayStore,
  options: ProjectionRecoveryOptions,
): Promise<{ state: string; projectedMerge?: ProjectionReceipt } | null> {
  const recovery = job.projectionRecovery;
  if (!recovery) return null;
  if (recovery.status === 'projected' || recovery.status === 'escalated') return { state: recovery.status };

  const repair = job.tasks.find(task => task.id === recovery.taskId);
  const reviewTask = job.review?.taskId ? job.tasks.find(task => task.id === job.review?.taskId) : undefined;
  const expectedReviewTaskId = job.review?.taskId;
  const expectedReviewOutcome = job.review?.outcome;
  const expectedReviewHeadSha = job.review?.headSha;
  let projectedMerge: ProjectionReceipt | undefined;
  let claimed = false;
  let escalated = false;
  let projectionCompleted = false;
  const decision = await dispatchWorkflowGraph(projectionConflictV2, {
    initialState: recovery.status, input: { transport: 'event', id: 'reconcile', payload: {} },
    durableFacts: {
      repairTaskState: repair?.state,
      reviewTaskState: reviewTask?.state,
      reviewOutcome: job.review?.outcome,
      taskRetryAvailable: repair?.state !== 'FAILED',
      attempts: recovery.attempts,
      maxAttempts: recovery.maxAttempts,
    }, graphName: 'projection-conflict', maxSteps: 1,
    persistTransition: async (source, target) => {
      if (target === 'retry') {
        if (!store.mutateJob) throw new Error('Atomic SQLite mutation is required for projection recovery attempts');
        await store.mutateJob(job.id, current => {
          const currentRecovery = current.projectionRecovery;
          const currentRepair = current.tasks.find(task => task.id === currentRecovery?.taskId);
          const currentReviewTask = current.review?.taskId
            ? current.tasks.find(task => task.id === current.review?.taskId) : undefined;
          if (current.state !== 'COMPLETED' || currentRecovery?.key !== recovery.key
            || currentRecovery.taskId !== recovery.taskId || currentRecovery.status !== source
            || currentRecovery.attempts !== recovery.attempts || currentRepair?.state !== repair?.state
            || currentReviewTask?.id !== expectedReviewTaskId || current.review?.outcome !== expectedReviewOutcome
            || current.review?.headSha !== expectedReviewHeadSha) return current;
          claimed = true;
          return { ...current, projectionRecovery: { ...currentRecovery, status: 'retry',
            attempts: currentRecovery.attempts + 1, updatedAt: new Date().toISOString() } };
        });
      } else if (target === 'escalated') {
        if (!store.mutateJob) throw new Error('Atomic SQLite mutation is required for projection recovery status');
        await store.mutateJob(job.id, current => current.projectionRecovery?.key === recovery.key
          && current.projectionRecovery.taskId === recovery.taskId
          && current.projectionRecovery.status === source
          && current.projectionRecovery.attempts === recovery.attempts
          ? (escalated = true, { ...current, projectionRecovery: { ...current.projectionRecovery, status: 'escalated', updatedAt: new Date().toISOString() } })
          : current);
      } else if (source !== target) throw new Error(`Unexpected projection recovery transition ${source} -> ${target}`);
    },
    executeAction: async actionId => {
      if (actionId === 'effect.projectLocalMerge') {
        if (!claimed) return {};

        const localMerge = job.localMerge;
        if (!localMerge) throw new Error('Projection recovery requires a durable local merge receipt');
        const sourceSha = localSourceHead(options.projectPath, localMerge.sourceRef);
        if (job.review?.headSha !== sourceSha) throw new Error('Projection recovery source changed after review');
        const delivered = deliverLocalMerge(options.projectPath, { ...localMerge, sourceSha,
          correlationJobId: job.id, displayPrNumber: job.prNumber > 0 ? job.prNumber : undefined });
        await options.verifyObservedRemote(recovery.remoteSha);
        const projectedJob: Job = { ...job, localMerge: { ...localMerge, sourceSha: delivered.sourceSha,
          mergedCommitSha: delivered.mergedCommitSha, status: 'succeeded', error: undefined,
          nextAttemptAt: undefined, updatedAt: new Date().toISOString() } };
        projectedMerge = await options.project(projectedJob);
        let finalized = false;
        const deliveredDecision = await dispatchWorkflowGraph(projectionConflictV2, {
          initialState: 'retry', input: { transport: 'event', id: 'projection.delivered', payload: {} },
          durableFacts: {}, graphName: 'projection-conflict', maxSteps: 1,
          persistTransition: async (source, target) => {
            if (source !== 'retry' || target !== 'projected' || !store.mutateJob) return;
            await store.mutateJob(job.id, current => {
              const currentMerge = current.localMerge;
              if (current.projectionRecovery?.key !== recovery.key
                || current.projectionRecovery.taskId !== recovery.taskId
                || current.projectionRecovery.status !== 'retry'
                || current.projectionRecovery.attempts !== recovery.attempts + 1
                || currentMerge?.sourceRef !== localMerge.sourceRef || currentMerge.targetRef !== localMerge.targetRef
                || currentMerge.status !== localMerge.status || currentMerge.sourceSha !== localMerge.sourceSha
                || currentMerge.mergedCommitSha !== localMerge.mergedCommitSha) return current;
              finalized = true;
              return { ...current, localMerge: projectedJob.localMerge,
                projectionRecovery: { ...current.projectionRecovery, status: 'projected', updatedAt: new Date().toISOString() },
                updatedAt: new Date().toISOString() };
            });
          },
        });
        projectionCompleted = finalized;
        if (!deliveredDecision.accepted || deliveredDecision.target !== 'projected' || !finalized) projectedMerge = undefined;
        return {};
      }
      if (actionId === 'projection.escalate') {
        if (escalated) await options.eventBus?.publish(eventFor(job.id,'projection',null,'projection.recovery_escalated','failed',
            'Projection recovery exhausted its bounded retry path','user',
            {idempotencyKey:recovery.key,attempts:recovery.attempts},
            {agent:'relay',component:'projection-conflict'})).catch(()=>{});
        return {};
      }
      if (actionId === 'projection.createRecoveryTask') return {};
      throw new Error(`Unexpected projection recovery action ${actionId}`);
    },
  });
  return { state: projectionCompleted ? 'projected' : decision.accepted ? decision.target : '', projectedMerge };
}
