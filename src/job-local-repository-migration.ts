import { access, copyFile, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Job } from './types.js';
import { validateProjectRoot } from './workspace.js';

type Mapping = { jobId: string; projectRoot: string; githubRepo?: string };
type MappingFile = { version: 1; jobs: Mapping[] };

/** Explicit, idempotent migration. Requires daemon downtime; writes only after full preflight and a verified backup. */
export async function migrateJobLocalRepositories(databasePath: string, mappingPath: string): Promise<{ migrated: number; backupPath: string }> {
  const dbPath = resolve(databasePath);
  const mappings = JSON.parse(await readFile(mappingPath, 'utf8')) as MappingFile;
  if (mappings.version !== 1 || !Array.isArray(mappings.jobs)) throw new Error('Mapping file must have version: 1 and jobs: []');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout=10000; PRAGMA wal_checkpoint(FULL)');
    const rows = db.prepare('SELECT job_id,json FROM job_snapshot ORDER BY job_id').all() as Array<{ job_id: string; json: string }>;
    const byId = new Map(mappings.jobs.map(item => [item.jobId, item]));
    if (byId.size !== mappings.jobs.length || byId.size !== rows.length || rows.some(row => !byId.has(row.job_id)) || mappings.jobs.some(item => !rows.some(row => row.job_id === item.jobId)))
      throw new Error('Migration mapping must contain exactly one entry for every durable Job ID');
    const identities = new Map<string, string>();
    const plans: Array<{ id: string; oldRepository: string; job: Job; root: string; repository: string; githubRepo?: string }> = [];
    for (const row of rows) {
      const job = JSON.parse(row.json) as Job;
      const mapping = byId.get(job.id)!;
      const root = await validateProjectRoot(mapping.projectRoot, basename(await realpath(mapping.projectRoot)));
      const repository = basename(root);
      const collision = identities.get(repository);
      if (collision && collision !== root) throw new Error(`Local repository identity collision ${repository}: ${collision} and ${root}`);
      identities.set(repository, root);
      if (mapping.githubRepo && !/^[^/]+\/[^/]+$/.test(mapping.githubRepo)) throw new Error(`Invalid GitHub remote for Job ${job.id}`);
      plans.push({ id: job.id, oldRepository: job.repository, job, root, repository, githubRepo: mapping.githubRepo });
    }
    const aliases = new Map<string, string>();
    for (const item of plans) {
      const prior = aliases.get(item.oldRepository);
      if (prior && prior !== item.repository) throw new Error(`Historical repository alias ${item.oldRepository} maps to multiple local repositories`);
      aliases.set(item.oldRepository, item.repository);
    }
    for (const item of plans) {
      const registered = db.prepare('SELECT repository FROM source_registry WHERE job_id=?').get(item.id) as { repository: string } | undefined;
      if (!registered || registered.repository !== item.oldRepository) throw new Error(`source_registry does not match Job ${item.id}; repair mapping explicitly before migration`);
    }
    const updates = plans.map(item => {
      const rewritten = rewriteRepositoryReferences(item.job, aliases);
      rewritten.projectRoot = item.root;
      rewritten.repository = item.repository;
      if (item.githubRepo) rewritten.githubRepo = item.githubRepo; else delete rewritten.githubRepo;
      return { id: item.id, json: JSON.stringify(rewritten), repository: item.repository };
    });
    const plannedById = new Map(plans.map(item => [item.id, item]));
    const pendingOutbox = db.prepare('SELECT scope_job_id,id,operation,payload_json,conflict_definition_json,conflict_evidence_json,conflict_resolution_json FROM projection_outbox').all() as Array<{scope_job_id:string;id:number;operation:string;payload_json:string;conflict_definition_json:string|null;conflict_evidence_json:string|null;conflict_resolution_json:string|null}>;
    const rewrittenOutbox = pendingOutbox.map(row => {
      const owner = plannedById.get(row.scope_job_id);
      if (!owner) throw new Error(`Pending external operation is scoped to unmapped Job ${row.scope_job_id}`);
      const rewrite = (json: string | null, external = false): string | null => {
        if (json === null) return null;
        const parsed = JSON.parse(json) as Record<string, unknown>;
        const output = rewriteRepositoryReferences(parsed, aliases) as Record<string, unknown>;
        if (external && typeof output.repository === 'string') {
          if (!owner.githubRepo) throw new Error(`Job ${owner.id} has pending GitHub operation ${row.operation} but no explicit githubRepo mapping`);
          output.repository = owner.githubRepo;
        }
        return JSON.stringify(output);
      };
      const pendingGitHubEffect = row.operation === 'create_pull_request' || row.operation === 'close_pull_request';
      return { ...row, payload_json: rewrite(row.payload_json, pendingGitHubEffect),
        conflict_definition_json: rewrite(row.conflict_definition_json, pendingGitHubEffect),
        conflict_evidence_json: rewrite(row.conflict_evidence_json, pendingGitHubEffect),
        conflict_resolution_json: rewrite(row.conflict_resolution_json, pendingGitHubEffect) };
    });
    const backupPath = `${dbPath}.pre-local-repository-v1.bak`;
    try { await access(backupPath); }
    catch { try { await copyFile(dbPath, backupPath, 0); } catch (error) { throw new Error(`Cannot create migration backup ${backupPath}: ${String(error)}`); } }
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const backupCount = Number((backup.prepare('SELECT COUNT(*) AS n FROM job_snapshot').get() as { n: number }).n);
      if (backupCount !== rows.length) throw new Error('Migration backup verification failed');
    } finally { backup.close(); }
    db.exec('BEGIN IMMEDIATE');
    try {
      const updateJob = db.prepare('UPDATE job_snapshot SET json=?,updated_at=updated_at WHERE job_id=?');
      const updateRegistry = db.prepare('UPDATE source_registry SET repository=? WHERE job_id=?');
      const updateOutbox = db.prepare('UPDATE projection_outbox SET payload_json=?,conflict_definition_json=?,conflict_evidence_json=?,conflict_resolution_json=? WHERE scope_job_id=? AND id=?');
      for (const row of updates) {
        updateJob.run(row.json, row.id);
        const result = updateRegistry.run(row.repository, row.id);
        if (Number(result.changes) !== 1) throw new Error(`Missing source_registry entry for Job ${row.id}`);
      }
      for (const row of rewrittenOutbox) {
        updateOutbox.run(row.payload_json, row.conflict_definition_json, row.conflict_evidence_json, row.conflict_resolution_json, row.scope_job_id, row.id);
      }
      db.prepare("INSERT INTO migration_metadata(key,value) VALUES('local-repository-v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { migrated: updates.length, backupPath };
  } finally { db.close(); }
}

function rewriteRepositoryReferences<T>(value: T, aliases: Map<string, string>): T {
  if (Array.isArray(value)) return value.map(item => rewriteRepositoryReferences(item, aliases)) as T;
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>))
    output[key] = key === 'repository' && typeof item === 'string' && aliases.has(item) ? aliases.get(item) : rewriteRepositoryReferences(item, aliases);
  return output as T;
}

export function migrationBackupPath(databasePath: string): string { return join(dirname(resolve(databasePath)), `${basename(databasePath)}.pre-local-repository-v1.bak`); }
