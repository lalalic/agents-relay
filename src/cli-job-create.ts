import type { Job, Priority, ExecutionMode } from './types.js';
import { type GitHubClient, type PullRequest } from './store.js';
import { openLocalManagedStore } from './local-managed-store.js';
import { createJobEntity } from './workflow/entity-creation.js';
import { normalizeThreadId } from './reviewer-thread.js';
import { discoverLocalRelayStoreSnapshots } from './relay-store.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Job lifecycle bootstrap: SQLite is authoritative. PR creation is an
 * optional one-time external adapter; an explicit PR number is offline-safe.
 */
export async function ensureManagedGitHubJob(
  _client: GitHubClient,
  repositoryName: string,
  _trustedAuthors: ReadonlySet<string>,
  options: {
    id: string; title?: string; objective?: string; projectPath?: string;
    priority?: Priority; executionMode?: ExecutionMode; schedule?: Job['schedule'];
    tag?: Job['tag']; reviewEnabled?: boolean; continuation?: Job['continuation'];
    prNumber?: number; head?: string; base?: string; body?: string;
    reviewerThreadId?: string; creatorThreadId?: string;
    storeDirectory?: string; noGitHub?: boolean; localMergeSource?: string; localMergeTarget?: string;
  },
): Promise<{ job: Job; pr: PullRequest }> {
  if (!options.id) throw new Error('--id is required for managed local Jobs');
  const number = options.prNumber ?? 0;
  if (!Number.isInteger(number) || number < 0) throw new Error('Invalid external PR binding number');
  const pr: PullRequest = { number, title: options.title ?? options.id,
    body: options.body ?? options.objective ?? '', state: 'OPEN', head: '', base: options.base ?? '' };
  const directory = options.storeDirectory ?? join(homedir(), '.agents-relay', 'stores');
  const alreadyKnown = (await discoverLocalRelayStoreSnapshots(directory)).flatMap(snapshot =>
    snapshot.jobs.filter(job => job.id === options.id).map(job => ({ job, path: snapshot.path })));
  if (alreadyKnown.length > 1) throw new Error('Duplicate immutable Job ID across SQLite stores: ' + options.id);
  if (alreadyKnown.length === 1) {
    const existing = alreadyKnown[0].job;
    if (existing.repository !== repositoryName || (options.prNumber !== undefined && existing.prNumber !== number))
      throw new Error('Immutable Job ID is already bound to a different repository or external PR');
    return { job: existing, pr: { ...pr, number: existing.prNumber } };
  }
  const local = openLocalManagedStore(repositoryName, number, {
    directory, jobId: options.id, noGitHub: true,
  });
  try {
    const existing = await local.relay.loadJob(options.id);
    if (existing) return { job: existing, pr };
    const now = new Date().toISOString();
    const job = createJobEntity({
      id: options.id,
      title: options.title || pr.title || 'Agents Relay job',
      objective: options.objective || pr.body || undefined,
      projectPath: options.projectPath,
      description: pr.body || undefined,
      priority: options.priority ?? 'P2',
      executionMode: options.executionMode ?? 'fixed',
      tag: options.tag,
      autoMerge: true,
      ...(options.localMergeSource && options.localMergeTarget ? { localMerge: { sourceRef: options.localMergeSource, targetRef: options.localMergeTarget, status: 'pending' as const } } : {}),
      reviewEnabled: options.reviewEnabled ?? true,
      ...(options.reviewerThreadId
        ? { reviewerThreadId: normalizeThreadId(options.reviewerThreadId, 'reviewer thread ID') }
        : {}),
      ...(options.creatorThreadId
        ? { creatorThreadId: normalizeThreadId(options.creatorThreadId, 'creator thread ID') }
        : {}),
      prNumber: pr.number,
      repository: repositoryName,
      continuation: options.continuation ?? null,
      createdAt: now,
      updatedAt: now,
      tasks: [],
      ...(options.schedule ? { schedule: options.schedule } : {}),
    }, { activate: Boolean(options.schedule) });
    await local.store.saveJob(job);

    return { job: await local.store.load(options.id), pr };
  } finally {
    local.relay.close();
  }
}
