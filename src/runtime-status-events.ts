import type {Job} from './types.js';
import {deriveJobRuntimeStatus} from './runtime-status.js';
import {eventFor, type EventBus} from './events.js';

/** Process-local change detector. No extra durable status field or polling required. */
export function createRuntimeStatusPublisher(bus: Pick<EventBus,'publish'>) {
  const last = new Map<string, ReturnType<typeof deriveJobRuntimeStatus>>();
  return (job: Job): void => {
    const key = `${job.repository}\0${job.id}`;
    const to = deriveJobRuntimeStatus(job);
    const from = last.get(key);
    if (from === to) return;
    last.set(key,to);
    // First observation establishes a baseline rather than fabricating a transition.
    if (from === undefined) return;
    const event = eventFor(job.id,'',null,'job.runtime_status.changed','info',`${from} → ${to}`,'orchestrator',
      {from,to,repository:job.repository,jobState:job.state,updatedAt:job.updatedAt},
      {agent:'relay',component:'runtime-status'});
    void bus.publish(event).catch(error => {
      process.stderr.write(`runtime status change publish failed ${job.id}: ${String(error)}\n`);
    });
  };
}
