import { StartAckTimeout } from './adapters.js';
import type { EventBus } from './events.js';

/** A worker start ack is scoped to its server-issued execution source, never its client clock. */
export async function createWorkerStartAck(bus: EventBus, jobId: string, taskId: string, sourceId: string, timeoutMs: number, cleanups: Set<() => Promise<void>>): Promise<{ ack: Promise<void>; stop: () => Promise<void> }> {
  let resolveAck!: () => void;
  let rejectAck!: (error: Error) => void;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const ack = new Promise<void>((resolve, reject) => { resolveAck = resolve; rejectAck = reject; });
  const unsubscribe = await bus.subscribe(jobId, async event => {
    if (settled || event.type !== 'task.started' || event.job_id !== jobId || event.task_id !== taskId) return;
    if (event.source?.id !== sourceId) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolveAck();
  });
  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    void unsubscribe();
    rejectAck(new StartAckTimeout(`Task ${taskId} worker_start_timeout: no worker task.started start-ack`));
  }, timeoutMs);
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (!settled) { settled = true; rejectAck(new StartAckTimeout(`Task ${taskId} worker_start_cancelled: start-ack owner closed`)); }
    cleanups.delete(stop);
    await unsubscribe();
  };
  cleanups.add(stop);
  return { ack, stop };
}
