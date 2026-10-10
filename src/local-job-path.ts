import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Primary local store key is immutable Job ID, independent of a PR number. */
export function relayJobStorePath(directory: string, jobId: string): string {
  if (!jobId.trim() || jobId.length > 1024) throw new Error('Invalid immutable Job ID');
  return directory + '/job-' + createHash('sha256').update(jobId).digest('hex') + '.db';
}

export function relayStoreDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTS_RELAY_STORE_DIR || join(homedir(), '.agents-relay', 'stores');
}
