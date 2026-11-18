import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import type { Job, Task } from './types.js';
import { isFinalReviewAgent } from './final-review-role.js';

const SHA = /^[a-f0-9]{40,64}$/i;
const SOURCE_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Source delivery policy is fixed when the Task is created, not inferred from event data. */
export function sourceCommitRequired(task: Pick<Task, 'kind' | 'agentName' | 'agentGraph' | 'output'>): boolean {
  return task.output?.kind === 'task_pr' && task.kind !== 'planner' && !task.agentGraph
    && !isFinalReviewAgent(task.agentName)
    && !['troubleshooter', 'planner', 'review-chair'].includes(task.agentName ?? '');
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 8000,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }).trim();
}

function root(job: Job): string {
  if (!job.projectRoot || !job.repository) throw new Error('Git delivery requires a canonical Job projectRoot');
  const path = realpathSync(job.projectRoot);
  if (realpathSync(git(path, 'rev-parse', '--show-toplevel')) !== path) throw new Error('Git delivery projectRoot is not the canonical Git root');
  return path;
}

function ref(job: Job): string {
  const value = job.localMerge?.sourceRef;
  if (!value || !SOURCE_REF.test(value) || value.includes('..') || value.endsWith('.lock'))
    throw new Error('Git delivery requires a configured local Job source branch');
  return value;
}

/** Read-only Git facts; event senders cannot select a different repository or branch. */
export function sourceCommitSha(job: Job): string {
  return git(root(job), 'rev-parse', '--verify', `${ref(job)}^{commit}`);
}

/** Snapshot the source head before any Worker's code edits; persist it with this execution. */
export function startedSourceBaseline(job: Job, taskId: string): string | null {
  const task = job.tasks.find(item => item.id === taskId);
  return task?.gitDeliveryRequired ? sourceCommitSha(job) : null;
}
export function bindSourceBaseline(task: Task, sha: string | null): void {
  if (task.gitDeliveryRequired && sha && task.executionId) {
    task.gitDeliveryBaseline = { executionId: task.executionId, sha };
    task.gitDelivery = undefined;
  }
}

function ownedWorktree(job: Job): string {
  const project = root(job);
  const wanted = ref(job);
  const matches = git(project, 'worktree', 'list', '--porcelain').split(/\n\s*\n/).filter(Boolean)
    .map(record => {
      const lines = record.split('\n');
      return { path: lines.find(line => line.startsWith('worktree '))?.slice(9),
        branch: lines.find(line => line.startsWith('branch '))?.slice(7) };
    }).filter(item => item.branch === wanted && item.path);
  if (matches.length !== 1) throw new Error('Git delivery requires exactly one checked-out source branch worktree');
  const path = realpathSync(matches[0].path!);
  if (git(path, 'symbolic-ref', 'HEAD') !== wanted) throw new Error('Git delivery branch changed');
  return path;
}

export type GitDeliveryReceipt = { executionId: string; baseSha: string; commitSha: string; worktree: string; verifiedAt: string };

/** Validate exact execution/branch binding, a new nonempty commit and a fully clean source worktree. */
export function verifySourceCommit(job: Job, task: Task, executionId: string, commitSha: string): GitDeliveryReceipt {
  if (!task.gitDeliveryRequired || task.state !== 'RUNNING' || task.executionId !== executionId)
    throw new Error('Git delivery requires an active source Task execution');
  const baseline = task.gitDeliveryBaseline;
  if (!baseline || baseline.executionId !== executionId || !SHA.test(baseline.sha))
    throw new Error('Git delivery is missing the current execution start baseline');
  if (!SHA.test(commitSha)) throw new Error('Git delivery requires a full commit SHA');
  const actual = sourceCommitSha(job);
  if (commitSha === baseline.sha) throw new Error('Git delivery requires a new committed source branch HEAD');
  const path = ownedWorktree(job);
  if (git(path, 'rev-parse', '--verify', 'HEAD') !== actual) throw new Error('Git delivery source worktree HEAD differs from branch');
  if (git(path, 'status', '--porcelain=v1', '--untracked-files=all'))
    throw new Error('Git delivery source worktree has uncommitted or untracked changes');
  try { git(path, 'merge-base', '--is-ancestor', baseline.sha, commitSha); }
  catch { throw new Error('Git delivery commit does not descend from execution baseline'); }
  try { git(path, 'merge-base', '--is-ancestor', commitSha, actual); }
  catch { throw new Error('Git delivery commit is not on the current Job source branch'); }
  // An unrelated Worker may advance Job HEAD after this Worker commits.
  // Verify the Task-owned commit itself, not the newest commit by another Worker.
  const message = git(path, 'log', '-1', '--format=%B', commitSha).split('\n').map(line => line.trim());
  if (!message.includes(`Relay-Task: ${task.id}`) || !message.includes(`Relay-Execution: ${executionId}`))
    throw new Error('Git delivery commit must contain exact Relay-Task and Relay-Execution trailers');
  if (!git(path, 'diff-tree', '--no-commit-id', '--name-only', '-r', commitSha))
    throw new Error('Git delivery requires a nonempty code commit');
  return { executionId, baseSha: baseline.sha, commitSha, worktree: path, verifiedAt: new Date().toISOString() };
}

/** Persisted proof alone is never sufficient: validate live Git again on every terminal ingress. */
export function sourceCompletionVerified(job: Job, task: Task, executionId: string | null): boolean {
  if (!task.gitDeliveryRequired) return true;
  if (!executionId || task.gitDelivery?.executionId !== executionId) return false;
  try {
    const current = verifySourceCommit(job, task, executionId, task.gitDelivery.commitSha);
    return current.baseSha === task.gitDelivery.baseSha && current.worktree === task.gitDelivery.worktree;
  } catch { return false; }
}
