import type { DurableStore } from './store.js';
import type { EventRecord } from './types.js';
import { eventFor } from './events.js';
import { orchestratorRescueFacts, prepareOrchestratorRepair } from './workflow/orchestrator-rescue.js';
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
  const repairOne = async (taskId: string): Promise<{ repaired: boolean; externallyCompleted: boolean; failed: boolean; ageMs: number } | null> => {
    if (store.mutateJob) {
      let outcome = { repaired: false, externallyCompleted: false, failed: false, ageMs: 0 };
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
    const facts = orchestratorRescueFacts(stale, now);
    if (facts.legacyActive !== true) continue;
    if (facts.verifiedExternalCompletion !== true && facts.unknownStartedOutcome !== true && facts.rescuable !== true) continue;
    if (stale.executionId && !await reclaimStaleExecutionProcess(store, stale, ports.owner)) continue;
    const repair = await repairOne(stale.id);
    if (!repair?.repaired) continue;
    const job = await store.load(jobId);
    const task = job.tasks.find(item => item.id === stale.id)!;
    const type = repair.externallyCompleted ? 'task.external_completion_applied'
      : repair.failed ? 'task.orchestrator_quarantined' : 'task.orchestrator_rescued';
    const status = repair.externallyCompleted ? 'succeeded' : repair.failed ? 'failed' : 'queued';
    await ports.emit(eventFor(job.id, task.id, task.parentTaskId, type, status,
      repair.externallyCompleted
        ? `Applied durable external completion for legacy orchestrator task ${task.id}`
        : repair.failed
          ? `Failed legacy RUNNING orchestrator task ${task.id}; worker outcome is unknown and Troubleshooter diagnosis is required`
          : `Recovered legacy orchestrator task ${task.id} through Execution Router`,
      'orchestrator', { ageMs: repair.ageMs, adapter: repair.externallyCompleted || repair.failed ? undefined : 'execution-router' },
      { agent: 'relay', component: 'agents-relay' }));
  }
}
