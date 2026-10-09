import type { DurableStore } from './store.js';
import type { Reconciler } from './reconciler.js';
import { LocalAuthorityDurableStore } from './local-authority-store.js';
import { errorMessage, observability } from './observability.js';

export async function flushServiceExternalActions(
  store: DurableStore,
  reconciler: Reconciler,
  jobId: string,
): Promise<number> {
  if (!(store instanceof LocalAuthorityDurableStore) || store.noGitHub) return 0;
  const result = await store.projection.flushOnce();
  if (result.projected > 0) await reconciler.reconcile(jobId);
  return result.projected;
}

export function startServiceExternalActionFlusher(
  store: DurableStore,
  reconciler: Reconciler,
  jobId: string,
  intervalMs: number,
): () => void {
  if (!(store instanceof LocalAuthorityDurableStore) || store.noGitHub) return () => {};
  const tick = (): void => {
    void flushServiceExternalActions(store, reconciler, jobId).catch(error =>
      observability().record({
        stage: 'reconcile',
        event: 'service.external_action_flush_failed',
        level: 'warn',
        outcome: 'failed',
        message: errorMessage(error),
      }));
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
