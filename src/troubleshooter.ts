import { Job, Task, taskOverallTimeoutMs } from './types.js';

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

Follow the selected Troubleshooter agent contract. Diagnose root cause before retry. If the blocker is a shared worker/runtime/tool defect, create and directly complete a P0/self-job in the owning repository, including required release/deploy verification. Retry this exact original task only after the blocker is removed, reconcile the original job, and verify durable progress.`;
}

function belongsToCurrentRun(job: Job, task: Task): boolean {
  const slot = job.schedule?.currentRunSlot;
  return !slot || task.createdAt >= slot;
}

export function pendingTroubleshooterTasks(job: Job): Task[] {
  const existing = new Set(job.tasks.filter(task => task.agentName === 'troubleshooter').map(task => task.id));
  const recoveries: Task[] = [];
  for (const task of job.tasks) {
    if (!['FAILED', 'BLOCKED'].includes(task.state) || task.kind === 'planner' || task.agentName === 'troubleshooter' || !belongsToCurrentRun(job, task)) continue;
    const id = troubleshooterTaskId(task);
    if (existing.has(id)) continue;
    const now = new Date().toISOString();
    recoveries.push({
      jobId: job.id,
      id,
      kind: 'work',
      priority: 'P0',
      storySize: 'M',
      projectName: job.title,
      agentName: 'troubleshooter',
      parentTaskId: null,
      dependencies: [],
      capabilities: ['troubleshoot', 'recovery'],
      workerRequirements: { capabilities: ['model', 'local_repo', 'iterative_tools'], runtime: 'codex' },
      adapter: 'codex',
      input: failureInput(job, task),
      output: { kind: 'task_pr' },
      continuation: null,
      continuationDeliveredAt: null,
      state: 'QUEUED',
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
    });
  }
  return recoveries;
}
