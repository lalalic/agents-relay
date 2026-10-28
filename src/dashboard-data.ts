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
export type DashboardJobLike = { id: string; state: string; repository: string; title?: string; prNumber?: number; draft?: boolean; githubState?: string; runtimeStatus?: string; updatedAt?: string };
export type DashboardJobsSearchResult<T extends DashboardJobLike> = {
  jobs: T[];
  repositories: string[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};
export const DASHBOARD_JOB_PAGE_SIZE = 20;
export const DEFAULT_DASHBOARD_JOB_STATUSES = ['DRAFT', 'ACTIVE', 'COMPLETED'] as const;

function compareDashboardJobs(a: DashboardJobLike, b: DashboardJobLike): number {
  const terminal = (job: DashboardJobLike): boolean => ['COMPLETED', 'CANCELLED'].includes(job.state) || ['MERGED', 'CLOSED'].includes(job.githubState ?? '');
  const group = (job: DashboardJobLike): number => terminal(job) ? 3 : job.draft || job.state === 'DRAFT' ? 2 : 0;
  const groupDelta = group(a) - group(b);
  if (groupDelta) return groupDelta;
  const mergePendingDelta = Number(b.runtimeStatus === 'MERGE_PENDING') - Number(a.runtimeStatus === 'MERGE_PENDING');
  if (mergePendingDelta) return mergePendingDelta;
  return String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''));
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
  const requestedStatuses = [...new Set([...query.getAll('status'), ...query.getAll('statuses')].flatMap(value => value.split(',')).map(value => value.trim().toUpperCase()).filter(Boolean))];
  const statuses = requestedStatuses.length > 0 ? requestedStatuses : [...DEFAULT_DASHBOARD_JOB_STATUSES];
  const repositories = [...new Set([...query.getAll('repo'), ...query.getAll('repositories'), ...query.getAll('repos')].map(value => value.trim()).filter(Boolean))];
  const search = query.get('q')?.trim().toLowerCase() ?? '';
  const parsedPage = Number(query.get('page'));
  const page = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const parsedPageSize = Number(query.get('pageSize'));
  const pageSize = Number.isInteger(parsedPageSize) && parsedPageSize > 0 ? Math.min(parsedPageSize, DASHBOARD_JOB_PAGE_SIZE) : DASHBOARD_JOB_PAGE_SIZE;
  const matchesStatus = (job: T): boolean => statuses.some(status => status === 'DRAFT'
    ? Boolean(job.draft) || job.state === 'DRAFT'
    : job.state === status);
  const matchesRepository = (job: T): boolean => repositories.length === 0 || repositories.includes(job.repository);
  const normalizedPr = search.replace(/^pr\s*#?/, '').replace(/^#/, '');
  const matchesSearch = (job: T): boolean => {
    if (!search) return true;
    return String(job.title || job.id || '').toLowerCase().includes(search)
      || String(job.id || '').toLowerCase().includes(search)
      || Boolean(normalizedPr) && String(job.prNumber || '').includes(normalizedPr);
  };
  const matching = jobs.filter(job => matchesStatus(job) && matchesRepository(job) && matchesSearch(job)).sort(compareDashboardJobs);
  const total = matching.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  return {
    jobs: matching.slice((safePage - 1) * pageSize, safePage * pageSize),
    repositories: [...new Set(jobs.map(job => job.repository).filter(Boolean))].sort(),
    total,
    page: safePage,
    pageSize,
    totalPages,
  };
}
