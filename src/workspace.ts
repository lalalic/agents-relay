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
    await Promise.all(entries.filter(entry => entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git').map(entry => visit(join(directory, entry.name))));
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
  return discovered.filter((item): item is DiscoveredRepository => item !== null);
}
