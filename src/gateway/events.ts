import { EventRecord } from '../types.js';
import { EventBus, eventFor } from '../events.js';

export interface EventSink {
  publish(event: EventRecord): Promise<void>;
}

/**
 * Events are wake-up/observability only. Publishing never gates a durable outcome: a failing
 * transport is reported as `event.transport.failed` and the caller continues.
 */
export function createEventSink(options: { eventBus?: EventBus; emit?: (event: EventRecord) => void | Promise<void> }): EventSink {
  async function reportTelemetry(event: EventRecord): Promise<void> {
    try {
      if (options.emit) await options.emit(event);
    } catch {
      /* observability cannot block durable execution */
    }
  }
  async function reportTransportFailure(error: unknown): Promise<void> {
    await reportTelemetry(eventFor('system', 'event-bus', null, 'event.transport.failed', 'failed', `Event transport unavailable: ${error instanceof Error ? error.message : String(error)}`, 'orchestrator'));
  }
  return {
    async publish(event: EventRecord): Promise<void> {
      await reportTelemetry(event);
      try {
        if (options.eventBus) await options.eventBus.publish(event);
      } catch (error) {
        await reportTransportFailure(error);
      }
    },
  };
}
