export const WORKFLOW_EVENT_NAMES = [
  'activate',
  'block',
  'cancel',
  'dispatch',
  'effect.cancelActiveTasks.failed',
  'effect.launchTask.failed',
  'effect.mergePullRequest.failed',
  'fail',
  'hold',
  'implementation.completed',
  'pr.closed',
  'pr.merged',
  'reconcile',
  'release',
  'retry',
  'review.started',
  'review.approved',
  'review.changes_required',
  'review.blocked',
  'task.blocked',
  'task.cancelled',
  'task.completed',
  'task.failed',
  'task.started',
  'task.unblocked',
  'watchdog.failed',
  'worker.delivery_failed',
  'worker.start_ack_failed',
] as const;

export const WORKFLOW_FACT_NAMES = [
  'dependenciesSatisfied',
  'dependenciesUnsatisfied',
  'runnable',
  'dispatchable',
  'notMerged',
  'autoMerge',
  'recoverableExecution',
] as const;

export const WORKFLOW_MUTATION_NAMES = [
  'mutation.clearError',
  'mutation.clearFailureReason',
] as const;

export const WORKFLOW_EFFECT_NAMES = [
  'effect.launchTask',
  'effect.cancelActiveTasks',
  'effect.mergePullRequest',
] as const;

export type WorkflowEventName = typeof WORKFLOW_EVENT_NAMES[number];
export type WorkflowFactName = typeof WORKFLOW_FACT_NAMES[number];
export type WorkflowMutationName = typeof WORKFLOW_MUTATION_NAMES[number];
export type WorkflowEffectName = typeof WORKFLOW_EFFECT_NAMES[number];


export type WorkflowEffectPayloads = {
  'effect.launchTask': { attempt: number };
  'effect.cancelActiveTasks': { reason: string };
  'effect.mergePullRequest': { headSha: string };
};

export const WORKFLOW_EFFECT_POLICIES = {
  'effect.launchTask': {
    idempotency: 'job-task-attempt',
    failureEvent: 'effect.launchTask.failed',
    retry: 'workflow',
    observability: 'workflow.effect',
  },
  'effect.cancelActiveTasks': {
    idempotency: 'job-transition',
    failureEvent: 'effect.cancelActiveTasks.failed',
    retry: 'workflow',
    observability: 'workflow.effect',
  },
  'effect.mergePullRequest': {
    idempotency: 'job-head-sha',
    failureEvent: 'effect.mergePullRequest.failed',
    retry: 'workflow',
    observability: 'workflow.effect',
  },
} as const satisfies Record<WorkflowEffectName, {
  idempotency: string;
  failureEvent: WorkflowEventName;
  retry: 'workflow' | 'none';
  observability: string;
}>;

export function workflowEffectFailureEvent(effect: WorkflowEffectName): WorkflowEventName {
  return WORKFLOW_EFFECT_POLICIES[effect].failureEvent;
}

const mutations = new Set<string>(WORKFLOW_MUTATION_NAMES);
const effects = new Set<string>(WORKFLOW_EFFECT_NAMES);

export type WorkflowDecision<State extends string> = {
  accepted: boolean;
  target: State | null;
  guard: string | null;
  actions: readonly string[];
  mutations: readonly WorkflowMutationName[];
  effects: readonly WorkflowEffectName[];
  reason: 'accepted' | 'no_transition' | 'ambiguous';
};

export function classifyWorkflowActions(actions: readonly string[]): Pick<WorkflowDecision<string>, 'mutations' | 'effects'> {
  const foundMutations: WorkflowMutationName[] = [];
  const foundEffects: WorkflowEffectName[] = [];
  for (const action of actions) {
    if (mutations.has(action)) foundMutations.push(action as WorkflowMutationName);
    else if (effects.has(action)) foundEffects.push(action as WorkflowEffectName);
    else throw new Error(`Unknown canonical workflow action ${action}`);
  }
  return { mutations: foundMutations, effects: foundEffects };
}

export function emptyWorkflowDecision<State extends string>(
  reason: 'no_transition' | 'ambiguous',
): WorkflowDecision<State> {
  return { accepted: false, target: null, guard: null, actions: [], mutations: [], effects: [], reason };
}
