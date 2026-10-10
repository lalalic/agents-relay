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
 * Project an already-authoritative local merge to origin without asking the
 * remote forge to make a second merge decision and without rewriting local
 * history. If origin/main has drifted from local main, synthesize a remote-only
 * merge commit whose tree is exactly the authoritative local merged tree and
 * whose parents are current origin/main + the reviewed source head. The push is
 * therefore a normal remote fast-forward and makes the PR head an ancestor of
 * the remote target.
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
  const sourceSha=validSha(receipt.sourceSha,'source');
  const mergedCommitSha=validSha(receipt.mergedCommitSha,'merged commit');
  const localTargetSha=git(repoPath,'rev-parse','--verify',targetRef);
  if (localTargetSha!==mergedCommitSha)
    throw new Error(`Local merge target ${targetRef} moved after authoritative delivery for ${job.id}`);

  const branch=targetRef.slice('refs/heads/'.length);
  const remoteTracking=`refs/remotes/origin/${branch}`;
  git(repoPath,'fetch','--no-tags','origin',`+${targetRef}:${remoteTracking}`);
  const remoteTargetSha=git(repoPath,'rev-parse','--verify',remoteTracking);
  try {
    git(repoPath,'merge-base','--is-ancestor',sourceSha,remoteTargetSha);
    return {targetRef,localMergedCommitSha:mergedCommitSha,remoteTargetSha,projectedCommitSha:remoteTargetSha,status:'already_projected'};
  } catch { /* remote projection required */ }

  const authoritativeTree=git(repoPath,'rev-parse',`${mergedCommitSha}^{tree}`);
  const projectedCommitSha=git(repoPath,'commit-tree',authoritativeTree,
    '-p',remoteTargetSha,'-p',sourceSha,'-m','Agents Relay external projection merge');
  git(repoPath,'push','origin',`${projectedCommitSha}:${targetRef}`);
  return {targetRef,localMergedCommitSha:mergedCommitSha,remoteTargetSha,projectedCommitSha,status:'projected'};
}
