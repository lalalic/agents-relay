import { outcomeForDecision, type DecisionAuditStore, type DecisionOutcomeRecord } from './decision-audit.js';
import type { EventRecord, Task } from './types.js';
export type { DecisionAuditStore } from './decision-audit.js';

/** Preserve the source classification except when the failure text gives clear evidence. */
export function classifyRoutingFailure(message: string, fallback: DecisionOutcomeRecord['kind']): DecisionOutcomeRecord['kind'] {
  if (/invalid (?:api|public) key|(?:authentication|authorization) failed|401 unauthorized/i.test(message)) return 'auth_config_failure';
  if (/stream disconnected|response\.completed|rate[_ .-]?limit(?:[_ .-]?exceeded)?|quota exceeded|provider[_ .-]?unavailable|model[_ .-]?(?:unavailable|not[_ .-]?found)|service unavailable/i.test(message)) return 'provider_failure';
  if (/timeout|timed out|deadline exceeded/i.test(message)) return 'timeout';
  return fallback;
}

/** One best-effort audit effect after an authoritative Graph/SQLite transition. */
export async function recordRouteOutcome(
  store: DecisionAuditStore | undefined,
  task: Task,
  kind: DecisionOutcomeRecord['kind'],
  reason: string,
  evidence: Record<string, unknown> = {},
): Promise<void> {
  if (!store || !task.routing?.decisionId) return;
  try {
    await store.append(outcomeForDecision(task.routing.decisionId, kind, reason, {
      job_id: task.jobId, task_id: task.id, attempt: task.attempt,
      route: {
        worker: task.workerSelection?.workerId ?? task.adapter,
        adapter: task.adapter,
        provider: task.routing.provider,
        model: task.routing.model,
        profile: task.routing.profile ?? null,
        reasoning: task.routing.reasoning ?? null,
      },
      ...evidence,
    }));
  } catch (error) {
    // A failed audit append must not undo an already committed SQLite transition.
    process.stderr.write('[agents-relay] route outcome audit unavailable: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  }
}


/** Accepted terminal Worker event; reviewer/human gates remain distinct outcomes. */
export async function recordTerminalRouteOutcome(
  store: DecisionAuditStore | undefined, task: Task, event: EventRecord, executionId: string | null,
): Promise<void> {
  const kind: DecisionOutcomeRecord['kind'] = event.type === 'task.completed' ? 'success'
    : event.type === 'task.cancelled' ? 'cancelled' : event.type === 'task.blocked' ? 'blocked'
      : classifyRoutingFailure([event.message, event.data?.reason].join(' '), 'task_failure');
  const reason = event.type === 'task.completed' ? 'task.completed'
    : [typeof event.data?.reason === 'string' ? event.data.reason : null, event.message].filter(Boolean).join(': ') || event.type;
  await recordRouteOutcome(store, task, kind, reason, { execution_id: executionId, event_type: event.type });
}

/** Launcher Graph accepted a failure or safe pre-submission fallback. */
export async function recordLaunchRouteOutcome(
  store: DecisionAuditStore | undefined, task: Task, message: string,
  phase: 'launch' | 'delivery' | 'start-ack', executionId: string | null, unknownOutcome: boolean,
): Promise<void> {
  await recordRouteOutcome(store, task,
    unknownOutcome ? 'outcome_unknown' : classifyRoutingFailure(message, phase === 'launch' ? 'launch_failure' : 'runtime_failure'),
    'worker_' + phase + '_failure: ' + message,
    { phase, execution_id: executionId, target_state: task.state, outcome_unknown: unknownOutcome });
}

/** Watchdog Graph applies its durable state before emitting a non-authoritative event. */
export async function recordWatchdogRouteOutcome(
  store: DecisionAuditStore | undefined, task: Task, evidence: {
    executionId: string; failedExit: boolean; rawError: string; failureReason: string | undefined;
    failureMessage: string; exitCode: number | null;
  },
): Promise<void> {
  await recordRouteOutcome(store, task,
    evidence.failedExit ? classifyRoutingFailure(evidence.rawError, 'runtime_failure') : 'timeout',
    (evidence.failureReason ?? 'watchdog_failed') + ': ' + evidence.failureMessage,
    { execution_id: evidence.executionId, watchdog: true, exit_code: evidence.exitCode });
}
