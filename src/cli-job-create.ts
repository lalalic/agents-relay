import { allocateEntityId, isGeneratedEntityId } from './job-task-id-sequence.js';
import type { Job, Priority } from './types.js';
import { type GitHubClient, type PullRequest } from './store.js';
import { openLocalManagedStore } from './local-managed-store.js';
import { createJobEntity } from './workflow/entity-creation.js';
import { normalizeThreadId } from './reviewer-thread.js';
import { discoverLocalRelayStoreSnapshots, relayStoreDirectory } from './relay-store.js';

/** Create a local SQLite-authoritative Job; external PR metadata is optional compatibility data. */
export async function ensureManagedGitHubJob(
  _client: GitHubClient,
  repositoryName: string,
  _trustedAuthors: ReadonlySet<string>,
  options: {
    id?: string; idempotencyKey?: string; title?: string; objective?: string; projectPath?: string;
    priority?: Priority;
    tag?: Job['tag']; reviewEnabled?: boolean; continuation?: Job['continuation'];
    contentOnly?: boolean;
    executionMode?: Job['executionMode']; // Deprecated input alias; never persisted.
    prNumber?: number; head?: string; base?: string; body?: string;
    reviewerThreadId?: string; creatorThreadId?: string; implementationThreadId?: string;
    storeDirectory?: string; noGitHub?: boolean; persist?: boolean; localMergeSource?: string; localMergeTarget?: string;
  },
): Promise<{ job: Job; pr: PullRequest }> {
  if (options.id && !/^[1-9][0-9]*$/.test(options.id)) throw new Error('Job ID must be a positive decimal integer');
  const directory = options.storeDirectory ?? relayStoreDirectory();
  const knownJobs = (await discoverLocalRelayStoreSnapshots(directory)).flatMap(snapshot => snapshot.jobs);
  const id = options.id || allocateEntityId(directory, repositoryName, 'job', options.idempotencyKey, new Set(knownJobs.map(job => job.id)));
  const requestedNumber = options.prNumber ?? 0;
  if (!Number.isInteger(requestedNumber) || requestedNumber < 0) throw new Error('Invalid external PR binding number');
  const placeholder: PullRequest = { number: requestedNumber, title: options.title ?? id,
    body: options.body ?? options.objective ?? '', state: 'OPEN', head: options.head ?? '', base: options.base ?? '' };
  const alreadyKnown = knownJobs.filter(job => job.id === id);
  if (alreadyKnown.length > 1) throw new Error('Duplicate immutable Job ID across SQLite stores: ' + id);
  if (alreadyKnown.length === 1) {
    const existing = alreadyKnown[0];
    if (existing.repository !== repositoryName || (options.prNumber !== undefined && existing.prNumber !== requestedNumber)) throw new Error('Immutable Job ID is already bound to a different repository or external PR');
    if (!options.id && !options.idempotencyKey) throw new Error('Automatically allocated Job ID unexpectedly belongs to an existing Job');
    if (options.idempotencyKey && ((options.objective && options.objective !== existing.objective) || (options.projectPath && options.projectPath !== existing.projectPath) || (options.title && options.title !== existing.title))) throw new Error('Job idempotency key reused for a different Job definition');
    return { job: existing, pr: { ...placeholder, number: existing.prNumber } };
  }
  if (options.id && isGeneratedEntityId(id, repositoryName, 'job')) throw new Error('Reserved auto-generated Job ID cannot be assigned manually');
  const pr = placeholder;
  const number = pr.number;
  const local = openLocalManagedStore(repositoryName, number, {
    directory, jobId: id, noGitHub: true,
  });
  try {
    const existing = await local.relay.loadJob(id);
    if (existing) return { job: existing, pr };
    const now = new Date().toISOString();
    const localMergeSource = options.localMergeSource ?? (options.head ? `refs/heads/${options.head}` : undefined);
    if (options.localMergeTarget && options.localMergeTarget !== 'refs/heads/main') throw new Error('Local merge target must always be main');
    if (options.base && options.base !== 'main') throw new Error('Job base must always be main');
    const job = createJobEntity({
      id,
      title: options.title || pr.title || 'Agents Relay job',
      objective: options.objective || pr.body || undefined,
      projectPath: options.projectPath,
      description: pr.body || undefined,
      priority: options.priority ?? 'P2',
      tag: options.tag,
      autoMerge: options.contentOnly || options.executionMode === 'shortcut' ? false : true,
      ...(localMergeSource ? { localMerge: { sourceRef: localMergeSource, targetRef: 'refs/heads/main', status: 'pending' as const } } : {}),
      reviewEnabled: options.contentOnly || options.executionMode === 'shortcut' ? false : options.reviewEnabled ?? true,
      ...(options.contentOnly || options.executionMode === 'shortcut' ? { contentOnly: true } : {}),
      ...(options.reviewerThreadId
        ? { reviewerThreadId: normalizeThreadId(options.reviewerThreadId, 'reviewer thread ID') }
        : {}),
      ...(options.creatorThreadId
        ? { creatorThreadId: normalizeThreadId(options.creatorThreadId, 'creator thread ID') }
        : {}),
      ...(options.implementationThreadId
        ? { implementationThreadId: normalizeThreadId(options.implementationThreadId, 'implementation thread ID') }
        : {}),
      prNumber: pr.number,
      repository: repositoryName,
      continuation: options.continuation ?? null,
      createdAt: now,
      updatedAt: now,
      tasks: [],
    });
    if (options.persist !== false) {
      if (local.store.createJobIfAbsent) await local.store.createJobIfAbsent(job);
      else await local.store.saveJob(job);
    }

    return { job: options.persist === false ? job : await local.store.load(id), pr };
  } finally {
    local.relay.close();
  }
}
