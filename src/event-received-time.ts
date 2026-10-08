import type { EventRecord } from './types.js';

const receivedTimes = new Map<string, string>();
const MAX_RECEIPTS = 10000;
/** Reception time is assigned by Relay, never trusted from worker payloads. */
export function markEventReceived(event: EventRecord, at = new Date().toISOString()): EventRecord {
  const receivedAt = receivedTimes.get(event.event_id) ?? at;
  if (!receivedTimes.has(event.event_id)) {
    receivedTimes.set(event.event_id, receivedAt);
    if (receivedTimes.size > MAX_RECEIPTS) receivedTimes.delete(receivedTimes.keys().next().value!);
  }
  return { ...event, reportedAt: event.reportedAt ?? event.timestamp, receivedAt };
}
export function recordedEventReceipt(event: EventRecord): EventRecord {
  const receivedAt = receivedTimes.get(event.event_id);
  return receivedAt ? { ...event, reportedAt: event.reportedAt ?? event.timestamp, receivedAt } : event;
}
