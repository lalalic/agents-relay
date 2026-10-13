import type { DatabaseSync } from 'node:sqlite';
import type { Job } from './types.js';
import { deriveTaskTitle } from './task-title.js';

export function normalizeLegacyJobPrNumber(input: Job): Job {
  const record = input as Job & Record<string, unknown>;
  const legacyKey = 'external' + 'PrNumber';
  const legacy = record[legacyKey];
  if ((!Number.isInteger(input.prNumber) || input.prNumber <= 0) && Number.isInteger(legacy) && Number(legacy) > 0) input.prNumber = Number(legacy);
  delete record[legacyKey];
  for (const task of input.tasks ?? []) {
    if (!task.title?.trim()) task.title = deriveTaskTitle(task.input, task.agentName ? `${task.agentName} task` : 'Task');
  }
  return input;
}

export function migrateLegacyJobPrNumbers(db: DatabaseSync): void {
  const rows = db.prepare('SELECT job_id,json FROM job_snapshot').all() as Array<{ job_id: string; json: string }>;
  const update = db.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?');
  for (const row of rows) {
    const normalized = normalizeLegacyJobPrNumber(JSON.parse(row.json) as Job);
    const json = JSON.stringify(normalized);
    if (json !== row.json) update.run(json, row.job_id);
  }
}
