import { DatabaseSync, backup } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const META_KEY = 'task_id_numeric_migration';
const REFERENCES = new Set([
  'taskId', 'task_id', 'parentTaskId', 'parent_task_id', 'originalTaskId',
  'targetTaskId', 'recoveryTaskId', 'reviewTaskId', 'revisionTaskId', 'coordinatorTaskId',
]);
const ID_LISTS = new Set(['dependencies', 'generatedTaskIds', 'restateTaskIds']);
const ID_KEYED_OBJECTS = new Set(['dependencyValidity', 'dependencyVector']);

function rewriteJson(value: unknown, ids: Map<string, string>, parentKey = '', taskRecord = false): unknown {
  if (typeof value === 'string' && parentKey === 'input' && value.trim().startsWith('{')) {
    try { return JSON.stringify(rewriteJson(JSON.parse(value), ids)); } catch { return value; }
  }
  if (Array.isArray(value)) {
    return value.map(item => ID_LISTS.has(parentKey) && typeof item === 'string'
      ? ids.get(item) ?? item : rewriteJson(item, ids));
  }
  if (!value || typeof value !== 'object') {
    if ((REFERENCES.has(parentKey) || parentKey === 'nodes') && typeof value === 'string')
      return ids.get(value) ?? value;
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const rewrittenKey = ID_KEYED_OBJECTS.has(parentKey) ? ids.get(key) ?? key : key;
    if ((taskRecord && key === 'id') || REFERENCES.has(key) || (parentKey === 'nodes' && typeof item === 'string')) {
      output[rewrittenKey] = typeof item === 'string' ? ids.get(item) ?? item : item;
    } else if (key === 'tasks' || key === 'next_tasks') {
      output[rewrittenKey] = Array.isArray(item)
        ? item.map(task => rewriteJson(task, ids, '', true)) : item;
    } else if (parentKey === 'dependencyVector' && typeof item === 'string') {
      const separator = item.indexOf(':');
      output[rewrittenKey] = separator >= 0 && ids.has(item.slice(0, separator))
        ? ids.get(item.slice(0, separator)) + item.slice(separator) : item;
    } else if (key === 'value' && item && typeof item === 'object' && !Array.isArray(item)
      && 'jobId' in item && 'dependencies' in item && 'parentTaskId' in item) {
      output[rewrittenKey] = rewriteJson(item, ids, key, true);
    } else {
      output[rewrittenKey] = rewriteJson(item, ids, key);
    }
  }
  return output;
}

/** Explicit one-time offline migration. Caller must stop Relay writers first.
 * A verified SQLite backup precedes the single atomic transaction. */
export async function migrateTaskIds(databasePath: string, backupPath: string): Promise<{
  backupPath: string; taskCount: number; duplicateTaskRecords: number; maxId: number; alreadyMigrated: boolean;
}> {
  const target = resolve(databasePath), backupFile = resolve(backupPath);
  if (target === backupFile) throw new Error('Backup path must differ from database path');
  const db = new DatabaseSync(target);
  try {
    db.exec('PRAGMA busy_timeout=10000');
    const marker = db.prepare("SELECT value FROM migration_metadata WHERE key=?").get(META_KEY) as {value:string}|undefined;
    const existing = db.prepare('SELECT job_id,json FROM job_snapshot').all() as Array<{job_id:string;json:string}>;
    for (const row of existing) {
      const job = JSON.parse(row.json) as {state?:string};
      if (job.state === 'ACTIVE') throw new Error('Preflight failed: Job ' + row.job_id + ' is ACTIVE');
    }
    const currentSeq = Number((db.prepare("SELECT value FROM sequences WHERE repository='*' AND kind='task'").get() as {value:number}|undefined)?.value ?? 0);
    if (marker?.value === 'complete')
      return {backupPath:backupFile, taskCount:0, duplicateTaskRecords:0, maxId:currentSeq, alreadyMigrated:true};
    if (existsSync(backupFile)) throw new Error('Backup already exists: ' + backupFile);
    mkdirSync(dirname(backupFile), {recursive:true});
    await backup(db, backupFile);
    const copy = new DatabaseSync(backupFile, {readOnly:true});
    try {
      const integrity = copy.prepare('PRAGMA integrity_check').get() as Record<string,string>;
      if (Object.values(integrity)[0] !== 'ok') throw new Error('Migration backup failed integrity_check');
      if (Number((copy.prepare('SELECT COUNT(*) AS n FROM job_snapshot').get() as {n:number}).n) !== existing.length)
        throw new Error('Migration backup Job count mismatch');
    } finally {copy.close();}
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = db.prepare('SELECT job_id,json FROM job_snapshot ORDER BY CAST(job_id AS INTEGER),job_id').all() as Array<{job_id:string;json:string}>;
      if (rows.length !== existing.length || rows.some((row,index) => {
        const previous = existing.find(item => item.job_id === row.job_id);
        return !previous || previous.json !== row.json;
      })) throw new Error('Job data changed after backup; migration refused');

      const mappings = new Map<string, Map<string,string>>();
      const assigned = new Map<string,string[]>();
      let taskCount = 0, duplicateTaskRecords = 0;
      for (const row of rows) {
        const tasks = (JSON.parse(row.json) as {tasks:Array<{id:string}>}).tasks ?? [];
        const aliases = new Map<string,string>(), individual: string[] = [];
        for (const task of tasks) {
          if (!task.id || typeof task.id !== 'string') throw new Error('Invalid Task ID in Job ' + row.job_id);
          const id = String(++taskCount);
          individual.push(id);
          if (aliases.has(task.id)) duplicateTaskRecords++;
          else aliases.set(task.id,id);
        }
        mappings.set(row.job_id,aliases); assigned.set(row.job_id, individual);
      }
      // Historical Job 90 has five duplicate Planner records. Preserve every
      // record with a distinct new ID; legacy ambiguous references point to
      // the first chronological owner, never to an invented Task.
      const updateJob = db.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?');
      for (const row of rows) {
        const aliases = mappings.get(row.job_id)!;
        const job = rewriteJson(JSON.parse(row.json),aliases) as {tasks:Array<{id:string;title?:string;agentName?:string;agentGraph?:string;parentTaskId?:string|null}>};
        job.tasks.forEach((task,index) => {
          task.id = assigned.get(row.job_id)![index];
          if (task.parentTaskId === 'orchestrator') task.parentTaskId = null;
          if (task.agentGraph) task.title = 'Coordinator';
          else if (task.agentName === 'troubleshooter') task.title = 'Troubleshooter';
          else if (task.agentName === 'job-acceptance-reviewer' || task.agentName === 'reviewer') task.title = 'Final review';
          else if ((task as {dagNode?:unknown}).dagNode && task.agentName) task.title = task.agentName;
        });
        updateJob.run(JSON.stringify(job),row.job_id);
      }
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>;
      for (const {name} of tables) {
        const escaped = '"' + name.replaceAll('"','""') + '"';
        const columns = db.prepare('PRAGMA table_info(' + escaped + ')').all() as Array<{name:string}>;
        const names = new Set(columns.map(column=>column.name));
        const jobColumn = names.has('job_id') ? 'job_id' : names.has('scope_job_id') ? 'scope_job_id' : null;
        if (!jobColumn || name === 'job_snapshot') continue;
        // Update foreign Task IDs without intermediate UNIQUE/PK collisions.
        if (names.has('task_id')) {
          const rows = db.prepare('SELECT rowid,' + jobColumn + ' AS owner,task_id FROM '+escaped).all() as Array<{rowid:number;owner:string;task_id:string}>;
          const update = db.prepare('UPDATE '+escaped+' SET task_id=? WHERE rowid=?');
          const changed = rows.filter(row => mappings.get(row.owner)?.has(row.task_id));
          for (const row of changed) update.run('__task_id_migration_'+row.rowid+'__',row.rowid);
          for (const row of changed) update.run(mappings.get(row.owner)!.get(row.task_id)!,row.rowid);
        }
        for (const column of columns.filter(column => column.name === 'json' || column.name.endsWith('_json'))) {
          const field = '"' + column.name.replaceAll('"','""') + '"';
          const records = db.prepare('SELECT rowid,'+jobColumn+' AS owner,'+field+' AS payload FROM '+escaped+' WHERE '+field+' IS NOT NULL').all() as Array<{rowid:number;owner:string;payload:string}>;
          const update = db.prepare('UPDATE '+escaped+' SET '+field+'=? WHERE rowid=?');
          for (const record of records) {
            const ids = mappings.get(record.owner);
            if (!ids) continue;
            let parsed:unknown;
            try {parsed=JSON.parse(record.payload);} catch {continue;}
            const changed = JSON.stringify(rewriteJson(parsed,ids));
            if (changed !== record.payload) update.run(changed,record.rowid);
          }
        }
      }
      // Workflow event outbox has no job_id column. Correlate each event's own
      // durable job_id before rewriting its structured Task references.
      if (tables.some(table=>table.name==='workflow_event_outbox')) {
        const events=db.prepare('SELECT rowid,payload_json FROM workflow_event_outbox').all() as Array<{rowid:number;payload_json:string}>;
        const update=db.prepare('UPDATE workflow_event_outbox SET payload_json=? WHERE rowid=?');
        for (const row of events) {
          let event:unknown; try {event=JSON.parse(row.payload_json);} catch {continue;}
          const jobId=(event as {job_id?:string})?.job_id;
          const ids=jobId ? mappings.get(jobId):undefined;
          if (!ids) continue;
          const payload=JSON.stringify(rewriteJson(event,ids));
          if (payload!==row.payload_json) update.run(payload,row.rowid);
        }
      }
      // Old idempotency reservations may refer to Tasks that were deleted.
      // Never allow such a reservation to resurrect an unknown numeric ID.
      if (tables.some(table => table.name === 'idempotency')) {
        const items = db.prepare("SELECT rowid,request_key,entity_id FROM idempotency WHERE kind='task'").all() as Array<{rowid:number;request_key:string;entity_id:string}>;
        const update = db.prepare('UPDATE idempotency SET entity_id=? WHERE rowid=?');
        const remove = db.prepare('DELETE FROM idempotency WHERE rowid=?');
        for (const row of items) {
          const candidates = [...mappings].filter(([,map]) => map.has(row.entity_id))
            .map(([jobId,map]) => ({jobId,id:map.get(row.entity_id)!}));
          const resolved = candidates.length === 1 ? candidates[0] :
            candidates.find(candidate => row.request_key.includes(':'+candidate.jobId+':'));
          if (resolved) update.run(resolved.id,row.rowid); else remove.run(row.rowid);
        }
      }
      const next = Math.max(taskCount,currentSeq);
      db.prepare("INSERT INTO sequences(repository,kind,value) VALUES('*','task',?) ON CONFLICT(repository,kind) DO UPDATE SET value=excluded.value").run(next);
      db.prepare("INSERT INTO migration_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(META_KEY,'complete');
      db.exec('COMMIT');
      return {backupPath:backupFile,taskCount,duplicateTaskRecords,maxId:next,alreadyMigrated:false};
    } catch (error) {db.exec('ROLLBACK'); throw error;}
  } finally {db.close();}
}
