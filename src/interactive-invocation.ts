import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GraphRuntime } from './workflow/graph-v2.js';
import { dispatchWorkflowGraph } from './workflow/dispatcher.js';
import type { EventRecord, Job, Result, Task } from './types.js';
import type { DurableStore } from './store.js';

export type InteractiveDecision = 'approved' | 'changes_requested';
export type InteractiveInvocationStatus = 'awaiting_decision' | 'changes_requested' | 'approved';
export type InteractiveInvocation = {
  invocationId: string;
  revision: string;
  executionId: string;
  status: InteractiveInvocationStatus;
  boundAt: string;
  decidedAt?: string;
  feedback?: string;
};
export type InteractiveDecisionDelivery = {
  jobId: string;
  taskId: string;
  executionId: string;
  invocationId: string;
  revision: string;
  decision: InteractiveDecision;
  feedback?: string;
  eventId: string;
  deliveredAt: string;
};
export type InteractiveDecisionOutcome = 'accepted' | 'duplicate' | 'stale' | 'ignored';
export type InteractiveDecisionResult = {
  outcome: InteractiveDecisionOutcome;
  reason: string;
  invocation?: InteractiveInvocation;
  decision?: InteractiveDecisionDelivery;
  resumeWorker?: boolean;
};
export type AcceptedInteractiveDecision = {
  jobId: string;
  taskId: string;
  executionId: string;
  invocationId: string;
  revision: string;
  decision: InteractiveDecision;
  feedback?: string;
  event: EventRecord;
};
export type HostInvocationCoordinatorOptions = {
  store: {
    loadJob(jobId: string): Promise<Job | null>;
    markEventProcessed?(eventId: string, stream?: string | null, sequence?: number | null): Promise<boolean>;
    mutateJob?(jobId: string, mutation: (current: Job) => Job): Promise<Job>;
    recordHostInvocationEvent?(delivery: InteractiveDecisionDelivery, outcome: InteractiveDecisionOutcome, fingerprint: string): Promise<void>;
    hasHostInvocationDecision?(jobId: string, taskId: string, invocationId: string, fingerprint?: string): Promise<boolean>;
    recordHostInvocationDecision?(delivery: InteractiveDecisionDelivery, fingerprint: string): Promise<{ outcome: InteractiveDecisionOutcome; reason: string; invocation?: InteractiveInvocation }>;
  };
  emit?: (event: EventRecord) => void | Promise<void>;
  onAccepted?: (decision: AcceptedInteractiveDecision) => Promise<Result | void> | Result | void;
  now?: () => Date;
};

const graphSource = readFileSync(new URL('../workflow/interactive-invocation.mmd', import.meta.url), 'utf8');
export const interactiveInvocationGraph = new GraphRuntime(graphSource, {
  states: new Set<InteractiveInvocationStatus>(['awaiting_decision', 'changes_requested', 'approved']),
  guards: {
    currentInvocation: facts => facts.durableFacts.currentInvocation === true,
    awaitingDecision: facts => facts.durableFacts.awaitingDecision === true,
    currentRevision: facts => facts.durableFacts.currentRevision === true,
    duplicateDelivery: facts => facts.durableFacts.duplicateDelivery === true,
    changesRequested: facts => facts.durableFacts.changesRequested === true,
  },
  actions: {
    'interactive.recordDecision': { id: 'interactive.recordDecision' },
    'interactive.requestChanges': { id: 'interactive.requestChanges' },
    'interactive.approve': { id: 'interactive.approve' },
    'interactive.wakeWorker': { id: 'interactive.wakeWorker' },
  },
  events: { 'task.interactive_decision': { id: 'task.interactive_decision' }, 'task.interactive_recover': { id: 'task.interactive_recover' } },
});

/** Host-side adapter: a generic UI only supplies review facts; Relay attaches task identity. */
export type GenericInteractiveFeedback = {
  eventId: string;
  invocationId: string;
  revision: string;
  decision: InteractiveDecision;
  feedback?: string;
};
export type HostInteractiveContext = { jobId: string; taskId: string; executionId: string };
export function hostInteractiveDecisionEvent(
  context: HostInteractiveContext,
  feedback: GenericInteractiveFeedback,
  receivedAt = new Date().toISOString(),
): EventRecord {
  if (!feedback.eventId || !feedback.invocationId || !feedback.revision ||
      !['approved', 'changes_requested'].includes(feedback.decision)) {
    throw new Error('Incomplete generic interactive decision');
  }
  return {
    version: 1, event_id: feedback.eventId, job_id: context.jobId,
    task_id: context.taskId, parent_task_id: null, type: 'task.interactive_decision',
    status: 'running', timestamp: receivedAt, visibility: 'orchestrator', level: 'info',
    message: `Host interactive decision received for revision ${feedback.revision}`,
    source: { id: `job/${context.jobId}/task/${context.taskId}/execution/${context.executionId}`, component: 'agents-relay' },
    data: { interactive: { ...context, ...feedback, eventId: undefined } },
  };
}

export function normalizeInteractiveDecision(event: EventRecord): InteractiveDecisionDelivery | null {
  if (event.type !== 'task.interactive_decision') return null;
  const payload = event.data?.interactive;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  const string = (key: string): string | null => typeof value[key] === 'string' && value[key].length > 0 ? value[key] as string : null;
  const jobId = string('jobId');
  const taskId = string('taskId');
  const executionId = string('executionId');
  const invocationId = string('invocationId');
  const revision = string('revision');
  const decision = value.decision === 'approved' || value.decision === 'changes_requested' ? value.decision : null;
  if (!jobId || !taskId || !executionId || !invocationId || !revision || !decision) return null;
  const feedback = string('feedback');
  return {
    jobId, taskId, executionId, invocationId, revision, decision,
    feedback: feedback ?? undefined,
    eventId: event.event_id,
    deliveredAt: event.timestamp,
  };
}

export function interactiveDecisionFingerprint(decision: InteractiveDecisionDelivery): string {
  return createHash('sha256').update(JSON.stringify({
    jobId: decision.jobId,
    taskId: decision.taskId,
    executionId: decision.executionId,
    invocationId: decision.invocationId,
    revision: decision.revision,
    decision: decision.decision,
    feedback: decision.feedback ?? null,
  })).digest('hex');
}

function invocationState(invocation: InteractiveInvocation | undefined): InteractiveInvocationStatus {
  return invocation?.status ?? 'awaiting_decision';
}

async function decideInteractiveInvocation(
  task: Task,
  delivery: InteractiveDecisionDelivery,
  duplicateDelivery: boolean,
): Promise<{ accepted: boolean; actions: readonly string[] }> {
  const invocation = task.interactiveInvocation;
  const result = await dispatchWorkflowGraph(interactiveInvocationGraph, {
    initialState: invocationState(invocation),
    input: { transport: 'event', id: 'task.interactive_decision', payload: {} },
    durableFacts: {
      currentInvocation: invocation?.invocationId === delivery.invocationId,
      awaitingDecision: invocation?.status === 'awaiting_decision',
      currentRevision: invocation?.revision === delivery.revision,
      duplicateDelivery,
      changesRequested: delivery.decision === 'changes_requested',
    },
    graphName: 'interactive-invocation',
    observe: false,
    executeAction: () => ({}),
  });
  return {
    accepted: result.accepted,
    actions: result.accepted ? result.actions.map((action: { id: string }) => action.id) : [],
  };
}

/** Explicitly bind prototype-backed Store operations; object spread discards them. */
export function hostInvocationPorts(store: DurableStore): HostInvocationCoordinatorOptions['store'] {
  return {
    loadJob: jobId => store.load(jobId),
    mutateJob: (jobId, mutation) => {
      if (!store.mutateJob) throw new Error('Store does not support atomic job mutation');
      return store.mutateJob(jobId, mutation);
    },
    recordHostInvocationEvent: (delivery, outcome, fingerprint) => {
      if (!store.recordHostInvocationEvent) throw new Error('Store does not support invocation events');
      return store.recordHostInvocationEvent(delivery, outcome, fingerprint);
    },
    hasHostInvocationDecision: (jobId, taskId, invocationId, fingerprint) =>
      store.hasHostInvocationDecision?.(jobId, taskId, invocationId, fingerprint) ?? Promise.resolve(false),
    recordHostInvocationDecision: (delivery, fingerprint) => {
      if (!store.recordHostInvocationDecision) throw new Error('Store does not support invocation decisions');
      return store.recordHostInvocationDecision(delivery, fingerprint);
    },
  };
}

export class HostInteractiveInvocationCoordinator {
  private readonly waiters = new Map<string, (decision: AcceptedInteractiveDecision) => void>();

  constructor(private readonly options: HostInvocationCoordinatorOptions) {}

  async bind(jobId: string, task: Task, executionId: string, invocationId: string, revision: string): Promise<{ decision: Promise<AcceptedInteractiveDecision> }> {
    if (task.state !== 'RUNNING') throw new Error(`Task ${task.id} must be RUNNING to bind an interactive invocation`);
    if (task.executionId !== executionId) throw new Error(`Task ${task.id} does not own execution ${executionId}`);
    const now = (this.options.now ?? (() => new Date()))().toISOString();
    const invocation: InteractiveInvocation = { invocationId, revision, executionId, status: 'awaiting_decision', boundAt: now };
    const boundJobId = task.jobId ?? jobId;
    if (!boundJobId) throw new Error(`Task ${task.id} cannot bind an interactive invocation without a Job ID`);
    if (!this.options.store.mutateJob) throw new Error('Store does not support atomic invocation binding');
    await this.options.store.mutateJob(boundJobId, current => {
      const next = structuredClone(current);
      const nextTask = next.tasks.find((item: Task) => item.id === task.id);
      if (!nextTask || nextTask.executionId !== executionId || nextTask.state !== 'RUNNING') return current;
      if (nextTask.interactiveInvocation?.invocationId === invocationId) {
        if (nextTask.interactiveInvocation.revision !== revision) throw new Error('Invocation identity cannot change revision');
        return current;
      }
      nextTask.interactiveInvocation = invocation;
      return next;
    });
    const key = `${boundJobId}:${task.id}:${executionId}:${invocationId}`;
    const decision = new Promise<AcceptedInteractiveDecision>((resolve, reject) => {
      this.waiters.set(key, resolve);
      const timer = setTimeout(() => {
        if (this.waiters.get(key) !== resolve) return;
        this.waiters.delete(key);
        reject(new Error(`Interactive decision timeout for task ${task.id}, revision ${revision}`));
      }, 60_000);
      timer.unref();
    });
    return { decision };
  }

  async applyEvent(event: EventRecord): Promise<InteractiveDecisionResult> {
    const delivery = normalizeInteractiveDecision(event);
    if (!delivery || delivery.jobId !== event.job_id || delivery.taskId !== event.task_id) {
      return { outcome: 'ignored', reason: 'invalid_interactive_delivery' };
    }
    const job = await this.options.store.loadJob(delivery.jobId);
    const task = job?.tasks.find((item: Task) => item.id === delivery.taskId);
    if (!job || !task || task.interactiveInvocation?.executionId !== delivery.executionId ||
        (task.executionId !== delivery.executionId && task.state !== 'BLOCKED')) {
      await this.options.store.recordHostInvocationEvent?.(delivery, 'stale', interactiveDecisionFingerprint(delivery));
      return { outcome: 'stale', reason: 'execution_not_bound' };
    }
    const duplicate = await this.options.store.hasHostInvocationDecision?.(delivery.jobId, delivery.taskId, delivery.invocationId, interactiveDecisionFingerprint(delivery)) ?? false;
    const graphDecision = await decideInteractiveInvocation(task, delivery, duplicate);
    const selected = graphDecision.actions.some(action => action === 'interactive.requestChanges' || action === 'interactive.approve');
    if (!graphDecision.accepted || !selected || duplicate) {
      const outcome: InteractiveDecisionOutcome = duplicate ? 'duplicate' : 'stale';
      await this.options.store.recordHostInvocationEvent?.(delivery, outcome, interactiveDecisionFingerprint(delivery));
      return { outcome, reason: `${outcome}_interactive_decision`, decision: delivery, resumeWorker: duplicate && graphDecision.actions.includes('interactive.wakeWorker') };
    }
    const recorded = await this.options.store.recordHostInvocationDecision?.(delivery, interactiveDecisionFingerprint(delivery));
    if (!recorded) throw new Error('Interactive invocation store does not support durable decisions');
    if (recorded.outcome !== 'accepted') return { outcome: recorded.outcome, reason: recorded.reason };
    const accepted: AcceptedInteractiveDecision = {
      jobId: delivery.jobId, taskId: delivery.taskId, executionId: delivery.executionId,
      invocationId: delivery.invocationId, revision: delivery.revision, decision: delivery.decision,
      feedback: delivery.feedback, event,
    };
    const key = `${accepted.jobId}:${accepted.taskId}:${accepted.executionId}:${accepted.invocationId}`;
    const waiter = this.waiters.get(key);
    if (waiter) {
      this.waiters.delete(key);
      waiter(accepted);
    }
    await this.options.onAccepted?.(accepted);
    await this.options.emit?.(acceptedEvent(accepted));
    return { outcome: 'accepted', reason: 'latest_interactive_decision', invocation: recorded.invocation, decision: delivery,
      resumeWorker: graphDecision.actions.includes('interactive.wakeWorker') };
  }

  close(): void {
    this.waiters.clear();
  }
}

function acceptedEvent(decision: AcceptedInteractiveDecision): EventRecord {
  return {
    version: 1,
    event_id: randomUUID(),
    job_id: decision.jobId,
    task_id: decision.taskId,
    parent_task_id: null,
    type: 'task.interactive_decision.accepted',
    status: 'succeeded',
    timestamp: new Date().toISOString(),
    visibility: 'orchestrator',
    level: 'info',
    message: `Interactive decision ${decision.decision} accepted for revision ${decision.revision}`,
    source: { id: `job/${decision.jobId}/task/${decision.taskId}/execution/${decision.executionId}`, component: 'agents-relay' },
    data: { interactive: { ...decision, decision: decision.decision, outcome: 'accepted' } },
  };
}

export type WorkerInteractiveContinuation = (decision: AcceptedInteractiveDecision) => Promise<Result>;

/** Recovery uses the canonical decision Graph, not transport delivery history. */
export async function shouldRecoverInteractiveDecision(status: InteractiveInvocationStatus): Promise<boolean> {
  const result = await dispatchWorkflowGraph(interactiveInvocationGraph, {
    initialState: status,
    input: { transport: 'event', id: 'task.interactive_recover', payload: {} },
    durableFacts: {}, graphName: 'interactive-invocation', observe: false,
    executeAction: () => ({}),
  });
  return result.accepted && result.actions.some(action => action.id === 'interactive.wakeWorker');
}
