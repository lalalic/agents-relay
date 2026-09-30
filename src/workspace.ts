import { mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
  try { return (await execFileAsync('git', ['-C', path, 'remote', 'get-url', 'origin'])).stdout.trim() || null; } catch { return null; }
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

async function git(path: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', path, ...args])).stdout.trim();
}

export type ManagedPullRequestHead = { ref: string; sha: string };

export async function prepareManagedExecutionWorktree(
  projectPath: string,
  repository: string,
  prNumber: number,
  head: ManagedPullRequestHead,
  executionId: string,
): Promise<string> {
  const primary = await git(projectPath, ['rev-parse', '--show-toplevel']);
  const projectRelative = (await git(projectPath, ['rev-parse', '--show-prefix'])).replace(/\/$/, '');
  const remote = await git(primary, ['config', '--get', 'remote.origin.url']);
  if (githubRepositoryFromRemote(remote) !== repository) throw new Error(`Primary checkout ${primary} does not match ${repository}`);
  await git(primary, ['fetch', 'origin', `refs/heads/${head.ref}:refs/remotes/origin/${head.ref}`]);
  const fetched = await git(primary, ['rev-parse', `refs/remotes/origin/${head.ref}`]);
  if (fetched !== head.sha) throw new Error(`PR #${prNumber} head changed while preparing execution checkout (${head.sha} -> ${fetched})`);

  const safeRepo = repository.replace(/[^A-Za-z0-9_.-]+/g, '-');
  const safeExecution = executionId.replace(/[^A-Za-z0-9_.-]+/g, '-');
  const worktree = join(dirname(primary), '.worktrees', 'agents-relay', `${safeRepo}-pr-${prNumber}`, safeExecution);
  await mkdir(dirname(worktree), { recursive: true });
  try {
    const existingRoot = await git(worktree, ['rev-parse', '--show-toplevel']);
    const existingHead = await git(worktree, ['rev-parse', 'HEAD']);
    if (resolve(existingRoot) !== resolve(worktree) || existingHead !== head.sha) throw new Error(`Existing execution worktree ${worktree} is not the expected PR head`);
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
