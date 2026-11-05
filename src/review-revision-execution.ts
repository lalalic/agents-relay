import type { Job, ReviewRevisionRequest, Task } from './types.js';
import type { DurableStore } from './store.js';
import { decideRevisionLifecycle } from './workflow/revision-v2.js';

/** Only Graph-authorized, fully covered review feedback can dispatch a child. */
export function revisionRequestReady(job: Job, task: Task): boolean {
  if (task.revision?.kind !== 'targeted') return true;
  const review = job.review;
  if (!review || review.outcome !== 'changes_required' || review.revisionDisposition !== 'targeted'
    || review.taskId !== task.revision.reviewTaskId) return false;
  const requests = job.reviewRevisionRequests ?? [];
  return task.revision.requestIds.length > 0 && task.revision.requestIds.every(id => {
    const request = requests.find(item => item.requestId === id);
    return request?.revisionTaskId === task.id && request.status === 'queued'
      && request.reviewHeadSha === task.revision?.basedOnHeadSha;
  });
}

function updateStatus(request: ReviewRevisionRequest, next: ReviewRevisionRequest['status']): void {
  request.status = next;
}

/** Reconstruct Graph transitions from durable correlated Task results on restart.
 * Task completion is independently fenced by the canonical Task Graph and its
 * execution generation. Never infer success from a browser submission receipt.
 */
export function reconcileReviewRevisionFacts(job: Job): boolean {
  let changed = false;
  for (const request of job.reviewRevisionRequests ?? []) {
    const task = request.revisionTaskId && job.tasks.find(item => item.id === request.revisionTaskId);
    if (!task || task.revision?.reviewTaskId !== request.reviewTaskId || !task.revision.requestIds.includes(request.requestId)) continue;
    if (request.status === 'requested' && job.review?.outcome === 'changes_required'
      && job.review.taskId === request.reviewTaskId && job.review.revisionDisposition === 'targeted') {
      const decision = decideRevisionLifecycle('REQUESTED', 'revision.queue', { changesRequiredRecorded: true });
      if (decision.accepted && decision.target === 'QUEUED' && decision.actions.some(action => action.id === 'revision.queueTask')) {
        updateStatus(request, 'queued'); changed = true;
      }
    }
    if (request.status === 'queued' && ['RUNNING', 'SUCCEEDED', 'FAILED'].includes(task.state)) {
      const started = decideRevisionLifecycle('QUEUED', 'revision.started');
      if (started.accepted && started.target === 'RUNNING') {
        if (task.state === 'RUNNING') { updateStatus(request, 'running'); changed = true; }
        else {
          const finished = decideRevisionLifecycle('RUNNING', task.state === 'SUCCEEDED' ? 'revision.verified' : 'revision.failed');
          if (finished.accepted && finished.target === (task.state === 'SUCCEEDED' ? 'VERIFIED' : 'FAILED')) {
            updateStatus(request, task.state === 'SUCCEEDED' ? 'verified' : 'failed'); changed = true;
          }
        }
      }
    } else if (request.status === 'running' && (task.state === 'SUCCEEDED' || task.state === 'FAILED')) {
      const finished = decideRevisionLifecycle('RUNNING', task.state === 'SUCCEEDED' ? 'revision.verified' : 'revision.failed');
      if (finished.accepted && finished.target === (task.state === 'SUCCEEDED' ? 'VERIFIED' : 'FAILED')) {
        updateStatus(request, task.state === 'SUCCEEDED' ? 'verified' : 'failed'); changed = true;
      }
    }
  }
  if (changed) job.updatedAt = new Date().toISOString();
  return changed;
}

export async function reconcileReviewRevisions(store: Pick<DurableStore, 'mutateJob'>, jobId: string): Promise<void> {
  if (!store.mutateJob) return;
  await store.mutateJob(jobId, current => {
    reconcileReviewRevisionFacts(current);
    return current;
  });
}
