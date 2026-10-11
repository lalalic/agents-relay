import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function generatedEntityPrefix(repository: string, kind: 'job' | 'task'): string {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo) || owner === '..' || repo === '..') throw new Error('Invalid repository');
  return `${kind === 'job' ? 'j' : 't'}-${owner.length}-${owner}-${repo}-`;
}

export function isGeneratedEntityId(id: string, repository: string, kind: 'job' | 'task'): boolean {
  const prefix = generatedEntityPrefix(repository, kind);
  return id.startsWith(prefix) && /^[0-9]+$/.test(id.slice(prefix.length));
}

/** Repository-scoped, monotonically increasing IDs. Allocation is serialized by SQLite. */
export function allocateEntityId(directory: string, repository: string, kind: 'job'|'task', requestKey?: string, occupied: ReadonlySet<string> = new Set()): string {
  const prefix = generatedEntityPrefix(repository, kind);
  if (requestKey !== undefined && (!requestKey || requestKey.length > 512)) throw new Error('Invalid idempotency key');
  mkdirSync(directory,{recursive:true});
  const db = new DatabaseSync(join(directory,'entity-id-sequences.sqlite'));
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;');
    db.exec('CREATE TABLE IF NOT EXISTS sequences (repository TEXT NOT NULL, kind TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(repository,kind)); CREATE TABLE IF NOT EXISTS idempotency (repository TEXT NOT NULL, kind TEXT NOT NULL, request_key TEXT NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY(repository,kind,request_key));');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (requestKey) {
        const row=db.prepare('SELECT entity_id FROM idempotency WHERE repository=? AND kind=? AND request_key=?').get(repository,kind,requestKey) as {entity_id:string}|undefined;
        if(row){db.exec('COMMIT');return row.entity_id;}
      }
      const old=db.prepare('SELECT value FROM sequences WHERE repository=? AND kind=?').get(repository,kind) as {value:number}|undefined;
      let next=(old?.value??0)+1;
      while (occupied.has(prefix + next)) next++;
      db.prepare('INSERT INTO sequences VALUES (?,?,?) ON CONFLICT(repository,kind) DO UPDATE SET value=excluded.value').run(repository,kind,next);
      // Length prefix keeps repository names unambiguous while satisfying dashboard ID validation.
      const id=prefix+next;
      if(requestKey) db.prepare('INSERT INTO idempotency VALUES (?,?,?,?)').run(repository,kind,requestKey,id);
      db.exec('COMMIT'); return id;
    } catch(error){db.exec('ROLLBACK');throw error;}
  } finally {db.close();}
}
