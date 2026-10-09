import { createHash } from 'node:crypto';

/** Primary local store key is immutable Job ID, independent of a PR number. */
export function relayJobStorePath(directory: string, jobId: string): string {
  if (!jobId.trim() || jobId.length > 1024) throw new Error('Invalid immutable Job ID');
  return directory + '/job-' + createHash('sha256').update(jobId).digest('hex') + '.db';
}
