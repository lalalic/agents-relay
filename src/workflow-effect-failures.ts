import type { DurableStore } from './store.js';
import type { EventRecord, Job, Task } from './types.js';
import type { WorkflowEffectOutcome } from './workflow/effects.js';
import { transitionJobEvent, transitionTaskEvent } from './scheduler.js';
import { workflowEffectFailureEvent } from './workflow/contracts.js';
import { eventFor } from './events.js';
export async function applyJobEffectOutcomes(store: DurableStore, emit: (event: EventRecord) => Promise<void>, job: Job, outcomes: readonly WorkflowEffectOutcome[]): Promise<void> {
    for (const outcome of outcomes.filter(item => item.status === 'failed')) {
      const eventName = workflowEffectFailureEvent(outcome.effect);
      try {
        await transitionJobEvent(job, eventName);
        await store.saveJob(job);
      } catch {
        // Some effects are observational for a given state; failure is still emitted below.
      }
      await emit(eventFor(
        job.id,
        'job',
        null,
        'workflow.effect.failed',
        'failed',
        `${outcome.effect} failed: ${outcome.error ?? 'unknown error'}`,
        'orchestrator',
        { effect: outcome.effect, idempotencyKey: outcome.key, workflowEvent: eventName },
        { agent: 'relay', component: 'agents-relay' },
      ));
    }
  }
export async function applyTaskEffectOutcomes(store: DurableStore, emit: (event: EventRecord) => Promise<void>, job: Job, task: Task, outcomes: readonly WorkflowEffectOutcome[]): Promise<void> {
    for (const outcome of outcomes.filter(item => item.status === 'failed')) {
      const eventName = workflowEffectFailureEvent(outcome.effect);
      try {
        await transitionTaskEvent(task, eventName);
        task.error = outcome.error ?? `${outcome.effect} failed`;
        await store.saveTask(task);
      } catch {
        // The effect failure remains observable even if this state has no feedback transition.
      }
      await emit(eventFor(
        job.id,
        task.id,
        task.parentTaskId,
        'workflow.effect.failed',
        'failed',
        `${outcome.effect} failed: ${outcome.error ?? 'unknown error'}`,
        'orchestrator',
        { effect: outcome.effect, idempotencyKey: outcome.key, workflowEvent: eventName },
        { agent: 'relay', component: 'agents-relay' },
      ));
    }
  }
