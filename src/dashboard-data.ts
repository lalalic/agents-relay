import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { GitHubRateLimitBucket, GitHubRateLimitSnapshot } from './store.js';
import type { GitHubRuntimeRateUsage } from './github-runtime-usage.js';
import { eventsBusHistory } from './events-bus-runtime.js';

const repositoryPattern = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,36}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/;
const workflowDirectory = fileURLToPath(new URL('../workflow/', import.meta.url));

export type DashboardWorkflowGraph = { id: string; name: string; description: string; path: string; source: string };
export type EffectiveGitHubUsage = Pick<GitHubRateLimitBucket, 'limit' | 'remaining' | 'reset'>;
export type DashboardJobLike = { id: string; state: string; repository: string; title?: string; prNumber?: number; draft?: boolean; githubState?: string; runtimeStatus?: string; updatedAt?: string; createdAt?: string };
export type DashboardJobsSearchResult<T extends DashboardJobLike> = {
  jobs: T[];
  repositories: string[];
  total: number;
};
export const DASHBOARD_JOB_RESULT_LIMIT = 20;
export const DEFAULT_DASHBOARD_JOB_STATUSES = ['DRAFT', 'ACTIVE', 'COMPLETED'] as const;

function compareDashboardJobs(a: DashboardJobLike, b: DashboardJobLike): number {
  const timestamp = (job: DashboardJobLike): number => {
    const updated = Date.parse(job.updatedAt ?? '');
    if (Number.isFinite(updated)) return updated;
    const created = Date.parse(job.createdAt ?? '');
    return Number.isFinite(created) ? created : 0;
  };
  return timestamp(b) - timestamp(a)
    || a.repository.localeCompare(b.repository)
    || a.id.localeCompare(b.id);
}

export async function dashboardWorkflowGraphs(): Promise<DashboardWorkflowGraph[]> {
  const names = (await readdir(workflowDirectory)).filter(name => name.endsWith('.mmd')).sort();
  return Promise.all(names.map(async name => {
    const source = await readFile(join(workflowDirectory, name), 'utf8');
    const metadata = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)?.[1] ?? '';
    const field = (key: string) => metadata.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '';
    return {
      id: name.replace(/\.mmd$/, ''),
      name: field('title') || (name === 'main.mmd' ? 'Main / Happy Path' : name.replace(/\.mmd$/, '').split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')),
      description: field('description'), path: `workflow/${name}`, source,
    };
  }));
}

export function githubPrUrl(repository: unknown, prNumber: unknown): string | null {
  if (typeof repository !== 'string' || typeof prNumber !== 'number' || !Number.isInteger(prNumber) || prNumber <= 0) return null;
  const match = repositoryPattern.exec(repository);
  if (!match) return null;
  const [, owner, repo] = match;
  if ([owner, repo].some(segment => segment === '.' || segment === '..')) return null;
  return `https://github.com/${owner}/${repo}/pull/${prNumber}`;
}

export function effectiveGitHubUsage(snapshot: GitHubRateLimitSnapshot | null, runtime: GitHubRuntimeRateUsage | null): EffectiveGitHubUsage | null {
  const candidates = [snapshot?.resources.core, snapshot?.resources.graphql, snapshot?.resources.search, runtime?.resources.core, runtime?.resources.graphql, runtime?.resources.search]
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined && candidate !== null)
    .filter(candidate => Number.isFinite(candidate.limit) && Number(candidate.limit) > 0 && Number.isFinite(candidate.remaining) && Number.isFinite(candidate.reset));
  const lowest = candidates.reduce<typeof candidates[number] | null>((current, candidate) => !current || Number(candidate.remaining) / Number(candidate.limit) < Number(current.remaining) / Number(current.limit) ? candidate : current, null);
  return lowest ? { limit: Number(lowest.limit), remaining: Number(lowest.remaining), reset: Number(lowest.reset) } : null;
}

export async function eventHistory(jobId: string, taskId: string | null, limit: number): Promise<import('./types.js').EventRecord[]> {
  try { return await eventsBusHistory(jobId, taskId, limit); } catch { return []; }
}

export function searchDashboardJobs<T extends DashboardJobLike>(jobs: readonly T[], query: URLSearchParams): DashboardJobsSearchResult<T> {
  const requestedStatus = (query.get('status') ?? query.get('statuses') ?? '').trim().toUpperCase();
  const status = requestedStatus && ['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'].includes(requestedStatus) ? requestedStatus : '';
  const repository = (query.get('repo') ?? query.get('repositories') ?? query.get('repos') ?? '').trim();
  const search = query.get('q')?.trim().toLowerCase() ?? '';
  const matchesStatus = (job: T): boolean => status ? status === 'DRAFT'
    ? Boolean(job.draft) || job.state === 'DRAFT'
    : job.state === status : DEFAULT_DASHBOARD_JOB_STATUSES.some(defaultStatus => defaultStatus === 'DRAFT'
      ? Boolean(job.draft) || job.state === 'DRAFT'
      : job.state === defaultStatus);
  const matchesRepository = (job: T): boolean => !repository || repository === job.repository;
  const normalizedPr = search.replace(/^pr\s*#?/, '').replace(/^#/, '');
  const matchesSearch = (job: T): boolean => {
    if (!search) return true;
    return String(job.title || job.id || '').toLowerCase().includes(search)
      || String(job.id || '').toLowerCase().includes(search)
      || Boolean(normalizedPr) && String(job.prNumber || '').includes(normalizedPr);
  };
  const matching = jobs.filter(job => matchesStatus(job) && matchesRepository(job) && matchesSearch(job)).sort(compareDashboardJobs);
  return {
    jobs: matching.slice(0, DASHBOARD_JOB_RESULT_LIMIT),
    repositories: [...new Set(jobs.map(job => job.repository).filter(Boolean))].sort(),
    total: matching.length,
  };
}
