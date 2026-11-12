import { isFinalReviewAgent } from './final-review-role.js';
import type {
  DependencyRevisionVector, DependencyValidity, Job, ReviewRevisionRequest,
  RevisionFinding, Task,
} from './types.js';
import { appendTaskComment } from './task-comments.js';
import { createTaskEntity } from './workflow/entity-creation.js';
import { decideRevisionLifecycle } from './workflow/revision-v2.js';
import type { RelayStore } from './relay-store.js';
import { allocateEntityId } from './job-task-id-sequence.js';
import { relayStoreDirectory } from './relay-store.js';

export type SubmitReviewRevision = {
  requestId: string;
  reviewTaskId: string;
  reviewExecutionId: string;
  headSha: string;
  originalTaskId: string;
  findings: RevisionFinding[];
  allocatedTaskId?: string;
};

/** A stable child identity per immutable review round and responsible owner.
 * The request IDs are append-only feedback attached to this single child.
 */
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
      && isFinalReviewAgent(reviewer?.agentName)
      && reviewer?.state === 'RUNNING'
      && reviewer?.executionId === input.reviewExecutionId,
    reviewHeadCurrent: reviewer?.reviewHeadSha === input.headSha
      && job.headSha === input.headSha
      && (!job.review || (job.review.headSha === input.headSha
        && job.review.taskId === input.reviewTaskId
        && ['pending', 'started'].includes(job.review.outcome))),
    originalTaskSucceeded: owner?.state === 'SUCCEEDED'
      && owner.kind !== 'planner'
      && !isFinalReviewAgent(owner.agentName)
      && owner.id !== reviewer?.id
      && !owner.revision,
  };
  const decision = decideRevisionLifecycle('NONE', 'revision.submit', facts);
  if (!decision.accepted || decision.target !== 'REQUESTED'
    || decision.actions.map(item => item.id).join(',') !== 'revision.recordRequest') {
    throw new Error('revision rejected: reviewer, head, execution or original owner is not current/eligible');
  }
  const now = new Date().toISOString();
  const childId = input.allocatedTaskId;
  if (!childId || !/^[1-9][0-9]*$/.test(childId)) throw new Error('targeted revision requires a Relay-allocated Task ID');
  const request: ReviewRevisionRequest = {
    requestId: input.requestId,
    reviewTaskId: input.reviewTaskId,
    reviewExecutionId: input.reviewExecutionId,
    reviewHeadSha: input.headSha,
    originalTaskId: input.originalTaskId,
    findings: structuredClone(input.findings),
    createdAt: now,
    status: 'requested', revisionTaskId: childId,
    feedbackOrigin: 'final-review',
  };
  job.reviewRevisionRequests = [...(job.reviewRevisionRequests ?? []), request];
  appendTaskComment(job, input.originalTaskId,
    'Final Review ' + input.reviewTaskId + ' requested revision at ' + input.headSha + ':\n'
      + input.findings.map(f => '- ' + f.id + ': ' + f.summary).join('\n'),
    { author: 'reviewer', kind: 'review.feedback', executionId: input.reviewExecutionId,
      transition: 'revision.requested', idempotencyKey: 'review-revision/' + input.requestId });
  // Child creation and finding association are committed together with the
  // request and owner comment: a crash cannot orphan an accepted request.
  const existingChild = job.tasks.find(item => item.id === childId);
  if (existingChild) {
    if (existingChild.revision?.kind !== 'targeted' || existingChild.revision.originalTaskId !== input.originalTaskId
      || existingChild.revision.reviewTaskId !== input.reviewTaskId || existingChild.revision.basedOnHeadSha !== input.headSha
      || existingChild.state !== 'DRAFT') throw new Error('revision child no longer accepts feedback in this immutable review round');
    existingChild.revision.requestIds = [...new Set([...existingChild.revision.requestIds, input.requestId])];
  } else {
    if (!owner || !reviewer) throw new Error('review revision owner/reviewer missing');
    const originalEvidence = owner.result ? JSON.stringify(owner.result) : 'No original result';
    const child = createTaskEntity(job, {
      jobId: job.id, id: childId, kind: 'work', title: 'Revise ' + (owner.title ?? owner.id),
      priority: owner.priority ?? job.priority, storySize: owner.storySize ?? 'M', projectName: owner.projectName,
      agentName: owner.agentName, parentTaskId: owner.id, dependencies: [reviewer.id],
      capabilities: [...owner.capabilities], workerRequirements: owner.workerRequirements,
      adapter: owner.adapter, input: [
        `Revision of original Task ${owner.id} for Job ${job.id}; Final Review ${reviewer.id}, immutable reviewed head ${input.headSha}.`,
        'Retrieve the authoritative Task Context; follow ALL append-only review.feedback comments and associated request IDs. Repair the original result without changing the historical succeeded Task. Review the full current Job objective and repository head, implement and verify the correction, and include root cause, solution, validation and self-review evidence in the durable result.',
        'Original Task input:\n' + owner.input,
        'Original completed evidence:\n' + originalEvidence,
      ].join('\n\n'), output: owner.output ?? { kind: 'task_pr' },
      revision: { kind: 'targeted', originalTaskId: owner.id, requestIds: [input.requestId],
        reviewTaskId: reviewer.id, basedOnHeadSha: input.headSha },
      attempt: 0, maxAttempts: Math.max(3, owner.maxAttempts),
      leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null,
      result: null, error: null, continuation: null, continuationDeliveredAt: null,
      timeoutMs: owner.timeoutMs, createdAt: now, updatedAt: now,
    }, { defer: true });
    job.tasks.push(child);
  }
  appendTaskComment(job, childId,
    'Review feedback request ' + input.requestId + ' for owner ' + input.originalTaskId + ' at ' + input.headSha + ':\n'
      + input.findings.map(f => '- ' + f.id + ': ' + f.summary + (f.evidence ? '\n  Evidence: ' + f.evidence : '')).join('\n'),
    { author: 'reviewer', kind: 'review.feedback', executionId: input.reviewExecutionId,
      transition: 'revision.requested', idempotencyKey: 'review-revision-child/' + input.requestId });
  return { request, created: true };
}

/** Transaction-safe public intake boundary for the later reviewer CLI.
 * No caller can publish a request or its owner comment outside one SQLite
 * authoritative Job mutation. The store is responsible for rollback.
 */
export async function submitTargetedRevisionRequest(
  store: Pick<RelayStore, 'mutateJob'> & Partial<Pick<RelayStore,'loadJob'>> & Partial<Pick<import('./store.js').DurableStore,'load'>>, jobId: string, input: SubmitReviewRevision,
): Promise<{ request: ReviewRevisionRequest; created: boolean }> {
  if (!store.mutateJob) throw new Error('targeted revision requires an authoritative atomic Job store');
  const snapshot=store.loadJob ? await store.loadJob(jobId) : store.load ? await store.load(jobId) : null;
  if(!snapshot)throw new Error(`Job ${jobId} not found`);
  const allocatedTaskId=allocateEntityId(relayStoreDirectory(),snapshot.repository,'task',
    `targeted-revision:${jobId}:${input.reviewTaskId}:${input.originalTaskId}:${input.headSha}`);
  const assigned={...input,allocatedTaskId};
  let created = false;
  const committed = await store.mutateJob(jobId, current => {
    created = recordTargetedRevisionRequest(current, assigned).created;
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
  if (!verdictIssues.length || verdictIssues.some(issue => issue.trim() === '[unparseable blocking finding]')) return false;
  const requests = targetedRequestsForReview(job, reviewTask, headSha);
  if (!requests.length) return false;
  const covered = new Set(requests.flatMap(request => request.findings.flatMap(finding =>
    [finding.id.trim(), finding.summary.trim()])));
  return verdictIssues.every(issue => covered.has(issue.trim()));
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
