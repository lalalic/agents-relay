import { readFile } from 'node:fs/promises';
import { arg, hasArg } from './cli-support.js';
import type { TaskResolutionClassification } from './workflow/task-resolution.js';

export async function cleanHistoryOption(args: readonly string[]): Promise<Array<TaskResolutionClassification & { taskId: string }> | undefined> {
  const force = hasArg([...args], '--force-clean-history');
  const path = arg([...args], '--clean-history-file');
  if (!force && path) throw new Error('--clean-history-file requires --force-clean-history');
  if (force && !path) throw new Error('--force-clean-history requires --clean-history-file with one classification per FAILED Task');
  if (!path) return undefined;
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('--clean-history-file must contain a JSON array of classification objects');
  return value as Array<TaskResolutionClassification & { taskId: string }>;
}
