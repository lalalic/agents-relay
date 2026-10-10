import type { Job } from './types.js';

export function configureLocalGitMerge(job: Job, source: string, target: string, localOnly: boolean): void {
  // The GitHub integration is observational; local merge applies in either mode.
  void localOnly;
  if (!source) throw new Error('Local merge source is required');
  if (target !== 'refs/heads/main') throw new Error('Local Git merge target must always be refs/heads/main');
  if (!['ACTIVE', 'DRAFT'].includes(job.state)) throw new Error('Cannot reconfigure merge of a terminal Job');
  job.localMerge = { sourceRef: source, targetRef: target, status: 'pending' };
}
