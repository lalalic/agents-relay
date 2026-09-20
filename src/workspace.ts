import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
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
    await Promise.all(entries.filter(entry => entry.isDirectory() && !['node_modules', '.git', '.worktrees', '.backup'].includes(entry.name)).map(entry => visit(join(directory, entry.name))));
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

function repositoryPathRank(path: string, root: string): number {
  const relativePath = relative(root, path);
  if (!relativePath.includes('/')) return 0;
  if (relativePath.startsWith('.worktrees/')) return 2;
  if (relativePath.startsWith('.backup/')) return 3;
  return 1;
}
