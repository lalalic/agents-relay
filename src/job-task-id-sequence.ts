import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function generatedEntityPrefix(repository: string, kind: 'job' | 'task'): string {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo) || owner === '..' || repo === '..') throw new Error('Invalid repository');
  return `${kind === 'job' ? 'j' : 't'}-${owner.length}-${owner}-${repo}-`;
}

export function isGeneratedEntityId(id: string, repository: string, kind: 'job' | 'task'): boolean {
  if (kind === 'task') {
    if (/^[1-9][0-9]*$/.test(id)) return true;
    const legacyPrefix = generatedEntityPrefix(repository, kind);
    return id.startsWith(legacyPrefix) && /^[0-9]+$/.test(id.slice(legacyPrefix.length));
  }
  if (/^[1-9][0-9]*$/.test(id)) return true;
  const prefix = generatedEntityPrefix(repository, kind);
  return id.startsWith(prefix) && /^[0-9]+$/.test(id.slice(prefix.length));
}


/** Job and Task IDs each use their own store-global sequence. SQLite serializes allocation; legacy identifiers remain readable. */
export function allocateEntityId(directory: string, repository: string, kind: 'job'|'task', requestKey?: string, occupied: ReadonlySet<string> = new Set()): string {
  generatedEntityPrefix(repository, kind); // validate repository even though its name no longer appears in the ID
  const prefix = '';
  const scope = '*';
  const scopedRequestKey = requestKey ? `${repository}:${requestKey}` : undefined;
  if (requestKey !== undefined && (!requestKey || requestKey.length > 512)) throw new Error('Invalid idempotency key');
  mkdirSync(directory,{recursive:true});
  const db = new DatabaseSync(join(directory,'entity-id-sequences.sqlite'));
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;');
    db.exec('CREATE TABLE IF NOT EXISTS sequences (repository TEXT NOT NULL, kind TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(repository,kind)); CREATE TABLE IF NOT EXISTS idempotency (repository TEXT NOT NULL, kind TEXT NOT NULL, request_key TEXT NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY(repository,kind,request_key));');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (scopedRequestKey) {
        const row=db.prepare('SELECT entity_id FROM idempotency WHERE repository=? AND kind=? AND request_key=?').get(scope,kind,scopedRequestKey) as {entity_id:string}|undefined;
        if(row){db.exec('COMMIT');return row.entity_id;}
      }
      const old=db.prepare('SELECT value FROM sequences WHERE repository=? AND kind=?').get(scope,kind) as {value:number}|undefined;
      // Existing generated numeric IDs across all repositories are reserved by the caller.
      let next=(old?.value??0)+1;
      while (occupied.has(prefix + next)) next++;
      db.prepare('INSERT INTO sequences VALUES (?,?,?) ON CONFLICT(repository,kind) DO UPDATE SET value=excluded.value').run(scope,kind,next);
      const id=prefix+next;
      if(scopedRequestKey) db.prepare('INSERT INTO idempotency VALUES (?,?,?,?)').run(scope,kind,scopedRequestKey,id);
      db.exec('COMMIT'); return id;
    } catch(error){db.exec('ROLLBACK');throw error;}
  } finally {db.close();}
}
