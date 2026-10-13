import type { Job } from './types.js';

export type GitHubBindingCandidate = { snapshotPath: string; job: Job };

/** Fresh unbound ACTIVE jobs are highest priority; terminal projection debt is last. */
export function orderGitHubBindingCandidates(items: readonly GitHubBindingCandidate[]): GitHubBindingCandidate[] {
  return [...items].sort((a,b)=>score(a.job)-score(b.job) || a.job.createdAt.localeCompare(b.job.createdAt));
}
function score(job: Job): number {
  const bound=(job.prNumber)>0;
  const terminal=['COMPLETED','CANCELLED'].includes(job.state);
  if(!terminal && !bound) return 0;
  if(!terminal && bound) return 1;
  if(terminal && bound) return 2;
  return 3;
}
