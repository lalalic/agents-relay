import { Job, Task, taskOverallTimeoutMs } from './types.js';
import { dispatchTroubleshooter } from './workflow/troubleshooter-v2.js';
import { createTaskEntity } from './workflow/entity-creation.js';

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'task';
}

export function troubleshooterTaskId(task: Task): string {
  return `troubleshoot-${slug(task.id)}`;
}

function failureInput(job: Job, task: Task, recoveryId = troubleshooterTaskId(task)): string {
  return `Recover the failed/blocked task below and make it move again if technically safe.

Original repository: ${job.repository}
Original PR: #${job.prNumber}
Original job: ${job.id}
Original task: ${task.id}
Original task URL: ${task.taskUrl ?? 'unknown'}
Original state: ${task.state}
Original attempt: ${task.attempt}
Original worker: ${task.workerSelection?.workerId ?? task.adapter}
Original routing: ${task.routing ? JSON.stringify(task.routing) : 'unrouted'}
Failure reason: ${task.failureReason ?? task.error ?? 'unknown'}

MANDATORY EVENT EVIDENCE BEFORE DIAGNOSIS:
Retrieve this task's lifecycle event history before classifying the root cause or retrying:
GET http://127.0.0.1:8787/api/events?job=${encodeURIComponent(job.id)}&task=${encodeURIComponent(task.id)}&limit=200
Inspect event order, type/status, source, data/phase, duplicate events, missing expected lifecycle events, late events, and execution identifiers. If the event stream points to delivery/runtime failure, inspect the corresponding Relay/worker/tool logs too. Do not treat the final task.error string as the complete root cause.

Follow the selected Troubleshooter agent contract. Diagnose root cause from durable task state, append-only comments, task-scoped event history, and relevant runtime logs before retry. The final task.error string alone is never sufficient. Independently verify every human response against evidence from the exact original failing execution context; a response or historical resolution condition alone never proves recovery. Classify evidence as model/provider/runtime, worker/tool/infrastructure, semantic task failure, or timeout/unknown. Select one graph-enabled resolution path: exact_original_retry, same_job_dependency, blocker_job_dependency, escalation_gate, or cancel_supersede. For confirmed adapter/model/provider failure, include --failure-kind, --reason, --evidence and --reroute in task recover; use --exclude-current-route only if the exact failed route should not be selected again. For semantic task failure use --failure-kind task_failure without rerouting. For uncertain failures use --failure-kind unknown and preserve routing unless evidence justifies rerouting. Request the existing agents-relay task recover or agents-relay escalation operation; submission alone is not recovery. Reload authoritative SQLite state and verify the requested resolution and exact-original retry postconditions before reporting success. Bound self-healing retries to the durable Task retry budget. For a shared worker/runtime/tool defect, use its owning repository's P0/self-job workflow and verify the durable fix before requesting recovery. Never use ordinary task retry from a Troubleshooter because manual retry intentionally supersedes active recovery. Do not manually choose a provider/model or create a replacement task. If diagnosis suggests a genuine human/external blocker, invoke the escalation command; do not publish task.blocked or implement a workflow branch procedurally. The canonical escalation graph invokes Neo escalation and owns the resolved/failed/needs_user branch; Relay applies the selected outcome. Retry this exact original task only after the blocker is removed, reconcile the original job, and verify durable progress.`;
}

function belongsToCurrentRun(job: Job, task: Task): boolean {
  const slot = job.schedule?.currentRunSlot;
  return !slot || task.createdAt >= slot;
}

const ACTIVE_RECOVERY_STATES = new Set(['DRAFT', 'QUEUED', 'RUNNING', 'BLOCKED']);

function recoveryTargetsTask(recovery: Task, original: Task): boolean {
  if (recovery.agentName !== 'troubleshooter') return false;
  if (recovery.parentTaskId) return recovery.parentTaskId === original.id;
  return recovery.id === troubleshooterTaskId(original) || recovery.id.startsWith(`troubleshoot-${slug(original.id)}-a`);
}

function hasRecoveryBarrier(job: Job, original: Task): boolean {
  // Exactly one durable recovery identity per original Task, across all failures.
  return job.tasks.some(task => recoveryTargetsTask(task, original));
}

function recoveryEpisode(recovery: Task): number {
  return recovery.recoveryForAttempt ?? Number(/-a(\d+)$/.exec(recovery.id)?.[1] ?? -1);
}

/** Reuse the existing recovery rather than creating one child per worker retry. */
export function pendingTroubleshooterReopens(job: Job): Array<{ original: Task; recovery: Task }> {
  const pending: Array<{ original: Task; recovery: Task }> = [];
  for (const original of job.tasks) {
    if (original.kind === 'planner' || original.agentName === 'troubleshooter' || original.state !== 'FAILED') continue;
    if (!belongsToCurrentRun(job, original)) continue;
    const recoveries = job.tasks.filter(candidate => recoveryTargetsTask(candidate, original));
    if (!recoveries.length || recoveries.some(candidate => ACTIVE_RECOVERY_STATES.has(candidate.state))) continue;
    const recovery = recoveries.sort((a,b) => recoveryEpisode(b) - recoveryEpisode(a))[0];
    if (!['SUCCEEDED', 'CANCELLED'].includes(recovery.state) || recoveryEpisode(recovery) >= original.attempt) continue;
    pending.push({ original, recovery });
  }
  return pending;
}

export function refreshTroubleshooterInput(job: Job, original: Task, recovery: Task): void {
  recovery.input = failureInput(job, original, recovery.id);
  recovery.recoveryForAttempt = original.attempt;
  recovery.maxAttempts = Math.max(recovery.maxAttempts, recovery.attempt + 3);
  recovery.routing = undefined;
  recovery.workerSelection = undefined;
}

export function pendingTroubleshooterTasks(job: Job): Task[] {
  const existing = new Set(job.tasks.filter(task => task.agentName === 'troubleshooter').map(task => task.id));
  const recoveries: Task[] = [];
  for (const task of job.tasks) {
    const id = troubleshooterTaskId(task);
    let create = false;
    const decision = dispatchTroubleshooter({
      failedWork: task.state === 'FAILED',
      ordinaryWork: task.kind !== 'planner' && task.agentName !== 'troubleshooter',
      currentRun: belongsToCurrentRun(job, task),
      needsRecovery: !(task.state === 'BLOCKED' && (Boolean(task.unblock) || Boolean(task.interactiveInvocation))),
      idUnused: !existing.has(id),
      noRecoveryBarrier: !hasRecoveryBarrier(job, task),
    }, () => { create = true; });
    if (!decision.accepted || !create) continue;
    const now = new Date().toISOString();
    recoveries.push(createTaskEntity(job, {
      jobId: job.id,
      id,
      title: `Recover task ${task.id}`,
      recoveryForAttempt: task.attempt,
      kind: 'work',
      priority: 'P0',
      storySize: 'M',
      projectName: job.title,
      agentName: 'troubleshooter',
      parentTaskId: task.id,
      dependencies: [],
      capabilities: ['troubleshoot', 'recovery'],
      workerRequirements: { capabilities: ['model', 'local_repo', 'iterative_tools'], runtime: 'codex' },
      adapter: 'codex',
      input: failureInput(job, task),
      output: { kind: 'task_pr' },
      continuation: null,
      continuationDeliveredAt: null,
      attempt: 0,
      maxAttempts: 3,
      leaseOwner: null,
      leaseExpiresAt: null,
      executionId: null,
      threadId: null,
      result: null,
      plannerResult: null,
      error: null,
      timeoutMs: taskOverallTimeoutMs('M'),
      createdAt: now,
      updatedAt: now,
    }));
  }
  return recoveries;
}


export function exhaustedTroubleshooterRecoveries(job: Job): Array<{ original: Task; recovery: Task; reason: string }> {
  const results: Array<{ original: Task; recovery: Task; reason: string }> = [];
  for (const recovery of job.tasks) {
    if (recovery.agentName !== 'troubleshooter' || recovery.state !== 'FAILED' || recovery.attempt < recovery.maxAttempts || !recovery.parentTaskId) continue;
    const original = job.tasks.find(task => task.id === recovery.parentTaskId);
    if (!original || !['FAILED','BLOCKED'].includes(original.state)) continue;
    const alreadyRecorded = job.recoveryFailures?.some(item => item.taskId === original.id && item.recoveryTaskId === recovery.id);
    if (alreadyRecorded) continue;
    results.push({
      original,
      recovery,
      reason: recovery.error ?? recovery.failureReason ?? `Troubleshooter ${recovery.id} ${recovery.state.toLowerCase()}`,
    });
  }
  return results;
}
