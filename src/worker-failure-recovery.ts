import { isFinalReviewAgent } from './final-review-role.js';
import { hasSafeAlternativeWorker } from './browser-worker-routing.js';
import { codexNoStartFallbackRoute, persistChatGptPlatformFailure } from './chatgpt-platform-fallback.js';
import { classifyChatGptPlatformFailure } from './worker-rejection.js';
import { recordLaunchRouteOutcome } from './route-outcome-recording.js';
import { eventFor } from './events.js';
import type { DurableStore } from './store.js';
import type { WorkerAdapter } from './adapters.js';
import type { AccountUsageOverview } from './usage.js';
import type { DecisionAuditStore } from './decision-audit.js';
import type { EventRecord } from './types.js';
import type { DurableTaskTransitionRuntime } from './workflow/durable-transition.js';

type LiveWorker = {
  executionId: string;
  workerStarted: boolean;
  controller: AbortController;
  execution: { cancel: () => void };
};

/** The Graph owns retry policy. This module observes execution facts,
 * applies the selected durable transition, and cleans only its owned work. */
export type WorkerFailurePorts = {
  store: DurableStore;
  adapters: readonly WorkerAdapter[];
  usageSnapshotProvider?: () => Promise<AccountUsageOverview>;
  decisionAuditStore?: DecisionAuditStore;
  taskTransitions: DurableTaskTransitionRuntime;
  live: (taskId: string) => LiveWorker | undefined;
  launchFailureClaims: Set<string>;
  clearExecution: (taskId: string, executionId: string) => void;
  clearTerminalWaiter: (taskId: string, executionId: string) => void;
  emit: (event: EventRecord) => Promise<void>;
  detach: (promise: Promise<unknown>, jobId: string, taskId: string, context: string) => void;
  wake: (jobId: string, taskId: string, reason: string) => void;
};

export async function handleWorkerLaunchFailure(
  ports: WorkerFailurePorts,
  jobId: string, taskId: string, executionId: string | null, failure: unknown,
  phase: 'launch' | 'delivery' | 'start-ack' | 'process' | 'terminal' = 'launch',
): Promise<void> {
  const message = failure instanceof Error ? failure.message : String(failure);
  const currentJob = await ports.store.load(jobId);
  const currentTask = currentJob.tasks.find(task => task.id === taskId);
  const agents = await ports.store.listAgents();
  const usage = ports.usageSnapshotProvider ? await ports.usageSnapshotProvider() : undefined;
  const alternative = hasSafeAlternativeWorker(currentTask, ports.adapters, agents, usage);
  const activeExecution = ports.live(taskId);
  const noStarted = currentTask?.state === 'QUEUED'
    && currentTask.executionId === executionId
    && !currentTask.lastProgressEventAt
    && !activeExecution?.workerStarted;
  const canRetryNoStart = noStarted
    && (currentTask?.adapter === 'chatgpt' || currentTask?.adapter === 'z')
    && !isFinalReviewAgent(currentTask.agentName)
    && currentTask.agentName !== 'troubleshooter' && currentTask.kind !== 'planner'
    && !currentTask.noStartFallback && currentTask.attempt < currentTask.maxAttempts;
  const codexFallback = canRetryNoStart
    ? await codexNoStartFallbackRoute(currentTask!, ports.adapters, agents, usage)
    : null;
  const noStartFallbackAllowed = Boolean(canRetryNoStart && codexFallback);
  const platformFailure = (currentTask?.adapter === 'chatgpt' || currentTask?.adapter === 'z')
    ? classifyChatGptPlatformFailure(failure,
        phase === 'process' || phase === 'terminal' ? 'delivery' : phase)
    : undefined;
  const unknownOutcome = phase === 'start-ack' || ['outcome_unknown', 'start_ack_timeout'].includes(platformFailure?.classification ?? '')
    || (phase === 'launch' && activeExecution?.executionId === executionId)
    || (phase === 'delivery' && activeExecution?.executionId === executionId && activeExecution.workerStarted);
  const failureReason = phase === 'start-ack' ? 'worker_start_timeout'
    : /WEBHELM_UNAVAILABLE|webhelm runtime dependency unavailable|webhelm session start returned no session_id|no close frame received or sent/i.test(message)
      ? 'browser_workspace_unavailable'
      : undefined;
  const claim = executionId ?? `${jobId}:${taskId}`;
  if (ports.launchFailureClaims.has(claim)) return;
  ports.launchFailureClaims.add(claim);
  const cleanup = setTimeout(() => ports.launchFailureClaims.delete(claim), 60000); cleanup.unref();
  const workflowEvent = noStartFallbackAllowed ? 'worker.no_start_failed'
    : platformFailure ? 'worker.platform_failure'
    : phase === 'start-ack' ? 'worker.start_ack_failed' : 'worker.delivery_failed';
  const transition = await ports.taskTransitions.apply(jobId, taskId, workflowEvent, {
    eligible: (_job, task) => task.executionId === executionId,
    facts: () => ({
      platformFallbackSafe: platformFailure?.safeToReroute === true && alternative,
      noStartFallbackAllowed: noStartFallbackAllowed && !currentTask?.noStartFallback,
    }),
    mutate: (_job, task, decision) => {
      if (platformFailure && workflowEvent !== 'worker.no_start_failed')
        persistChatGptPlatformFailure(task, currentTask, executionId, platformFailure.classification, platformFailure.evidence, platformFailure.safeToReroute);
      if (workflowEvent === 'worker.no_start_failed' && task.noStartFallback)
        task.noStartFallback.reason = message;
      task.error = decision.target === 'QUEUED' ? null : `Worker ${phase} failed: ${message}`;
      task.failureReason = decision.target === 'QUEUED' ? undefined : unknownOutcome
        ? 'worker_outcome_unknown' : platformFailure ? 'worker_platform_failure' : failureReason;
      task.leaseOwner = null;
      task.leaseExpiresAt = null;
      task.executionId = null;
    },
  });
  if (!transition) return;
  if (!transition.decision.accepted) {
    await ports.emit(eventFor(
      jobId,
      taskId,
      transition.task.parentTaskId,
      'task.process.delivery_failed',
      'failed',
      `Worker ${phase} reported after lifecycle moved to ${transition.from}: ${message}`,
      'orchestrator',
      { phase, authoritative: false, executionId, workflowEvent },
      { agent: 'relay', component: 'agents-relay' },
    ));
    return;
  }
  await recordLaunchRouteOutcome(ports.decisionAuditStore, currentTask ?? transition.task, message,
    phase === 'process' || phase === 'terminal' ? 'delivery' : phase, executionId, unknownOutcome);
  if (executionId) {
    const live = ports.live(taskId);
    if (live?.executionId === executionId) {
      live.controller.abort();
      live.execution.cancel();
      ports.clearExecution(taskId, executionId);
    }
    // Browser after-terminal waits must not outlive this failed generation:
    // otherwise they could reject a legitimate terminal event from Codex.
    ports.clearTerminalWaiter(taskId, executionId);
  }
  const event = eventFor(
    jobId,
    taskId,
    transition.task.parentTaskId,
    transition.task.state === 'QUEUED' && workflowEvent === 'worker.no_start_failed'
      ? 'worker.no_start_fallback' : transition.task.state === 'QUEUED' ? 'worker.pre_submission_rejected' : 'task.failed',
    transition.task.state === 'QUEUED' ? 'queued' : 'failed',
    transition.task.error ?? `Worker ${phase} failed: ${message}`,
    'user',
    { phase, reason: transition.task.failureReason ?? failureReason, workflowEvent,
      ...(transition.task.noStartFallback ? { noStartFallback: transition.task.noStartFallback } : {}),
      ...(transition.task.platformFailure ? { platformFailure: transition.task.platformFailure } : {}) },
    { agent: 'relay', component: 'agents-relay', watchdog: true },
  );
  ports.detach(ports.emit(event), jobId, taskId, 'worker failure event');

  ports.wake(jobId, taskId, `worker-${phase}-failure`);
}
