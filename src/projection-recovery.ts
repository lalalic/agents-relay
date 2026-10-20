import { createTaskEntity } from './workflow/entity-creation.js';
import { dispatchWorkflowGraph } from './workflow/dispatcher.js';
import { projectionConflictV2 } from './workflow/projection-conflict-v2.js';
import type { Job, ProjectionRecovery, Task } from './types.js';
import type { RelayStore } from './relay-store.js';
import { taskOverallTimeoutMs } from './types.js';

const MAX_RECOVERY_ATTEMPTS = 2;

function taskFor(job: Job, remoteSha: string, now: string): Task {
  const key = `${job.id}:${remoteSha}`;
  const id = `projection-recovery-${remoteSha}`;
  return createTaskEntity(job, {
    jobId: job.id, id, title: `Reconcile main divergence for ${job.title}`, kind: 'work',
    priority: job.priority ?? 'P1', storySize: 'M', projectName: job.title,
    agentName: 'implementation', parentTaskId: null, dependencies: [],
    capabilities: ['implementation'], workerRequirements: { capabilities: ['implementation'] },
    adapter: 'codex', input: [
      `Projection recovery key: ${key}`,
      `Observed origin/main SHA: ${remoteSha}`,
      `Job ${job.id} is already COMPLETED; preserve that Job state.`,
      'Inspect local main and origin/main, reconcile their divergence with a normal merge or rebase that preserves both histories, and never force-push.',
      'Do not publish or rewrite refs. Record the resulting local main SHA and verify it contains the completed Job merge and the observed remote main history.',
      'If the histories cannot be reconciled safely, stop and explain the exact blocker.',
    ].join('\n'), output: { kind: 'task_pr' }, continuation: null, continuationDeliveredAt: null,
    attempt: 0, maxAttempts: 2, leaseOwner: null, leaseExpiresAt: null,
    executionId: null, threadId: null, result: null, plannerResult: null, error: null,
    timeoutMs: taskOverallTimeoutMs('M'), createdAt: now, updatedAt: now,
  });
}

/** Select graph policy from SQLite facts, then atomically materialize its selected recovery action. */
export async function beginProjectionRecovery(store: RelayStore, jobId: string, remoteSha: string, error: string): Promise<'created' | 'escalated' | false> {
  if (!store.mutateJob) throw new Error('Projection recovery requires atomic SQLite Job mutation');
  let created = false;
  let escalated = false;
  const snapshot = await store.loadJob(jobId);
  if (!snapshot) return false;
  const sameKey = snapshot.projectionRecovery?.key === `${jobId}:${remoteSha}`;
  const expectedRecoveryKey = snapshot.projectionRecovery?.key ?? null;
  const expectedAttempts = snapshot.projectionRecovery?.attempts ?? 0;
  const expectedRecoveryStatus = snapshot.projectionRecovery?.status ?? null;
  const expectedRecoveryRemoteSha = snapshot.projectionRecovery?.remoteSha ?? null;
  const recoveryInProgress = snapshot.projectionRecovery?.status === 'repairing'
    || (snapshot.projectionRecovery?.status === 'retry' && snapshot.projectionRecovery.remoteSha === remoteSha);
  const decision = await dispatchWorkflowGraph(projectionConflictV2, {
    initialState: 'classify', input: { transport: 'event', id: 'projection.delivery_failed', payload: {} },
    durableFacts: {
      jobState: snapshot.state,
      mergeSucceeded: snapshot.localMerge?.status === 'succeeded',
      projectionStrategy: snapshot.localMerge?.projectionStrategy,
      divergenceConfirmed: /non-fast-forward|fetch first|diverg|not a fast-forward|rejected/i.test(error),
      remoteShaAvailable: /^[0-9a-f]{40,64}$/i.test(remoteSha),
      sameIdempotencyKey: sameKey,
      recoveryInProgress,
      attempts: snapshot.projectionRecovery?.attempts ?? 0,
      maxAttempts: MAX_RECOVERY_ATTEMPTS,
    }, graphName: 'projection-conflict', maxSteps: 1,
    executeAction: async actionId => {
      if (actionId === 'projection.escalate') {
        await store.mutateJob!(jobId, current => {
          if (current.state === 'COMPLETED'
            && (current.projectionRecovery?.key ?? null) === expectedRecoveryKey
            && (current.projectionRecovery?.attempts ?? 0) === expectedAttempts
            && current.projectionRecovery?.status === snapshot.projectionRecovery?.status
            && current.projectionRecovery) {
            current.projectionRecovery = { ...current.projectionRecovery, key: `${jobId}:${remoteSha}`, remoteSha,
              status: 'escalated', error, updatedAt: new Date().toISOString() };
            escalated = true;
          }
          return current;
        });
        return {};
      }
      if (actionId !== 'projection.createRecoveryTask') throw new Error(`Unexpected projection action ${actionId}`);
      const now = new Date().toISOString();
      await store.mutateJob!(jobId, current => {
        if (current.state !== 'COMPLETED' || current.localMerge?.status !== 'succeeded'
          || (current.projectionRecovery?.key ?? null) !== expectedRecoveryKey
          || (current.projectionRecovery?.attempts ?? 0) !== expectedAttempts
          || (current.projectionRecovery?.status ?? null) !== expectedRecoveryStatus
          || (current.projectionRecovery?.remoteSha ?? null) !== expectedRecoveryRemoteSha
          || current.projectionRecovery?.status === 'repairing'
          || current.projectionRecovery?.key === `${jobId}:${remoteSha}`) return current;
        const task = taskFor(current, remoteSha, now);
        if (!current.tasks.some(item => item.id === task.id)) current.tasks.push(task);
        const recovery: ProjectionRecovery = {
          key: `${jobId}:${remoteSha}`, remoteSha, status: 'repairing', taskId: task.id,
          attempts: current.projectionRecovery?.attempts ?? 0,
          maxAttempts: MAX_RECOVERY_ATTEMPTS, error, updatedAt: now,
        };
        current.projectionRecovery = recovery;
        current.updatedAt = now;
        created = true;
        return current;
      });
      return {};
    },
  });
  return decision.accepted ? (created ? 'created' : escalated ? 'escalated' : false) : false;
}
