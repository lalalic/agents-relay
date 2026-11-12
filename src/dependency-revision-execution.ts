import { createTaskEntity } from './workflow/entity-creation.js';
import { tryApplyTaskCancelAction } from './task-actions.js';
import { decideDependencyRevision } from './workflow/dependency-revision-v2.js';
import { dependencyRevisionVector, dependencyValidity, sameDependencyRevisionVector } from './review-revision-model.js';
import { isFinalReviewAgent } from './final-review-role.js';
import type { DurableStore } from './store.js';
import type { DependencyRevisionVector, Job, Task } from './types.js';
import { allocateEntityId } from './job-task-id-sequence.js';
import { relayStoreDirectory } from './relay-store.js';

function latestDirectRevision(job: Job, original: Task): Task | undefined {
  return job.tasks.filter(task => task.revision?.originalTaskId === original.id && task.state === 'SUCCEEDED')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).at(-1);
}

/** Original results have baseline upstream evidence; subsequent descendants
 * carry their checked vector. No external path, Git diff or filename inference. */
function priorVector(job: Job, original: Task): DependencyRevisionVector {
  return latestDirectRevision(job, original)?.revision?.dependencyVector
    ?? Object.fromEntries(original.dependencies.filter(id => dependencyValidity(original,id) !== 'order-only')
      .map(id => {
        const dependency = job.tasks.find(task => task.id === id);
        if (!dependency) throw new Error(`missing original dependency ${id}`);
        return [id, `${id}:${dependency.attempt}`];
      }));
}

/** Last-minute execution and terminal fence: never accept verification of a
 * superseded upstream evidence generation, including after process restart. */
export function dependencyRevisionStillCurrent(job: Job, task: Task): boolean {
  const revision = task.revision;
  if (!revision || (revision.kind !== 'rerun' && revision.kind !== 'revalidate')) return true;
  const original = job.tasks.find(item => item.id === revision.originalTaskId);
  if (!original || !revision.dependencyVector) return false;
  try {
    if (!sameDependencyRevisionVector(dependencyRevisionVector(job, original), revision.dependencyVector)) return false;
    const explicit = original.dependencies.filter(id => dependencyValidity(original, id) !== 'order-only');
    return explicit.every(id => !job.tasks.some(candidate => candidate.id !== task.id
      && candidate.revision?.originalTaskId === id && !['SUCCEEDED','CANCELLED'].includes(candidate.state)));
  } catch { return false; }
}

export function reconcileDependencyRevisionFacts(job: Job, reservedIds: readonly string[] = []): string[] {
  const created: string[] = [];
  const changedStale: string[] = [];
  const originals = job.tasks.filter(task => task.kind !== 'planner' && !isFinalReviewAgent(task.agentName)
    && task.agentName !== 'troubleshooter' && task.state === 'SUCCEEDED' && !task.revision);
  // Stable topological order ensures dependent Tasks wait for intermediate
  // scheduled work and never bypass a changed ancestor at multi-input fan-in.
  const visited = new Set<string>();
  const sorted: Task[] = [];
  const visit = (task: Task): void => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    for (const id of task.dependencies) {
      const dependency = originals.find(candidate => candidate.id === id);
      if (dependency) visit(dependency);
    }
    sorted.push(task);
  };
  originals.forEach(visit);
  let allocatedIndex=0;
  for (const original of sorted) {
    // A queued/DRAFT child whose upstream evidence moved is superseded by the
    // authoritative Task cancellation graph. Running work is settled via the
    // correlated terminal-generation fence in reconciler-runtime.
    for (const stale of job.tasks.filter(task => task.revision?.originalTaskId === original.id
      && (task.revision.kind === 'revalidate' || task.revision.kind === 'rerun')
      && ['DRAFT', 'QUEUED'].includes(task.state) && !dependencyRevisionStillCurrent(job, task))) {
      const decision = decideDependencyRevision('dependency.stale', {}, 'PROPOSED');
      if (decision.accepted && decision.target === 'STALE' && decision.actions.some(action => action.id === 'dependencyRevision.markStale')) {
        tryApplyTaskCancelAction(stale, 'Superseded upstream dependency evidence vector changed before execution');
        changedStale.push(stale.id);
      }
    }
    const policies = original.dependencies.filter(id => dependencyValidity(original, id) !== 'order-only');
    if (!policies.length) continue;
    const inputsSettled = policies.every(id => !job.tasks.some(task => task.revision?.originalTaskId === id
      && !['SUCCEEDED','CANCELLED'].includes(task.state)))
      && !job.tasks.some(task => task.revision?.originalTaskId === original.id && !['SUCCEEDED','CANCELLED'].includes(task.state));
    if (!inputsSettled) continue;
    const vector = dependencyRevisionVector(job, original);
    const previous = priorVector(job, original);
    const changed = !sameDependencyRevisionVector(vector, previous);
    const rerunRequired = policies.some(id => vector[id] !== previous[id] && dependencyValidity(original, id) === 'rerun');
    const duplicate = job.tasks.some(task => task.revision?.originalTaskId === original.id
      && task.revision.kind !== 'targeted' && sameDependencyRevisionVector(task.revision.dependencyVector ?? {}, vector));
    const decision = decideDependencyRevision('dependency.reconcile', {
      upstreamEvidenceChanged: changed, explicitValidityPolicy: policies.length > 0,
      allInputsSettled: inputsSettled, notAlreadyRecorded: !duplicate, rerunRequired,
    });
    if (!decision.accepted || decision.target !== 'PROPOSED') continue;
    // The canonical Dependency Revision Graph owns rerun vs revalidate.
    // Facts supply evidence, but never select the workflow action here.
    const selectedActions = decision.actions.map(action => action.id);
    if (selectedActions.length !== 1 || !['dependencyRevision.createRerun', 'dependencyRevision.createRevalidation'].includes(selectedActions[0])) {
      throw new Error('Dependency Revision Graph did not select exactly one child action');
    }
    const mode = selectedActions[0] === 'dependencyRevision.createRerun' ? 'rerun' : 'revalidate';
    const id=reservedIds[allocatedIndex++];
    if(!id)throw new Error('Dependency Revision reconciliation requires preallocated numeric Task IDs');
    const inputs = policies.map(id => {
      const originalDependency = job.tasks.find(task => task.id === id)!;
      return latestDirectRevision(job, originalDependency) ?? originalDependency;
    });
    const upstreamRequests = inputs.flatMap(task => task.revision?.requestIds ?? []);
    const ancestorReview = inputs.find(task => task.revision)?.revision?.reviewTaskId ?? job.review?.taskId ?? '';
    const current = new Date().toISOString();
    const child = createTaskEntity(job, {
      jobId: job.id, id, title: `${mode === 'rerun' ? 'Rerun' : 'Revalidate'} ${original.title ?? original.id}`,
      kind: 'work', parentTaskId: original.id, agentName: original.agentName,
      priority: original.priority ?? job.priority, storySize: original.storySize ?? 'M', projectName: original.projectName,
      dependencies: [...new Set([original.id, ...inputs.map(task => task.id)])],
      capabilities: [...original.capabilities], workerRequirements: original.workerRequirements,
      adapter: original.adapter, output: original.output ?? { kind: 'task_pr' },
      input: [
        `${mode === 'rerun' ? 'MANDATORY RERUN' : 'EXPLICIT REVALIDATION'} of original Task ${original.id}.`,
        `Semantic dependency evidence vector (all inputs must be validated): ${JSON.stringify(vector)}.`,
        mode === 'rerun' ? 'Re-execute the original deliverable from the current upstream evidence; do not merely sign off the old output.'
          : 'Verify whether the original delivered result remains valid against every new upstream generation. Update code/output if required and report exact verification evidence.',
        'Original durable Task objective: ' + original.input,
        'Original result: ' + JSON.stringify(original.result),
      ].join('\n\n'),
      revision: { kind: mode, originalTaskId: original.id,
        requestIds: [...new Set(upstreamRequests)], reviewTaskId: ancestorReview,
        basedOnHeadSha: job.headSha ?? '', dependencyVector: vector },
      attempt: 0, maxAttempts: Math.max(3, original.maxAttempts),
      leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null,
      result: null, error: null, timeoutMs: original.timeoutMs,
      createdAt: current, updatedAt: current, continuation: null, continuationDeliveredAt: null,
    });
    job.tasks.push(child);
    created.push(id);
  }
  if (created.length || changedStale.length) job.updatedAt = new Date().toISOString();
  return created;
}

export async function reconcileDependencyRevisions(store: Pick<DurableStore, 'mutateJob'|'load'>, jobId: string): Promise<string[]> {
  if (!store.mutateJob) return [];
  const snapshot=await store.load(jobId);
  // Preview the pure reducer against a clone: allocate only IDs for actual new Tasks,
  // not one unused global ID for every historical Task on every reconcile.
  const previewIds=snapshot.tasks.map((_,index)=>`preview-dependency-${index}`);
  const planned=reconcileDependencyRevisionFacts(structuredClone(snapshot),previewIds);
  const reservedIds=planned.map(()=>allocateEntityId(relayStoreDirectory(),snapshot.repository,'task'));
  let created: string[] = [];
  await store.mutateJob(jobId, job => {
    created = reconcileDependencyRevisionFacts(job,reservedIds);
    return job;
  });
  return created;
}
