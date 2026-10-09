import { Job, Task, taskOverallTimeoutMs } from './types.js';
import { dispatchTroubleshooter } from './workflow/troubleshooter-v2.js';
import { createTaskEntity } from './workflow/entity-creation.js';

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'task';
}

export function troubleshooterTaskId(task: Task): string {
  return `troubleshoot-${slug(task.id)}-a${task.attempt}`;
}

function failureInput(job: Job, task: Task): string {
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

Follow the selected Troubleshooter agent contract. Diagnose root cause from durable task state + event history + relevant runtime logs before retry. The final task.error string alone is never sufficient. Classify the evidence as model/provider/runtime, worker/tool/infrastructure, semantic task failure, or timeout/unknown. Only model/provider/runtime evidence may call the narrow model re-decision action; that action gathers fresh usage, reloads current policy, updates this exact Task's routing, and does not retry it. Troubleshooter must then reactivate/retry this exact original task and verify progress. Use the dedicated agents-relay task recover path with --task-id ${task.id} and --recovery-task-id ${troubleshooterTaskId(task)}; never use ordinary task retry from a Troubleshooter because manual retry intentionally supersedes active recovery. Do not manually choose a provider/model or create a replacement task. If the blocker is a shared worker/runtime/tool defect, create and directly complete a P0/self-job in the owning repository, including required release/deploy verification. If diagnosis suggests a genuine human/external blocker, do not publish task.blocked directly and do not implement the result branch procedurally. Call agents-relay escalation with the original intent, blocker, and relevant context. Pass any caller-defined notification plan through --on-needs-user/--on-needs-user-file; do not hard-code a channel. The canonical escalation graph invokes Neo escalation and owns the resolved/failed/needs_user branch; follow its selected outcome. Retry this exact original task only after the blocker is removed, reconcile the original job, and verify durable progress.`;
}

function belongsToCurrentRun(job: Job, task: Task): boolean {
  const slot = job.schedule?.currentRunSlot;
  return !slot || task.createdAt >= slot;
}

const ACTIVE_RECOVERY_STATES = new Set(['DRAFT', 'QUEUED', 'RUNNING', 'BLOCKED']);

function recoveryTargetsTask(recovery: Task, original: Task): boolean {
  if (recovery.agentName !== 'troubleshooter') return false;
  if (recovery.parentTaskId) return recovery.parentTaskId === original.id;
  return recovery.id.startsWith(`troubleshoot-${slug(original.id)}-a`);
}

function hasRecoveryBarrier(job: Job, original: Task): boolean {
  return job.tasks.some(task => recoveryTargetsTask(task, original)
    && (ACTIVE_RECOVERY_STATES.has(task.state) || ['FAILED', 'CANCELLED'].includes(task.state)));
}

export function pendingTroubleshooterTasks(job: Job): Task[] {
  const existing = new Set(job.tasks.filter(task => task.agentName === 'troubleshooter').map(task => task.id));
  const recoveries: Task[] = [];
  for (const task of job.tasks) {
    const id = troubleshooterTaskId(task);
    let create = false;
    const decision = dispatchTroubleshooter({
      failedOrBlocked: ['FAILED','BLOCKED'].includes(task.state),
      ordinaryWork: task.kind !== 'planner' && task.agentName !== 'troubleshooter',
      currentRun: belongsToCurrentRun(job, task),
      needsRecovery: !(task.state === 'BLOCKED' && Boolean(task.unblock)),
      idUnused: !existing.has(id),
      noRecoveryBarrier: !hasRecoveryBarrier(job, task),
    }, () => { create = true; });
    if (!decision.accepted || !create) continue;
    const now = new Date().toISOString();
    recoveries.push(createTaskEntity(job, {
      jobId: job.id,
      id,
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
      maxAttempts: 1,
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
