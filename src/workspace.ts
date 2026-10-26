import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Job, Task } from './types.js';
import { spawnOwnedProcess } from './owned-process.js';

async function gitOutput(args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawnOwnedProcess('git', args, { invocation: 'workspace.git', spawn: { stdio: ['ignore', 'pipe', 'pipe'] } });
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `git exited ${code}`)));
  });
}

export type DiscoveredRepository = { path: string; repository: string };

export function defaultWorkspaceRoot(): string {
  return join(homedir(), 'Workspace');
}

export function githubRepositoryFromRemote(remote: string): string | null {
  const value = remote.trim().replace(/\.git$/, '');
  const match = value.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

async function hasGitDirectory(path: string): Promise<boolean> {
  try { await stat(join(path, '.git')); return true; } catch { return false; }
}

export async function discoverGitRepositories(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    if (await hasGitDirectory(directory)) { found.push(directory); return; }
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.filter(entry => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')).map(entry => visit(join(directory, entry.name))));
  };
  await visit(resolve(root));
  return found.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
}

async function origin(path: string): Promise<string | null> {
  try { return (await gitOutput(['-C', path, 'remote', 'get-url', 'origin'])).trim() || null; } catch { return null; }
}

export async function discoverWorkspaceRepositories(root: string): Promise<DiscoveredRepository[]> {
  const paths = await discoverGitRepositories(root);
  const discovered = await Promise.all(paths.map(async path => {
    const repository = githubRepositoryFromRemote(await origin(path) ?? '');
    return repository ? { path, repository } : null;
  }));
  const unique = new Map<string, DiscoveredRepository>();
  for (const item of discovered) {
    if (!item) continue;
    const current = unique.get(item.repository);
    if (!current || repositoryPathRank(item.path, root) < repositoryPathRank(current.path, root)) unique.set(item.repository, item);
  }
  return [...unique.values()].sort((a, b) => a.repository.localeCompare(b.repository));
}


export async function resolveWorkspaceRepositoryPath(repository: string, root = defaultWorkspaceRoot()): Promise<string> {
  const match = (await discoverWorkspaceRepositories(root)).find(item => item.repository === repository);
  if (!match) throw new Error(`Repository ${repository} not found under workspace ${resolve(root)}; pass --project-path explicitly`);
  return match.path;
}

export async function resolveManagedProjectPath(repository: string | undefined, explicitProjectPath = '', root = defaultWorkspaceRoot(), cwd = process.cwd()): Promise<string> {
  if (explicitProjectPath) return resolve(explicitProjectPath);
  return repository ? resolveWorkspaceRepositoryPath(repository, root) : resolve(cwd);
}

export function resolveRepositoryProjectPath(repositoryRoot: string, projectPath?: string): string {
  const root = resolve(repositoryRoot);
  if (!projectPath) return root;
  if (isAbsolute(projectPath)) throw new Error('Job projectPath must be repository-relative');
  // Legacy Jobs sometimes stored the repository folder name itself (for example
  // projectPath='agents-relay' for the agents-relay repository). Interpret that
  // historical form as the repository root instead of appending it twice.
  if (projectPath === basename(root)) return root;
  const target = resolve(root, projectPath);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Job projectPath escapes repository root');
  return target;
}

export function isProjectRunPath(path: string | undefined): boolean {
  if (!path) return false;
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized === 'runs' || normalized.startsWith('runs/');
}

export function taskUsesCanonicalProjectRun(task: Task, tasks: Task[]): boolean {
  const byId = new Map(tasks.map(item => [item.id, item]));
  const seen = new Set<string>();
  let current: Task | undefined = task;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.output?.kind === 'file' && isProjectRunPath(current.output.path)) return true;
    current = current.parentTaskId ? byId.get(current.parentTaskId) : undefined;
  }
  return false;
}

async function git(path: string, args: string[]): Promise<string> {
  return (await gitOutput(['-C', path, ...args])).trim();
}

export type ManagedPullRequestHead = { ref: string; sha: string };

export async function prepareManagedExecutionWorktree(
  projectPath: string,
  repository: string,
  prNumber: number,
  head: ManagedPullRequestHead,
  _executionId: string,
  workspaceRoot = defaultWorkspaceRoot(),
): Promise<string> {
  const primary = await git(projectPath, ['rev-parse', '--show-toplevel']);
  const projectRelative = (await git(projectPath, ['rev-parse', '--show-prefix'])).replace(/\/$/, '');
  const remote = await git(primary, ['config', '--get', 'remote.origin.url']);
  if (githubRepositoryFromRemote(remote) !== repository) throw new Error(`Primary checkout ${primary} does not match ${repository}`);
  await git(primary, ['fetch', 'origin', `refs/heads/${head.ref}:refs/remotes/origin/${head.ref}`]);
  const fetched = await git(primary, ['rev-parse', `refs/remotes/origin/${head.ref}`]);
  if (fetched !== head.sha) throw new Error(`PR #${prNumber} head changed while preparing execution checkout (${head.sha} -> ${fetched})`);

  const safeRepo = repository.replace(/[^A-Za-z0-9_.-]+/g, '-');
  // One stable checkout per Job; retries and reviewers share the same directory.
  const worktree = managedJobWorktreePath(repository, prNumber, workspaceRoot);
  await mkdir(dirname(worktree), { recursive: true });
  try {
    const existingRoot = await git(worktree, ['rev-parse', '--show-toplevel']);
    const existingHead = await git(worktree, ['rev-parse', 'HEAD']);
    if (await realpath(existingRoot) !== await realpath(worktree)) throw new Error(`Worktree ownership mismatch: ${worktree}`);
    if (existingHead !== head.sha) {
      // Never wipe dirty files or commits unique to this Job checkout. A clean
      // ancestor can safely advance to the remote PR head without reset --hard.
      const dirty = await git(worktree, ['status', '--porcelain']);
      if (dirty) throw new Error(`Job worktree has changes while PR head advanced: ${worktree}`);
      const ancestor = await gitOutput(['-C', worktree, 'merge-base', '--is-ancestor', existingHead, head.sha]).then(() => true, () => false);
      if (!ancestor) throw new Error(`Job worktree has non-fast-forward history; preserve commits: ${worktree}`);
      await git(worktree, ['merge', '--ff-only', head.sha]);
    }
    return projectRelative ? join(worktree, projectRelative) : worktree;
  } catch (error) {
    try { await stat(worktree); } catch {
      await git(primary, ['worktree', 'add', '--detach', worktree, head.sha]);
      return projectRelative ? join(worktree, projectRelative) : worktree;
    }
    throw error;
  }
}

function repositoryPathRank(path: string, root: string): number {
  const relativePath = relative(root, path);
  if (!relativePath.includes('/')) return 0;
  if (relativePath.startsWith('.worktrees/')) return 2;
  if (relativePath.startsWith('.backup/')) return 3;
  return 1;
}

/** Stable checkout identity for the entire managed PR/Job lifecycle. */
export function managedJobWorktreePath(repository: string, prNumber: number, workspaceRoot = defaultWorkspaceRoot()): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !Number.isSafeInteger(prNumber) || prNumber <= 0)
    throw new Error('Invalid managed Job checkout identity');
  return join(workspaceRoot, '.worktrees', 'agents-relay', `${repository.replace('/', '-')}-pr-${prNumber}`, 'job');
}

export function managedLocalJobWorktreePath(repository: string, jobId: string, workspaceRoot = defaultWorkspaceRoot()): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !jobId.trim()) throw new Error('Invalid local Job checkout identity');
  const safeJob = jobId.replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 72) || 'job';
  const digest = createHash('sha256').update(jobId).digest('hex').slice(0, 12);
  return join(workspaceRoot, '.worktrees', 'agents-relay', `${repository.replace('/', '-')}-job-${safeJob}-${digest}`, 'job');
}

/** Only code artifacts need an isolated Git source branch and worktree. */
export function jobRequiresManagedWorktree(job: Job): boolean {
  return !(job.prNumber > 0) && (Boolean(job.localMerge?.sourceRef) || job.tasks.some(task => task.output?.kind === 'task_pr'));
}

/** Bind an ordinary SQLite Job to one deterministic local work branch.
 * The target is always main, and branch creation never switches the user's checkout.
 * This is a Git-local operation and never needs GitHub credentials.
 */
export async function ensureLocalJobSourceBranch(projectPath: string, job: Job): Promise<string> {
  if (job.localMerge?.sourceRef) {
    if (job.localMerge.targetRef !== 'refs/heads/main') throw new Error('Local Job target must be main');
    return job.localMerge.sourceRef;
  }
  const safe = job.id.replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 48);
  const digest = createHash('sha256').update(job.id).digest('hex').slice(0, 12);
  const sourceRef = `refs/heads/relay/job-${safe}-${digest}`;
  const primary = (await git(projectPath, ['rev-parse', '--show-toplevel'])).trim();
  await git(primary, ['rev-parse', '--verify', 'refs/heads/main']);
  const exists = await gitOutput(['-C', primary, 'show-ref', '--verify', '--quiet', sourceRef]).then(() => true, () => false);
  if (!exists) {
    // A concurrent caller may create the same ref; git update-ref is idempotent
    // when the target already exists, and must never reset it.
    const sha = (await git(primary, ['rev-parse', '--verify', 'refs/heads/main'])).trim();
    await gitOutput(['-C', primary, 'update-ref', sourceRef, sha, '0000000000000000000000000000000000000000']).catch(async error => {
      if (!(await gitOutput(['-C', primary, 'show-ref', '--verify', sourceRef]).then(() => true, () => false))) throw error;
    });
  }
  return sourceRef;
}

export async function prepareLocalJobExecutionWorktree(projectPath: string, job: Job, workspaceRoot = defaultWorkspaceRoot()): Promise<string> {
  if (!job.localMerge?.sourceRef) return resolveRepositoryProjectPath(projectPath, job.projectPath);
  const sourceRef = job.localMerge.sourceRef;
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(sourceRef) || sourceRef.includes('..') || sourceRef.endsWith('.lock'))
    throw new Error('Local Job execution requires a valid refs/heads sourceRef');
  const primary = await git(projectPath, ['rev-parse', '--show-toplevel']);
  const projectRelative = (await git(projectPath, ['rev-parse', '--show-prefix'])).replace(/\/$/, '');
  const effectiveProject = (checkoutRoot: string): string => job.projectPath
    ? resolveRepositoryProjectPath(checkoutRoot, job.projectPath)
    : (projectRelative ? join(checkoutRoot, projectRelative) : checkoutRoot);
  let remote = '';
  try { remote = await git(primary, ['config', '--get', 'remote.origin.url']); } catch { /* Local-only repositories may have no origin. */ }
  const remoteRepository = remote ? githubRepositoryFromRemote(remote) : null;
  if (remoteRepository && remoteRepository !== job.repository) throw new Error(`Primary checkout ${primary} does not match ${job.repository}`);
  const sourceSha = await git(primary, ['rev-parse', '--verify', sourceRef]);
  // If the canonical checkout already owns this exact source branch, Git
  // cannot create a second worktree for it. Reuse the canonical checkout
  // instead. This is especially important for repair Jobs created from an
  // existing dirty worktree: the uncommitted evidence must remain available.
  const primaryBranch = await git(primary, ['symbolic-ref', '-q', 'HEAD']).catch(() => '');
  if (primaryBranch === sourceRef) {
    const primaryHead = await git(primary, ['rev-parse', 'HEAD']);
    if (primaryHead !== sourceSha) throw new Error(`Canonical source branch ${sourceRef} changed while preparing execution checkout`);
    return effectiveProject(primary);
  }

  const worktree = managedLocalJobWorktreePath(job.repository, job.id, workspaceRoot);
  await mkdir(dirname(worktree), { recursive: true });
  try {
    const existingRoot = await git(worktree, ['rev-parse', '--show-toplevel']);
    if (await realpath(existingRoot) !== await realpath(worktree)) throw new Error(`Worktree ownership mismatch: ${worktree}`);
    const branch = await git(worktree, ['symbolic-ref', 'HEAD']);
    if (branch !== sourceRef) throw new Error(`Local Job worktree is bound to ${branch}, expected ${sourceRef}`);
    const existingHead = await git(worktree, ['rev-parse', 'HEAD']);
    if (existingHead !== sourceSha) {
      if (await git(worktree, ['status', '--porcelain'])) throw new Error(`Local Job worktree has changes while source ref advanced: ${worktree}`);
      const ancestor = await gitOutput(['-C', worktree, 'merge-base', '--is-ancestor', existingHead, sourceSha]).then(() => true, () => false);
      if (!ancestor) throw new Error(`Local Job worktree has non-fast-forward history; preserve commits: ${worktree}`);
      await git(worktree, ['merge', '--ff-only', sourceSha]);
    }
    return effectiveProject(worktree);
  } catch (error) {
    try { await stat(worktree); } catch {
      await git(primary, ['worktree', 'add', worktree, sourceRef.slice('refs/heads/'.length)]);
      return effectiveProject(worktree);
    }
    throw error;
  }
}

export type ManagedWorktreeCleanupResult = { status: 'removed' | 'absent' | 'blocked'; reason?: string };

/**
 * Graph-owned eligibility: called only after authoritative MERGED -> COMPLETED.
 * This function only performs the mechanical, conservative cleanup effect.
 */
export async function cleanupCompletedJobWorktree(
  projectPath: string,
  job: Job,
  workspaceRoot = defaultWorkspaceRoot(),
): Promise<ManagedWorktreeCleanupResult> {
  if (job.state !== 'COMPLETED') return { status: 'blocked', reason: 'Job is not completed' };
  const isLocalJob = Boolean(job.localMerge?.sourceRef);
  const expectedHead = isLocalJob ? (job.localMerge?.sourceSha ?? job.review?.headSha ?? job.headSha) : job.headSha;
  if (!expectedHead) return { status: 'blocked', reason: 'No durable Job head SHA' };
  if (job.tasks.some(task => task.executionId !== null || task.leaseOwner !== null))
    return { status: 'blocked', reason: 'Task still owns an execution or lease' };
  if ((job.plans ?? []).some(plan => plan.executionId !== null || plan.leaseOwner !== null))
    return { status: 'blocked', reason: 'Planner still owns an execution or lease' };

  const worktree = isLocalJob ? managedLocalJobWorktreePath(job.repository, job.id, workspaceRoot) : managedJobWorktreePath(job.repository, job.prNumber, workspaceRoot);
  let metadata;
  try { metadata = await lstat(worktree); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    return { status: 'blocked', reason: 'Worktree path is not an owned directory' };

  const primary = await git(projectPath, ['rev-parse', '--show-toplevel']);
  let origin = '';
  try { origin = await git(primary, ['config', '--get', 'remote.origin.url']); } catch { /* Local-only repositories may have no origin. */ }
  const originRepository = origin ? githubRepositoryFromRemote(origin) : null;
  if ((job.prNumber > 0 && !isLocalJob && originRepository !== job.repository) || (isLocalJob && originRepository && originRepository !== job.repository))
    return { status: 'blocked', reason: 'Canonical repository identity mismatch' };
  const registered = await git(primary, ['worktree', 'list', '--porcelain']);
  const ownedRoot = await realpath(worktree);
  const registeredPaths = registered.split('\n').filter(line => line.startsWith('worktree '));
  const matching = await Promise.all(registeredPaths.map(async line => {
    try { return await realpath(line.slice('worktree '.length)) === ownedRoot; } catch { return false; }
  }));
  if (!matching.includes(true))
    return { status: 'blocked', reason: 'Worktree is not registered with the canonical repository' };
  const head = await git(worktree, ['rev-parse', 'HEAD']);
  if (head !== expectedHead)
    return { status: 'blocked', reason: 'Worktree contains unique or stale commits' };
  if (await git(worktree, ['status', '--porcelain']))
    return { status: 'blocked', reason: 'Worktree has uncommitted or untracked changes' };
  await git(primary, ['worktree', 'remove', worktree]);
  return { status: 'removed' };
}

/** Reviewer must never inspect local, uncommitted content as an immutable SHA. */
export async function assertCleanWorktreeAtHead(projectPath: string, headSha: string): Promise<void> {
  const actual = await git(projectPath, ['rev-parse', 'HEAD']);
  if (actual !== headSha) throw new Error(`Review checkout has stale HEAD: ${actual}, expected ${headSha}`);
  if (await git(projectPath, ['status', '--porcelain']))
    throw new Error(`Review checkout has uncommitted changes: ${projectPath}`);
}
