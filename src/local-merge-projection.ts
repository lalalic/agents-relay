import { randomUUID } from 'node:crypto';
import { validateProjectRoot } from './workspace.js';
import { spawnOwnedProcess } from './owned-process.js';
import type { DurableStore } from './store.js';
import type { Job } from './types.js';
import { dispatchWorkflowGraph } from './workflow/dispatcher.js';
import { projectionConflictV2, type ProjectionConflictState } from './workflow/projection-conflict-v2.js';

const MAX_ATTEMPTS = 5;
const LEASE_MS = 120_000;

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawnOwnedProcess('git', ['-C', cwd, ...args], {
      invocation: 'remote.delivery.git', timeoutMs: LEASE_MS,
      spawn: { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    });
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error((stderr.trim() || `git exited ${code}`).replace(/(https?:\/\/)[^/@\s]+@/g, '$1[redacted]@'))));
  });
}

async function inspectRemoteMain(repoPath: string, mergedCommitSha: string): Promise<{remoteContainsMain: boolean; inspectedMainSha: string}> {
  // Do not publish a moved/reset main that omits the Job's merged evidence.
  const expected = await git(repoPath, 'rev-parse', '--verify', mergedCommitSha);
  if (expected !== mergedCommitSha) throw new Error('Completed Job merged commit no longer resolves');
  const inspectedMainSha = await git(repoPath, 'rev-parse', '--verify', 'refs/heads/main');
  try { await git(repoPath, 'merge-base', '--is-ancestor', mergedCommitSha, inspectedMainSha); }
  catch { throw new Error('Local main no longer contains completed Job merged commit'); }
  const lines = (await git(repoPath, 'ls-remote', '--heads', 'origin', 'refs/heads/main')).split(/\s+/);
  const remoteHead = lines[0] || '';
  if (!remoteHead) return { remoteContainsMain: false, inspectedMainSha };
  await git(repoPath, 'fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  try {
    await git(repoPath, 'merge-base', '--is-ancestor', inspectedMainSha, 'refs/remotes/origin/main');
    return { remoteContainsMain: true, inspectedMainSha };
  } catch {
    try {
      await git(repoPath, 'merge-base', '--is-ancestor', 'refs/remotes/origin/main', inspectedMainSha);
      return { remoteContainsMain: false, inspectedMainSha };
    } catch {
      throw new Error(`origin/main diverged from local main (${remoteHead}); refusing non-fast-forward push`);
    }
  }
}

/** Run Graph-selected, bounded optional delivery for one already-completed local merge. */
export async function reconcileCompletedLocalDelivery(
  store: Pick<DurableStore, 'mutateJob'>, job: Job, repoPath: string, now: () => number = Date.now,
): Promise<void> {
  const sha = job.localMerge?.mergedCommitSha;
  if (job.state !== 'COMPLETED' || job.localMerge?.status !== 'succeeded' || !sha
      || job.localMerge.targetRef !== 'refs/heads/main' || job.remoteDelivery?.mergedCommitSha !== sha) return;
  const delivery = job.remoteDelivery;
  if (['skipped', 'succeeded', 'exhausted'].includes(delivery.status)) return;
  if (delivery.status === 'processing' && delivery.leaseUntil && Date.parse(delivery.leaseUntil) > now()) return;

  const run = (
    state: ProjectionConflictState, event: string, facts: Readonly<Record<string, unknown>>,
    perform: (actionId: string) => Promise<{ ok: true }>,
  ) => dispatchWorkflowGraph(projectionConflictV2, {
    initialState: state, input: { transport: 'event', id: event, payload: {} },
    durableFacts: facts, graphName: 'projection-conflict', maxSteps: 1, executeAction: perform,
  });

  // A single SQLite lease protects the entire inspection + push, not just the
  // last Git command. An expired lease is safely reconciled against remote HEAD.
  let leaseToken: string | undefined;
  let attempts = delivery.attempts;
  let claimed = false;
  const state: ProjectionConflictState = delivery.status === 'pending' ? 'classify' : 'waiting';
  const opening = await run(state, state === 'classify' ? 'job.completed' : 'delivery.retry_due', {
    retryDue: delivery.status === 'processing' || !delivery.nextRetryAt || Date.parse(delivery.nextRetryAt) <= now(),
    claimAvailable: delivery.attempts < MAX_ATTEMPTS,
  }, async actionId => {
    if (actionId === 'delivery.recordExhausted') {
      await store.mutateJob?.(job.id, current => {
        const currentDelivery = current.remoteDelivery;
        if (current.state !== 'COMPLETED' || currentDelivery?.mergedCommitSha !== sha
            || !['failed', 'pending', 'processing'].includes(currentDelivery.status)
            || currentDelivery.attempts < MAX_ATTEMPTS
            || (currentDelivery.leaseUntil && Date.parse(currentDelivery.leaseUntil) > now())) return current;
        return { ...current, remoteDelivery: { ...currentDelivery, status: 'exhausted', leaseUntil: undefined,
          leaseToken: undefined, nextRetryAt: undefined, updatedAt: new Date(now()).toISOString() } };
      });
      return { ok: true };
    }
    if (actionId !== 'delivery.claimInspection') throw new Error(`Unexpected delivery action before inspection: ${actionId}`);
    const token = randomUUID();
    await store.mutateJob?.(job.id, current => {
      const currentDelivery = current.remoteDelivery;
      if (current.state !== 'COMPLETED' || current.localMerge?.mergedCommitSha !== sha
          || currentDelivery?.mergedCommitSha !== sha
          || !['pending', 'failed', 'processing'].includes(currentDelivery.status)
          || currentDelivery.attempts >= MAX_ATTEMPTS) return current;
      if (currentDelivery.status === 'processing' && currentDelivery.leaseUntil && Date.parse(currentDelivery.leaseUntil) > now()) return current;
      if (currentDelivery.status === 'failed' && currentDelivery.nextRetryAt && Date.parse(currentDelivery.nextRetryAt) > now()) return current;
      attempts = currentDelivery.attempts + 1;
      leaseToken = token;
      claimed = true;
      return { ...current, remoteDelivery: { ...currentDelivery, status: 'processing', attempts,
        leaseToken: token, leaseUntil: new Date(now() + LEASE_MS).toISOString(), updatedAt: new Date(now()).toISOString() } };
    });
    return { ok: true };
  });
  if (!opening.accepted || opening.target !== 'inspect' || !claimed || !leaseToken) return;
  const token = leaseToken;
  const updateOwned = async (status: 'skipped' | 'succeeded' | 'failed' | 'exhausted', error?: string, delayMs?: number) => {
    await store.mutateJob?.(job.id, current => {
      const currentDelivery = current.remoteDelivery;
      if (current.state !== 'COMPLETED' || current.localMerge?.mergedCommitSha !== sha
          || currentDelivery?.mergedCommitSha !== sha || currentDelivery.leaseToken !== token) return current;
      return { ...current, remoteDelivery: { ...currentDelivery, status, error,
        leaseUntil: undefined, leaseToken: undefined,
        nextRetryAt: delayMs === undefined ? undefined : new Date(now() + delayMs).toISOString(),
        updatedAt: new Date(now()).toISOString() } };
    });
  };
  const recordFailure = async (from: 'inspect' | 'push', error: unknown): Promise<void> => {
    const failure = error instanceof Error ? error.message : String(error);
    const failed = await run(from, 'delivery.failed', { attempts, maxAttempts: MAX_ATTEMPTS }, async actionId => {
      const exhausted = actionId === 'delivery.recordExhausted';
      if (!exhausted && actionId !== 'delivery.scheduleRetry') throw new Error(`Unexpected delivery action ${actionId}`);
      const delayMs = Math.min(300_000, 1000 * (2 ** Math.min(attempts, 8)));
      await updateOwned(exhausted ? 'exhausted' : 'failed', failure, exhausted ? undefined : delayMs);
      return { ok: true };
    });
    if (!failed.accepted) throw new Error(`Delivery failure had no graph transition: ${failure}`);
  };

  let originUsable = false;
  let inspected = false;
  let inspectedMainSha: string | undefined;
  try {
    // Re-validate the immutable Git root after claiming the effect. If the
    // checkout disappeared or is now a linked worktree, persist a retry.
    await validateProjectRoot(repoPath, job.repository);
    originUsable = (await git(repoPath, 'remote')).split(/\r?\n/).includes('origin');
    if (originUsable) {
      // Do not read or persist a GitHub repository binding. The actual local
      // Git origin is resolved only after authoritative COMPLETED.
      await git(repoPath, 'remote', 'get-url', 'origin');
      const result = await inspectRemoteMain(repoPath, sha);
      inspected = result.remoteContainsMain;
      inspectedMainSha = result.inspectedMainSha;
    }
  } catch (error) {
    await recordFailure('inspect', error);
    return;
  }

  let pushSucceeded = false;
  const inspectedDecision = await run('inspect', 'inspect.completed', { originUsable, remoteContainsMain: inspected }, async actionId => {
    if (actionId === 'delivery.skip') {
      await updateOwned('skipped');
      return { ok: true };
    }
    if (actionId === 'delivery.recordDelivered') {
      await updateOwned('succeeded');
      return { ok: true };
    }
    if (actionId !== 'delivery.pushMain') throw new Error(`Unexpected delivery action ${actionId}`);
    if (!inspectedMainSha) throw new Error('Remote delivery cannot push without a verified local main SHA');
    try {
      // Git's normal refspec push is non-force. Remote-side FF race rejection
      // is persisted separately without mutating Job/Task lifecycle.
      await git(repoPath, 'push', 'origin', `${inspectedMainSha}:refs/heads/main`);
      pushSucceeded = true;
    } catch (error) {
      await recordFailure('push', error);
    }
    return { ok: true };
  });
  if (!inspectedDecision.accepted || inspectedDecision.target !== 'push' || !pushSucceeded) return;
  const finished = await run('push', 'delivery.pushed', {}, async actionId => {
    if (actionId !== 'delivery.recordDelivered') throw new Error(`Unexpected delivery action ${actionId}`);
    await updateOwned('succeeded');
    return { ok: true };
  });
  if (!finished.accepted) throw new Error('Delivery push had no graph transition');
}
