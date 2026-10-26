import { execFileSync } from 'node:child_process';
import { withLocalMergeLock } from './local-merge-lock.js';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Job } from './types.js';
import { implementationComplete } from './runtime-status.js';
import { completionGateSatisfied } from './task-transitions.js';

export type LocalMergeReceipt = {
  sourceRef: string; targetRef: string; status: 'pending' | 'failed' | 'succeeded';
  sourceSha?: string; mergedCommitSha?: string; projectionStrategy?: 'target_ref_push'; attempts?: number;
  error?: string; nextAttemptAt?: string; updatedAt?: string;
  correlationJobId?: string; displayPrNumber?: number;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}
function ref(name: string): string {
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.includes('..') || name.endsWith('.lock'))
    throw new Error('Local merge requires explicit refs/heads/ branch references');
  return name;
}
export function localWorkingHead(repoPath: string): string {
  return git(repoPath, 'rev-parse', '--verify', 'HEAD');
}
export function localSourceHead(repoPath: string, sourceRef: string): string {
  return git(repoPath, 'rev-parse', '--verify', ref(sourceRef));
}
export function requiresLocalGitMerge(job: Job): boolean {
  return Boolean(job.localMerge) || job.tasks.some(task => task.output?.kind === 'task_pr');
}
export function localMergeFacts(job: Job, headSha: string | null, now: () => number = Date.now): Readonly<Record<string, unknown>> {
  return {
    jobActive: job.state === 'ACTIVE',
    autoMergeEnabled: job.autoMerge !== false,
    implementationComplete: implementationComplete(job),
    completionGateSatisfied: completionGateSatisfied(job),
    reviewSatisfied: job.reviewEnabled === false || job.review?.outcome === 'approved',
    localMergeRequired: requiresLocalGitMerge(job),
    localMergeSucceeded: job.localMerge?.status === 'succeeded',
    localMergePresent: Boolean(job.localMerge),
    reviewHeadCurrent: job.reviewEnabled === false || job.review?.headSha === headSha,
    mergeAttemptReady: Boolean(job.localMerge && job.localMerge.status !== 'succeeded'
      && (!job.localMerge.nextAttemptAt || Date.parse(job.localMerge.nextAttemptAt) <= now())),
  };
}


export function localMergeCommitMessage(request: Pick<LocalMergeReceipt, 'correlationJobId'|'displayPrNumber'>, sourceSha: string): string {
  const lines = ['Agents Relay local merge', '', `Agents-Relay-Source-SHA: ${sourceSha}`];
  if (request.correlationJobId) lines.push(`Agents-Relay-Job: ${request.correlationJobId}`);
  if (Number.isInteger(request.displayPrNumber) && Number(request.displayPrNumber) > 0)
    lines.push(`Agents-Relay-Display-PR: ${request.displayPrNumber}`);
  return lines.join('\n');
}

function checkedOutTarget(repoPath: string, targetRef: string): string | null {
  const records = git(repoPath, 'worktree', 'list', '--porcelain').split(/\n\n/);
  const paths = records.filter(record => record.split('\n').includes('branch ' + targetRef))
    .map(record => record.split('\n').find(line => line.startsWith('worktree '))?.slice(9))
    .filter((path): path is string => Boolean(path));
  if (paths.length > 1) throw new Error('Local merge target has multiple checked-out worktrees');
  return paths[0] ?? null;
}

/** Merge a checked-out branch using Git porcelain so its worktree and index stay coherent. */
function mergeCheckedOutTarget(repoPath: string, targetRef: string, sourceSha: string, targetSha: string, message: string): string {
  const worktree = checkedOutTarget(repoPath, targetRef);
  if (!worktree) throw new Error('Target worktree disappeared before local merge');
  if (git(worktree, 'symbolic-ref', 'HEAD') !== targetRef
      || git(worktree, 'rev-parse', 'HEAD') !== targetSha) {
    throw new Error('Local merge target moved before delivery');
  }
  if (git(worktree, 'status', '--porcelain', '--untracked-files=no')) {
    throw new Error('Local merge target worktree has tracked or index changes');
  }
  if (existsSync(resolve(worktree, git(worktree, 'rev-parse', '--git-path', 'MERGE_HEAD')))) {
    throw new Error('Existing MERGE_HEAD is not owned by Relay; manual resolution required');
  }
  // No checkout, reset or force update. Git controls index and working tree,
  // reports conflicts and leaves a recoverable merge state when interrupted.
  try {
    git(worktree, 'merge', '--no-ff', '--no-edit', '-m', message, sourceSha);
  } catch (error) {
    // Only a MERGE_HEAD matching our exact source SHA can be attributed to
    // this delivery. Never abort a concurrent user's unrelated merge.
    const mergeHead = resolve(worktree, git(worktree, 'rev-parse', '--git-path', 'MERGE_HEAD'));
    if (existsSync(mergeHead)) {
      try {
        const mergeMessage = resolve(worktree, git(worktree, 'rev-parse', '--git-path', 'MERGE_MSG'));
        if (readFileSync(mergeHead, 'utf8').trim() === sourceSha
            && existsSync(mergeMessage)
            && readFileSync(mergeMessage, 'utf8').startsWith('Agents Relay local merge')
            && git(worktree, 'rev-parse', 'HEAD') === targetSha) {
          git(worktree, 'merge', '--abort');
        }
      } catch { /* Leave unidentified merge state for manual resolution. */ }
    }
    throw error;
  }
  const result = git(worktree, 'rev-parse', 'HEAD');
  const parents = git(worktree, 'rev-list', '--parents', '-n', '1', result).split(' ');
  if (parents[1] !== targetSha || parents[2] !== sourceSha) {
    throw new Error('Unexpected local merge commit parentage; manual verification required');
  }
  return result;
}

/** Deliver to a Git ref without ever updating a checked-out ref behind Git's back. */
export function deliverLocalMerge(repoPath: string, request: LocalMergeReceipt): { sourceSha: string; mergedCommitSha: string } {
  const sourceRef = ref(request.sourceRef), targetRef = ref(request.targetRef);
  if (targetRef !== 'refs/heads/main') throw new Error('Local Git merge target must always be refs/heads/main');
  if (sourceRef === targetRef) throw new Error('Local merge source and target must differ');
  const commonDir = resolve(repoPath, git(repoPath, 'rev-parse', '--git-common-dir'));
  return withLocalMergeLock(commonDir, targetRef, () => {
  const sourceSha = localSourceHead(repoPath, sourceRef);
  if (request.sourceSha && sourceSha !== request.sourceSha) throw new Error('Local merge source SHA changed after review');
  const targetSha = git(repoPath, 'rev-parse', '--verify', targetRef);
  try {
    git(repoPath, 'merge-base', '--is-ancestor', sourceSha, targetSha);
    return { sourceSha, mergedCommitSha: targetSha }; // Idempotent after acknowledged or crashed delivery.
  } catch { /* merge required */ }
  const message = localMergeCommitMessage(request, sourceSha);
  if (checkedOutTarget(repoPath, targetRef)) {
    return { sourceSha, mergedCommitSha: mergeCheckedOutTarget(repoPath, targetRef, sourceSha, targetSha, message) };
  }
  // Unchecked-out refs can be updated atomically without touching any worktree.
  const tree = git(repoPath, 'merge-tree', '--write-tree', targetSha, sourceSha).split('\n')[0];
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error('Local merge-tree returned no valid tree');
  const mergedCommitSha = git(repoPath, 'commit-tree', tree, '-p', targetSha, '-p', sourceSha, '-m', message);
  git(repoPath, 'update-ref', targetRef, mergedCommitSha, targetSha);
  return { sourceSha, mergedCommitSha };
  });
}
