import { execFileSync } from 'node:child_process';
import type { Job } from './types.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git',['-C',cwd,...args],{
    encoding:'utf8',timeout:120000,maxBuffer:1024*1024,
    env:{...process.env,GIT_TERMINAL_PROMPT:'0'},
  }).trim();
}
function branchRef(name: string): string {
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes('..') || name.endsWith('.lock'))
    throw new Error('Local merge projection requires explicit refs/heads/ target');
  return name;
}
function validSha(value: string | undefined, label: string): string {
  if (!value || !/^[0-9a-f]{40,64}$/.test(value)) throw new Error(`Local merge projection requires valid ${label} SHA`);
  return value;
}

/**
 * Publish SQLite-authoritative local main using a normal fast-forward push.
 * GitHub never performs a second merge. Divergence is retried only after
 * an operator or a separate Git synchronization workflow resolves it.
 */
export function projectAuthoritativeLocalMerge(repoPath: string, job: Job): {
  targetRef: string;
  localMergedCommitSha: string;
  remoteTargetSha: string;
  projectedCommitSha: string;
  status: 'already_projected' | 'projected';
} {
  const receipt=job.localMerge;
  if (job.state!=='COMPLETED' || receipt?.status!=='succeeded')
    throw new Error('Authoritative local merge projection requires COMPLETED Job with succeeded merge receipt');
  const targetRef=branchRef(receipt.targetRef);
  if (targetRef !== 'refs/heads/main') throw new Error('Local Git target must always be refs/heads/main');
  const sourceSha=validSha(receipt.sourceSha,'source');
  const mergedCommitSha=validSha(receipt.mergedCommitSha,'merged commit');
  const localTargetSha=git(repoPath,'rev-parse','--verify',targetRef);
  if (localTargetSha!==mergedCommitSha) {
    try { git(repoPath,'merge-base','--is-ancestor',mergedCommitSha,localTargetSha); }
    catch { throw new Error(`Local merge target ${targetRef} diverged after authoritative delivery for ${job.id}`); }
  }

  const branch=targetRef.slice('refs/heads/'.length);
  const remoteTracking=`refs/remotes/origin/${branch}`;
  git(repoPath,'fetch','--no-tags','origin',`+${targetRef}:${remoteTracking}`);
  const remoteTargetSha=git(repoPath,'rev-parse','--verify',remoteTracking);
  try {
    git(repoPath,'merge-base','--is-ancestor',localTargetSha,remoteTargetSha);
    return {targetRef,localMergedCommitSha:mergedCommitSha,remoteTargetSha,projectedCommitSha:remoteTargetSha,status:'already_projected'};
  } catch { /* remote projection required */ }

  // GitHub mirrors the SQLite-authoritative local main; it must never synthesize
  // a second merge or rewrite the tree when the remote has diverged.
  try {
    git(repoPath,'merge-base','--is-ancestor',remoteTargetSha,localTargetSha);
  } catch {
    throw new Error(`GitHub sync deferred: origin/${branch} diverged from authoritative local main; resolve the remote conflict without force push`);
  }
  git(repoPath,'push','origin',`${targetRef}:${targetRef}`);
  return {targetRef,localMergedCommitSha:mergedCommitSha,remoteTargetSha,projectedCommitSha:localTargetSha,status:'projected'};
}
