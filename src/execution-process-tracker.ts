import type { DurableStore } from './store.js';
import type { Task } from './types.js';
import type { Execution } from './adapters.js';
import { activeRelayLeaseOwner, captureProcessRecord, probeProcessRecord, stopOrphanedProcessGroup } from './process-identity.js';

/** Correlate Relay execution IDs with OS process identity in SQLite, never GitHub. */
export async function monitorExecutionProcess(
  store: DurableStore,
  jobId: string,
  taskId: string,
  executionId: string,
  owner: string,
  execution: Execution,
): Promise<void> {
  if (!execution.pid || !store.recordExecutionProcess) return;
  const registration = (async () => {
    const record = await captureProcessRecord(jobId, taskId, executionId, owner, execution.pid!);
    if (record) await store.recordExecutionProcess?.(record);
  })();
  const closeRecord = async (): Promise<void> => {
    await registration;
    await store.finishExecutionProcess?.(jobId, taskId, executionId);
  };
  void execution.promise.then(closeRecord, closeRecord).catch(() => {
    // Recording failures are surfaced by the registration promise to the caller.
  });
  await registration;
}

/** Reuse only if the previous exact process has gone or safely been reaped. */
export async function reclaimStaleExecutionProcess(store: DurableStore, task: Task, currentOwner?: string): Promise<boolean> {
  if (!task.executionId || !task.jobId || !store.loadExecutionProcess) return true;
  const record = await store.loadExecutionProcess(task.jobId, task.id, task.executionId);
  if (!record || record.endedAt) return true;
  const state = await probeProcessRecord(record);
  if (state === 'gone' || state === 'reused') return true;
  if (state !== 'alive' || (task.leaseOwner && task.leaseOwner !== currentOwner && await activeRelayLeaseOwner(task.leaseOwner))) return false;
  return await stopOrphanedProcessGroup(record);
}
