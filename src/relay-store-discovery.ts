import { DatabaseSync } from 'node:sqlite';
import { dirname,join } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { Job } from './types.js';
import type { PullRequestFacts } from './relay-store.js';
import type { PullRequestState } from './store.js';
import type { PublicationState } from './publication-store.js';
import { normalizeLegacyJobPrNumber } from './job-pr-number-migration.js';

/** Unified mode must be opted into only after the complete offline migration passes. */
export function unifiedRelayStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENTS_RELAY_SQLITE_MODE === 'unified';
}
export function relayUnifiedStorePath(directory: string): string { return join(dirname(directory), 'relay.sqlite'); }
/** Resolve one Job scope by repository and PR, refusing ambiguous matches. */
export function resolveUnifiedJobScope(directory: string, repository: string, prNumber: number, hintId?: string): string {
  const db = new DatabaseSync(relayUnifiedStorePath(directory), { readOnly: true });
  try {
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

/** Canonical on-disk Relay Store location for one managed GitHub pull request. */
export function relayStorePath(directory: string, repository: string, prNumber: number): string {
  return directory + '/' + `${repository.replace('/', '_')}-${prNumber}.db`;
}

export type LocalRelayStoreSnapshot = { path: string; jobs: Job[]; facts: PullRequestFacts | null; publications: Record<string, PublicationState> };

/**
 * SQLite is the only job registry. Inventory queries must be strictly read-only:
 * opening a writable RelayStore here would reset in-flight projection claims
 * on every dashboard refresh and could replay external merge side effects.
 */
export async function discoverLocalRelayStoreSnapshots(directory: string): Promise<LocalRelayStoreSnapshot[]> {
  if (unifiedRelayStoreEnabled()) {
    const path = relayUnifiedStorePath(directory);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const snapshots: LocalRelayStoreSnapshot[] = [];
      const rows = db.prepare('SELECT json FROM job_snapshot ORDER BY CAST(job_id AS INTEGER)').all() as Array<{json:string}>;
      const allPublications = Object.fromEntries((db.prepare('SELECT job_id,json FROM publication_state').all() as Array<{job_id:string;json:string}>).map(row=>[row.job_id,JSON.parse(row.json) as PublicationState]));
      for (const row of rows) {
        const job = normalizeLegacyJobPrNumber(JSON.parse(row.json) as Job);
        const fact = db.prepare('SELECT state,head_ref,head_sha,observed_at FROM pull_request_facts WHERE scope_job_id=? AND id=1').get(job.id) as {state:PullRequestState;head_ref:string|null;head_sha:string|null;observed_at:string}|undefined;
        const facts: PullRequestFacts|null = fact ? {state:fact.state,head:fact.head_ref && fact.head_sha ? {ref:fact.head_ref,sha:fact.head_sha} : null,observedAt:fact.observed_at} : null;
        const publications: Record<string,PublicationState> = {};
        if (allPublications[job.id]) publications[job.id] = allPublications[job.id];
        snapshots.push({path,jobs:[job],facts,publications});
      }
      return snapshots;
    } finally {db.close();}
  }
  let names: string[];
  try { names = await readdir(directory); } catch { return []; }
  const snapshots: LocalRelayStoreSnapshot[] = [];
  for (const name of names.filter(item => item.endsWith('.db')).sort()) {
    const path = directory + '/' + name;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const rows = db.prepare('SELECT json FROM job_snapshot ORDER BY job_id').all() as Array<{ json: string }>;
      const jobs = rows.map(row => normalizeLegacyJobPrNumber(JSON.parse(row.json) as Job));
      const row = db.prepare('SELECT state,head_ref,head_sha,observed_at FROM pull_request_facts WHERE id=1').get() as {
        state: PullRequestState; head_ref: string | null; head_sha: string | null; observed_at: string;
      } | undefined;
      const facts: PullRequestFacts | null = row ? {
        state: row.state,
        head: row.head_ref && row.head_sha ? { ref: row.head_ref, sha: row.head_sha } : null,
        observedAt: row.observed_at,
      } : null;
      const publications = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='publication_state'").get() ? Object.fromEntries((db.prepare('SELECT job_id,json FROM publication_state').all() as Array<{job_id: string; json: string}>).map(item => [item.job_id, JSON.parse(item.json) as PublicationState])) : {};
      snapshots.push({ path, jobs, facts, publications });
    } catch {
      // Ignore unrelated/corrupt files without allowing one damaged store to block recovery.
    } finally {
      db?.close();
    }
  }
  return snapshots;
}
