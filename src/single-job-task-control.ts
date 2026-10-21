/** Single-job HTTP control adapter: reuse daemon Graph-owned semantics, no duplicate policy. */
import type { DurableStore } from './store.js';
import type { Reconciler } from './reconciler.js';
import type { EventBus } from './events.js';
import { dispatchTaskAction } from './task-actions.js';

export async function createSingleJobTaskControl(jobId: string, store: DurableStore, reconciler: Reconciler, bus?: EventBus): Promise<(body: Record<string, unknown>)=>Promise<unknown>> {
  const { createWorkspaceControl } = await import('./relayd-control.js');
  const unblock = await import('./unblock.js');
  const { publishTaskUnblocked } = await import('./cli-support.js');
  const canonicalControl = createWorkspaceControl({
    requireLocalJobBinding: async (id: string) => {
      if (id !== jobId) throw new Error('Control request outside bound Job');
      return { store };
    },
    pool: { reconcileLocalJob: async (id: string) => {
      await reconciler.reconcile(id); await reconciler.idle();
    } },
    bus, isEffectivelyBlocked: unblock.isEffectivelyBlocked,
    unblockAutonomousTasks: unblock.unblockAutonomousTasks, unblockTask: unblock.unblockTask,
    publishTaskUnblocked, dispatchTaskAction,
  });
  const allowed = new Set(['task.unblock','task.recover','task.escalate','task.resume-troubleshooter','task.classify']);
  return async (body: Record<string, unknown>): Promise<unknown> => {
    if (!allowed.has(String(body.command ?? ''))) throw new Error('Single-Job control command not supported');
    if (body.jobId !== jobId) throw new Error('Control request outside bound Job');
    return canonicalControl(body);
  };
}
