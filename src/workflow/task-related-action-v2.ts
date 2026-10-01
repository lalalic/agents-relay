import { readFileSync } from 'node:fs';
import type { Task } from '../types.js';
import { decideTaskLifecycle } from './lifecycle.js';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';
import { dispatchWorkflowGraphSync } from './dispatcher.js';

export type RelatedTaskActionState = 'evaluate' | 'check_other' | 'check_recovery' | 'skip' | 'selected';

const source = readFileSync(new URL('../../workflow/task-related-action.mmd', import.meta.url), 'utf8');
const boolGuard = (name: string) =>
  (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }): boolean =>
    facts.durableFacts[name] === true;

export const taskRelatedActionV2 = new GraphRuntime(source, {
  states: new Set<RelatedTaskActionState>(['evaluate', 'check_other', 'check_recovery', 'skip', 'selected']),
  guards: {
    otherTask: boolGuard('otherTask'),
    recoveryForTask: boolGuard('recoveryForTask'),
    candidateCancellable: boolGuard('candidateCancellable'),
  },
  actions: {
    'task.retry': { id: 'task.retry' },
    'task.cancel': { id: 'task.cancel' },
    'task.unblock.retry': { id: 'task.unblock.retry' },
    'task.queue': { id: 'task.queue' },
    'task.release': { id: 'task.release' },
    'task.hold': { id: 'task.hold' },
    'related.cancel': { id: 'related.cancel' },
  },
  events: {},
});

export function relatedTaskActionFacts(task: Task, candidate: Task): Readonly<Record<string, unknown>> {
  return {
    otherTask: candidate.id !== task.id,
    recoveryForTask: candidate.agentName === 'troubleshooter'
      && (
        candidate.parentTaskId === task.id
        || (!candidate.parentTaskId && candidate.id.startsWith(`troubleshoot-${task.id}-a`))
      ),
    candidateCancellable: decideTaskLifecycle(candidate, 'cancel').accepted,
  };
}

export function decideRelatedTaskAction(task: Task, candidate: Task, actionId: string): GraphDecision {
  return dispatchWorkflowGraphSync(taskRelatedActionV2, {
    initialState: 'evaluate',
    input: { transport: 'action', id: actionId, payload: {} },
    durableFacts: relatedTaskActionFacts(task, candidate),
    graphName: 'task-related-action',
    isTransientState: state => state === 'check_other' || state === 'check_recovery',
    maxSteps: 3,
  });
}
