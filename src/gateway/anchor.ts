import { GitHubStore } from '../store.js';
import { JOB_MARKER, TASK_MARKER, parseJob } from '../markers.js';
import { Job, Task } from '../types.js';
import { GatewayProject } from './config.js';
import { GitHubGatewayClient, GitHubUnavailableError, isNotFound } from './github.js';

export type PullSummary = { number: number; url: string; branch: string; state: string; merged: boolean };
export type AnchorLookup = { branch: string; sha: string; pull: PullSummary | null };

export function branchNameFor(project: GatewayProject, jobId: string): string {
  return `${project.branchPrefix}${jobId}`;
}

export function jobIdFromBranch(project: GatewayProject, ref: string | null | undefined): string | null {
  if (typeof ref !== 'string' || !ref.startsWith(project.branchPrefix)) return null;
  const jobId = ref.slice(project.branchPrefix.length);
  return jobId.length > 0 ? jobId : null;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function pullSummary(raw: Record<string, unknown>, branch: string): PullSummary {
  const head = raw.head as Record<string, unknown> | undefined;
  return {
    number: Number(raw.number),
    url: typeof raw.html_url === 'string' ? raw.html_url : '',
    branch: typeof head?.ref === 'string' ? head.ref : branch,
    state: typeof raw.state === 'string' ? raw.state : 'open',
    merged: raw.merged === true,
  };
}

function anchorBody(project: GatewayProject, jobId: string): string {
  return `Agents Relay job anchor for \`${jobId}\` in project \`${project.name}\`.\n\nThis pull request carries no code change. Durable job and task state lives in the \`${JOB_MARKER}\` and \`${TASK_MARKER}\` marker comments below, which the Agents Relay reconciler owns.`;
}

export async function branchSha(client: GitHubGatewayClient, repository: string, branch: string): Promise<string | null> {
  try {
    const data = await client.request(`/repos/${repository}/branches/${encode(branch)}`) as Record<string, unknown> | null;
    const commit = data?.commit as Record<string, unknown> | undefined;
    return typeof commit?.sha === 'string' ? commit.sha : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Pull lookup by head branch. `state: 'all'` keeps closed/merged anchors readable. */
export async function findPull(client: GitHubGatewayClient, repository: string, branch: string, state: 'open' | 'all' = 'open'): Promise<PullSummary | null> {
  const owner = repository.split('/')[0] ?? '';
  const data = await client.request(`/repos/${repository}/pulls?state=${state}&per_page=100&head=${encode(`${owner}:${branch}`)}`);
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0] as Record<string, unknown>;
  return pullSummary(first, branch);
}

export async function findOpenPull(client: GitHubGatewayClient, repository: string, branch: string): Promise<PullSummary | null> {
  return findPull(client, repository, branch, 'open');
}

export async function getPull(client: GitHubGatewayClient, repository: string, number: number): Promise<PullSummary | null> {
  try {
    const raw = await client.request(`/repos/${repository}/pulls/${number}`) as Record<string, unknown> | null;
    return raw ? pullSummary(raw, '') : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function resolveAnchor(client: GitHubGatewayClient, project: GatewayProject, jobId: string): Promise<AnchorLookup | null> {
  const branch = branchNameFor(project, jobId);
  const sha = await branchSha(client, project.repository, branch);
  if (sha === null) return null;
  return { branch, sha, pull: await findOpenPull(client, project.repository, branch) };
}

/** An empty commit (base tree, no diff) plus its branch ref. Never touches a local checkout. */
export async function createEmptyCommitBranch(client: GitHubGatewayClient, project: GatewayProject, jobId: string): Promise<string> {
  const baseSha = await branchSha(client, project.repository, project.baseBranch);
  if (baseSha === null) throw new GitHubUnavailableError(`Base branch ${project.baseBranch} was not found in ${project.repository}`);
  const baseCommit = await client.request(`/repos/${project.repository}/git/commits/${baseSha}`) as Record<string, unknown> | null;
  const tree = (baseCommit?.tree as Record<string, unknown> | undefined)?.sha;
  if (typeof tree !== 'string') throw new GitHubUnavailableError(`Unable to read the tree for base commit ${baseSha}`);
  const commit = await client.request(`/repos/${project.repository}/git/commits`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: `agents-relay: anchor ${jobId}`, tree, parents: [baseSha] }),
  }) as Record<string, unknown> | null;
  const sha = commit?.sha;
  if (typeof sha !== 'string') throw new GitHubUnavailableError('GitHub did not return a commit sha for the anchor commit');
  await client.request(`/repos/${project.repository}/git/refs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branchNameFor(project, jobId)}`, sha }),
  });
  return sha;
}

export async function createDraftPull(client: GitHubGatewayClient, project: GatewayProject, branch: string, jobId: string, title: string): Promise<PullSummary> {
  const raw = await client.request(`/repos/${project.repository}/pulls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: `agents-relay: ${title}`, head: branch, base: project.baseBranch, draft: true, body: anchorBody(project, jobId) }),
  }) as Record<string, unknown> | null;
  if (!raw) throw new GitHubUnavailableError('GitHub did not return the created pull request');
  return pullSummary(raw, branch);
}

export async function addLabel(client: GitHubGatewayClient, repository: string, prNumber: number, label: string): Promise<void> {
  await client.request(`/repos/${repository}/issues/${prNumber}/labels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ labels: [label] }),
  });
}

export function storeFor(client: GitHubGatewayClient, project: GatewayProject, prNumber: number): GitHubStore {
  return new GitHubStore(client, project.repository, prNumber, new Set(project.trustedAuthors));
}

export async function readJobOrNull(store: GitHubStore, jobId: string): Promise<Job | null> {
  try {
    return await store.load(jobId);
  } catch (error) {
    if (error instanceof Error && error.message.includes('not found')) return null;
    throw error;
  }
}

export async function persistJobAndTask(store: GitHubStore, job: Job, task: Task): Promise<void> {
  await store.saveJob(job);
  await store.saveTask(task);
}

export async function markerJobIdForPull(client: GitHubGatewayClient, project: GatewayProject, prNumber: number): Promise<string | null> {
  const comments = await storeFor(client, project, prNumber).comments();
  const trusted = new Set(project.trustedAuthors);
  for (const comment of comments) {
    if (comment.authorLogin === null || !trusted.has(comment.authorLogin)) continue;
    const job = parseJob(comment.body);
    if (job && typeof job.id === 'string' && job.id.length > 0) return job.id;
  }
  return null;
}

/** Issue search is PR-number discovery only; branch and durable state come from the pulls/markers APIs. */
export async function searchOpenPullNumbers(client: GitHubGatewayClient, project: GatewayProject): Promise<number[]> {
  const query = `repo:${project.repository} is:pr is:open label:${project.label}`;
  const data = await client.request(`/search/issues?per_page=100&q=${encode(query)}`) as Record<string, unknown> | null;
  const items = data?.items;
  if (!Array.isArray(items)) return [];
  return items
    .map(item => Number((item as Record<string, unknown>).number))
    .filter(number => Number.isInteger(number) && number > 0);
}
