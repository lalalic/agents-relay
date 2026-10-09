import type { Job } from './types.js';

export function configureLocalGitMerge(job: Job, source: string, target: string, localOnly: boolean): void {
  // The GitHub integration is observational; local merge applies in either mode.
  void localOnly;
  if (!source || !target) throw new Error('Supply both --local-merge-source and --local-merge-target');
  if (!['ACTIVE', 'DRAFT'].includes(job.state)) throw new Error('Cannot reconfigure merge of a terminal Job');
  job.localMerge = { sourceRef: source, targetRef: target, status: 'pending' };
}
