import { DatabaseSync } from 'node:sqlite';
import { readdir } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Job } from './types.js';
import type { PullRequestFacts } from './relay-store.js';
import type { PullRequestState } from './store.js';
import type { PublicationState } from './publication-store.js';
import { normalizeLegacyJobPrNumber } from './job-pr-number-migration.js';

export function relayUnifiedStorePath(directory: string): string { return join(dirname(directory), 'relay.sqlite'); }
/** Resolve one Job scope by repository and PR, refusing ambiguous matches. */
export function resolveUnifiedJobScope(directory: string, repository: string, prNumber: number, hintId?: string): string {
  const path = relayUnifiedStorePath(directory);
  if (hintId && !existsSync(path)) return hintId;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const hasRegistry = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_registry'").get();
    if (!hasRegistry) {
      if (hintId) return hintId;
      throw new Error(`Unified Job scope is missing for ${repository} PR ${prNumber}; supply immutable Job ID`);
    }
    if (hintId) {
      const binding = db.prepare('SELECT repository,pr_number FROM source_registry WHERE job_id=?').get(hintId) as {repository:string;pr_number:number}|undefined;
      if (binding && (binding.repository !== repository || (prNumber > 0 && binding.pr_number !== prNumber))) throw new Error(`Job ${hintId} is bound to another repository or PR`);
      return hintId;
    }
    const rows = db.prepare('SELECT job_id FROM source_registry WHERE repository=? AND pr_number=?').all(repository, prNumber) as Array<{job_id:string}>;
    if (rows.length !== 1) throw new Error(`Unified Job scope is ${rows.length ? 'ambiguous' : 'missing'} for ${repository} PR ${prNumber}; supply immutable Job ID`);
    return rows[0].job_id;
  } finally { db.close(); }
}

export type LocalRelayStoreSnapshot = { path: string; jobs: Job[]; facts: PullRequestFacts | null; publications: Record<string, PublicationState> };

/**
 * SQLite is the only job registry. Inventory queries must be strictly read-only:
 * opening a writable RelayStore here would reset in-flight projection claims
 * on every dashboard refresh and could replay external merge side effects.
 */
export async function discoverLocalRelayStoreSnapshots(directory: string): Promise<LocalRelayStoreSnapshot[]> {
  const path = relayUnifiedStorePath(directory);
  if (!existsSync(path)) {
    // Never silently treat legacy per-Job files as an empty authoritative database.
    const files = await readdir(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
      throw error;
    });
    if (files.some(name => name.endsWith('.db'))) {
      throw new Error(`Unified Relay SQLite database missing at ${path}; legacy Job databases exist in ${directory}`);
    }
    return [];
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare('SELECT json FROM job_snapshot ORDER BY CAST(job_id AS INTEGER), job_id').all() as Array<{json:string}>;
    const allPublications = Object.fromEntries((db.prepare('SELECT job_id,json FROM publication_state').all() as Array<{job_id:string;json:string}>).map(row=>[row.job_id,JSON.parse(row.json) as PublicationState]));
    return rows.map(row => {
      const job = normalizeLegacyJobPrNumber(JSON.parse(row.json) as Job);
      const fact = db.prepare('SELECT state,head_ref,head_sha,observed_at FROM pull_request_facts WHERE scope_job_id=? AND id=1').get(job.id) as {state:PullRequestState;head_ref:string|null;head_sha:string|null;observed_at:string}|undefined;
      return { path, jobs:[job], facts: fact ? {state:fact.state,head:fact.head_ref && fact.head_sha ? {ref:fact.head_ref,sha:fact.head_sha} : null,observedAt:fact.observed_at} : null, publications: allPublications[job.id] ? {[job.id]: allPublications[job.id]} : {} };
    });
  } catch (error) {
    throw new Error(`Unified Relay SQLite inventory unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally { db.close(); }
}
