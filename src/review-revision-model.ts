import type {
  DependencyRevisionVector, DependencyValidity, Job, ReviewRevisionRequest,
  RevisionFinding, Task,
} from './types.js';
import { appendTaskComment } from './task-comments.js';
import { decideRevisionLifecycle } from './workflow/revision-v2.js';
import type { RelayStore } from './relay-store.js';

export type SubmitReviewRevision = {
  requestId: string;
  reviewTaskId: string;
  reviewExecutionId: string;
  headSha: string;
  originalTaskId: string;
  findings: RevisionFinding[];
};

/** A request and its source Task comment are one atomic SQLite Job snapshot mutation.
 * The caller MUST execute this reducer inside RelayStore.mutateJob. It is never
 * an out-of-band Task write and never reopens the original result.
 */
export function recordTargetedRevisionRequest(job: Job, input: SubmitReviewRevision): { request: ReviewRevisionRequest; created: boolean } {
  if (!input.requestId?.trim() || input.requestId.length > 160) throw new Error('revision request requires stable request ID (max 160)');
  if (!input.headSha?.trim() || !input.reviewExecutionId?.trim()) throw new Error('revision requires exact reviewer execution and immutable head');
  if (!input.findings?.length || input.findings.some(item =>
    !item.id?.trim() || !item.summary?.trim() || item.summary.length > 4000
  )) throw new Error('revision requires identified, nonempty findings');
  if (new Set(input.findings.map(item => item.id)).size !== input.findings.length) throw new Error('duplicate finding IDs in revision request');
  const existing = job.reviewRevisionRequests?.find(item => item.requestId === input.requestId);
  if (existing) {
    const same = existing.reviewTaskId === input.reviewTaskId
      && existing.reviewExecutionId === input.reviewExecutionId
      && existing.reviewHeadSha === input.headSha
      && existing.originalTaskId === input.originalTaskId
      && JSON.stringify(existing.findings) === JSON.stringify(input.findings);
    if (!same) throw new Error('revision request ID reused with different immutable feedback');
    return { request: existing, created: false };
  }
  const reviewer = job.tasks.find(item => item.id === input.reviewTaskId);
  const owner = job.tasks.find(item => item.id === input.originalTaskId);
  const facts = {
    reviewerAuthorized: job.state === 'ACTIVE'
      && reviewer?.agentName === 'reviewer'
      && reviewer.state === 'RUNNING'
      && reviewer.executionId === input.reviewExecutionId,
    reviewHeadCurrent: reviewer?.reviewHeadSha === input.headSha
      && job.headSha === input.headSha
      && (!job.review || (job.review.headSha === input.headSha
        && job.review.taskId === input.reviewTaskId
        && ['pending', 'started'].includes(job.review.outcome))),
    originalTaskSucceeded: owner?.state === 'SUCCEEDED'
      && owner.kind !== 'planner'
      && owner.agentName !== 'reviewer'
      && owner.id !== reviewer?.id
      && !owner.revision,
  };
  const decision = decideRevisionLifecycle('NONE', 'revision.submit', facts);
  if (!decision.accepted || decision.target !== 'REQUESTED'
    || decision.actions.map(item => item.id).join(',') !== 'revision.recordRequest') {
    throw new Error('revision rejected: reviewer, head, execution or original owner is not current/eligible');
  }
  const now = new Date().toISOString();
  const request: ReviewRevisionRequest = {
    requestId: input.requestId,
    reviewTaskId: input.reviewTaskId,
    reviewExecutionId: input.reviewExecutionId,
    reviewHeadSha: input.headSha,
    originalTaskId: input.originalTaskId,
    findings: structuredClone(input.findings),
    createdAt: now,
    status: 'requested',
    feedbackOrigin: 'final-review',
  };
  job.reviewRevisionRequests = [...(job.reviewRevisionRequests ?? []), request];
  appendTaskComment(job, input.originalTaskId,
    'Final Review ' + input.reviewTaskId + ' requested revision at ' + input.headSha + ':\n'
      + input.findings.map(f => '- ' + f.id + ': ' + f.summary).join('\n'),
    { author: 'reviewer', kind: 'review.feedback', executionId: input.reviewExecutionId,
      transition: 'revision.requested', idempotencyKey: 'review-revision/' + input.requestId });
  return { request, created: true };
}

/** Transaction-safe public intake boundary for the later reviewer CLI.
 * No caller can publish a request or its owner comment outside one SQLite
 * authoritative Job mutation. The store is responsible for rollback.
 */
export async function submitTargetedRevisionRequest(
  store: Pick<RelayStore, 'mutateJob'>, jobId: string, input: SubmitReviewRevision,
): Promise<{ request: ReviewRevisionRequest; created: boolean }> {
  if (!store.mutateJob) throw new Error('targeted revision requires an authoritative atomic Job store');
  let created = false;
  const committed = await store.mutateJob(jobId, current => {
    created = recordTargetedRevisionRequest(current, input).created;
    return current;
  });
  const request = committed.reviewRevisionRequests?.find(item => item.requestId === input.requestId);
  if (!request) throw new Error('targeted revision mutation did not persist the request');
  return { request, created };
}

/** Only exact current-generation targeted requests count for the Review Graph.
 * The record is not a worker success and does not itself authorize dispatch.
 */
export function targetedRequestsForReview(job: Job, reviewTask: Task, headSha: string): ReviewRevisionRequest[] {
  return (job.reviewRevisionRequests ?? []).filter(request =>
    request.reviewTaskId === reviewTask.id
    && request.reviewExecutionId === reviewTask.executionId
    && request.reviewHeadSha === headSha
    && request.status !== 'stale'
    && job.tasks.some(task => task.id === request.originalTaskId && task.state === 'SUCCEEDED'));
}

/** Full finding coverage is a fact supplied to the Review Graph, not a
 * second procedural review policy. Unknown findings fail closed to ownership
 * resolution rather than silently disappearing behind a partial request.
 */
export function targetedRequestsCoverReview(job: Job, reviewTask: Task, headSha: string, verdictIssues: readonly string[]): boolean {
  const requests = targetedRequestsForReview(job, reviewTask, headSha);
  if (!requests.length) return false;
  const covered = new Set(requests.flatMap(request => request.findings.flatMap(finding =>
    [finding.id.trim(), finding.summary.trim()])));
  return verdictIssues.every(issue => issue.trim() !== '[unparseable blocking finding]' && covered.has(issue.trim()));
}

export function dependencyValidity(task: Task, dependencyTaskId: string): DependencyValidity {
  if (!task.dependencies.includes(dependencyTaskId)) throw new Error('dependency is not declared on Task');
  const mode = task.dependencyValidity?.[dependencyTaskId] ?? 'order-only';
  if (mode !== 'order-only' && mode !== 'revalidate' && mode !== 'rerun') throw new Error('invalid dependency validity policy');
  return mode;
}

/** Deterministic semantic evidence vector; never infer validity from filenames.
 * Historical successful owners remain immutable. The latest successful child
 * is new evidence; pending/failed children must be gated by the future scheduler.
 */
export function dependencyRevisionVector(job: Job, task: Task): DependencyRevisionVector {
  const vector: DependencyRevisionVector = {};
  for (const dependencyId of [...new Set(task.dependencies)].sort()) {
    if (dependencyValidity(task, dependencyId) === 'order-only') continue;
    const original = job.tasks.find(item => item.id === dependencyId);
    if (!original) throw new Error('dependency Task not found: ' + dependencyId);
    // Task-array order is not provenance: inbound snapshots and restarts may
    // reorder historical children. Creation time plus ID gives stable ordering.
    const latest = job.tasks.filter(item =>
      item.revision?.originalTaskId === dependencyId && item.state === 'SUCCEEDED'
    ).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).at(-1);
    const selected = latest ?? original;
    if (selected.state !== 'SUCCEEDED') throw new Error('dependency has no successful evidence: ' + dependencyId);
    // The successful Task ID and attempt identify the generation. Revision
    // children are distinct and never rewrite a successful parent.
    vector[dependencyId] = selected.id + ':' + selected.attempt;
  }
  return vector;
}

export function sameDependencyRevisionVector(a: DependencyRevisionVector, b: DependencyRevisionVector): boolean {
  const keysA = Object.keys(a).sort(), keysB = Object.keys(b).sort();
  return keysA.length === keysB.length
    && keysA.every((key, index) => key === keysB[index] && a[key] === b[key]);
}
