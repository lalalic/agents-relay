import type { DurableStore } from './store.js';
import type { EventRecord } from './types.js';
import { eventFor } from './events.js';
import { prepareOrchestratorRepair } from './workflow/orchestrator-rescue.js';
import { reclaimStaleExecutionProcess } from './execution-process-tracker.js';

export type LegacyOrchestratorRepairPorts = {
  store: DurableStore;
  owner: string;
  emit: (event: EventRecord) => void | Promise<void>;
};

/** Durable, race-safe repair effect selected by workflow/orchestrator-rescue.mmd. */
export async function repairLegacyOrchestrators(
  jobId: string,
  now: number,
  ports: LegacyOrchestratorRepairPorts,
): Promise<void> {
  const { store } = ports;
  const repairOne = async (taskId: string): Promise<{ repaired: boolean; externallyCompleted: boolean; ageMs: number } | null> => {
    if (store.mutateJob) {
      let outcome = { repaired: false, externallyCompleted: false, ageMs: 0 };
      return await store.mutateJob(jobId, current => {
        const task = current.tasks.find(item => item.id === taskId);
        if (!task) return current;
        const repair = prepareOrchestratorRepair(task, now);
        if (repair.repaired) outcome = repair;
        return current;
      }).then(() => outcome);
    }
    const job = await store.load(jobId);
    const task = job.tasks.find(item => item.id === taskId);
    if (!task) return null;
    const repair = prepareOrchestratorRepair(task, now);
    if (repair.repaired) await store.saveTask(task);
    return repair;
  };
  for (const stale of (await store.load(jobId)).tasks) {
    if (stale.executionId && !await reclaimStaleExecutionProcess(store, stale, ports.owner)) continue;
    const repair = await repairOne(stale.id);
    if (!repair?.repaired) continue;
    const job = await store.load(jobId);
    const task = job.tasks.find(item => item.id === stale.id)!;
    await ports.emit(eventFor(job.id, task.id, task.parentTaskId,
      repair.externallyCompleted ? 'task.external_completion_applied' : 'task.orchestrator_rescued',
      repair.externallyCompleted ? 'succeeded' : 'queued',
      repair.externallyCompleted
        ? `Applied durable external completion for legacy orchestrator task ${task.id}`
        : `Recovered legacy orchestrator task ${task.id} through Execution Router`,
      'orchestrator', { ageMs: repair.ageMs, adapter: repair.externallyCompleted ? undefined : 'execution-router' },
      { agent: 'relay', component: 'agents-relay' }));
  }
}
