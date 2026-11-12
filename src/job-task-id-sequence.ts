import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { relayUnifiedStorePath } from './relay-store-discovery.js';

/** All durable Job and Task IDs are positive decimal strings. */
export function isGeneratedEntityId(id: string, _repository: string, _kind: 'job' | 'task'): boolean {
  return /^[1-9][0-9]*$/.test(id);
}

/** Job and Task IDs each use their own store-global sequence. SQLite serializes allocation. */
export function allocateEntityId(directory: string, repository: string, kind: 'job'|'task', requestKey?: string, occupied: ReadonlySet<string> = new Set()): string {
  if(!repository)throw new Error('Task ID allocation requires a repository context');
  const prefix = '';
  const scope = '*';
  const scopedRequestKey = requestKey ? (kind === 'task' ? requestKey : `${repository}:${requestKey}`) : undefined;
  if (requestKey !== undefined && (!requestKey || requestKey.length > 512)) throw new Error('Invalid idempotency key');
  mkdirSync(directory,{recursive:true});
  const db = new DatabaseSync(relayUnifiedStorePath(directory));
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
      const hasSnapshots=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_snapshot'").get()!==undefined;
      const snapshots=hasSnapshots?db.prepare('SELECT json FROM job_snapshot').all() as Array<{json:string}>:[];
      let storedMax=0;
      for(const {json} of snapshots){try{const value=JSON.parse(json) as {id?:string;tasks?:Array<{id?:string}>};
        for(const id of kind==='job'?[value.id]:value.tasks?.map(task=>task.id)??[]){if(id&&/^[1-9][0-9]*$/.test(id))storedMax=Math.max(storedMax,Number(id));}
      }catch{/* Corrupt snapshots are rejected by normal store reads. */}}
      let next=Math.max(old?.value??0,storedMax)+1;
      while (occupied.has(prefix + next)) next++;
      db.prepare('INSERT INTO sequences VALUES (?,?,?) ON CONFLICT(repository,kind) DO UPDATE SET value=excluded.value').run(scope,kind,next);
      const id=prefix+next;
      if(scopedRequestKey) db.prepare('INSERT INTO idempotency VALUES (?,?,?,?)').run(scope,kind,scopedRequestKey,id);
      db.exec('COMMIT'); return id;
    } catch(error){db.exec('ROLLBACK');throw error;}
  } finally {db.close();}
}
