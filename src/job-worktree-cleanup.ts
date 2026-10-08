import type { Job } from './types.js';
import { cleanupCompletedJobWorktree } from './workspace.js';

/** Mechanical effect selected by job-lifecycle Graph on a completed PR. */
export async function cleanupMergedJobWorktree(
  job: Job,
  projectPathForJob?: (job: Job) => string | Promise<string>,
): Promise<void> {
  if (!projectPathForJob) throw new Error('No canonical project resolver for Worktree cleanup');
  const result = await cleanupCompletedJobWorktree(await projectPathForJob(job), job);
  // A blocked cleanup must be retried on a subsequent completed-Job reconcile.
  if (result.status === 'blocked') throw new Error(result.reason ?? 'Unsafe Worktree cleanup');
}
