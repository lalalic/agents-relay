import type { Job } from './types.js';

const listeners = new Set<(job: Job) => void>();
/** Notify dashboard listeners only after authoritative SQLite state is committed. */
export function publishLocalCommit(job: Job): void {
  // Notify after commit. A listener failure may be surfaced to the caller,
  // but it can never roll back the already-committed SQLite snapshot.
  for (const listener of listeners) listener(structuredClone(job));
}
export function subscribeLocalCommits(listener: (job: Job) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
