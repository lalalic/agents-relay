import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const PACKAGE_PUBLISHED_MARKER = 'agents-relay:package-published:v1';

export function publicationComment(input) {
  const payload = JSON.stringify({
    package: input.packageName,
    version: input.version,
    registry: input.registry ?? null,
    sha: input.sha ?? null,
    ...(input.jobId ? { jobId: input.jobId } : {}),
  });
  const channel = input.registry ? ` to ${input.registry}` : '';
  return `<!-- ${PACKAGE_PUBLISHED_MARKER} ${payload} -->\nPublished \`${input.packageName}@${input.version}\`${channel}.`;
}

export async function resolvePackageName(explicitName, packageFile = resolve('package.json')) {
  if (explicitName) return explicitName;
  const pkg = JSON.parse(await readFile(packageFile, 'utf8'));
  if (typeof pkg.name !== 'string' || !pkg.name) throw new Error('PACKAGE_NAME is required when package.json has no package name');
  return pkg.name;
}

export function parseLocalMergeCorrelation(message) {
  if (typeof message !== 'string' || !message.startsWith('Agents Relay local merge')) return null;
  const field = name => message.split(/\r?\n/).find(line => line.startsWith(name + ': '))?.slice(name.length + 2).trim() || null;
  const jobId = field('Agents-Relay-Job');
  const sourceSha = field('Agents-Relay-Source-SHA');
  const pr = Number(field('Agents-Relay-Display-PR') || 0);
  if (!jobId || !/^[a-f0-9]{40,64}$/i.test(sourceSha || '')) return null;
  return { jobId, sourceSha, prNumber: Number.isInteger(pr) && pr > 0 ? pr : null };
}

export async function findPublicationTarget(input, github) {
  if (Number.isInteger(input.prNumber) && input.prNumber > 0) {
    const pr = await github(`/repos/${input.repository}/pulls/${input.prNumber}`);
    return pr && Number.isInteger(pr.number) ? { kind: 'pr', pr, correlation: 'explicit-pr' } : null;
  }
  if (/^[a-f0-9]{40,64}$/i.test(input.sha || '')) {
    const commit = await github(`/repos/${input.repository}/commits/${input.sha}`);
    const correlation = parseLocalMergeCorrelation(commit?.commit?.message);
    if (correlation) return { kind: 'local-merge', sha: input.sha, jobId: correlation.jobId, sourceSha: correlation.sourceSha,
      displayPrNumber: correlation.prNumber, correlation: 'local-merge' };
  }
  const pulls = await github(`/repos/${input.repository}/commits/${input.sha}/pulls`);
  if (!Array.isArray(pulls)) throw new Error('Invalid GitHub commit-to-PR response');
  const pr = pulls.find(item => item && typeof item === 'object' && item.merged_at && Number.isInteger(item.number));
  if (pr) return { kind: 'pr', pr, correlation: 'merged-pr' };
  if (input.allowUnmanagedMain === true && /^[a-f0-9]{40,64}$/i.test(input.sha || ''))
    return { kind: 'unmanaged-main', sha: input.sha, jobId: `unmanaged-main-${input.sha.slice(0,12).toLowerCase()}`, displayPrNumber: null, correlation: 'unmanaged-main' };
  return null;
}

export async function findMergedPullRequest(input, github) {
  const target = await findPublicationTarget(input, github);
  return target?.kind === 'pr' ? target.pr : null;
}

export const PUBLICATION_ISSUE_TITLE = '[Agents Relay] Publication events';

export async function ensurePublicationIssue(repository, github) {
  for (let page = 1; ; page += 1) {
    const issues = await github(`/repos/${repository}/issues?state=open&per_page=100&page=${page}`);
    if (!Array.isArray(issues)) throw new Error('Invalid GitHub issues response');
    const existing = issues.find(issue => issue && !issue.pull_request && issue.title === PUBLICATION_ISSUE_TITLE && Number.isInteger(issue.number));
    if (existing) return existing.number;
    if (issues.length < 100) break;
  }
  const created = await github(`/repos/${repository}/issues`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: PUBLICATION_ISSUE_TITLE, body: 'Durable transport for Agents Relay package publication markers. Do not delete while publication tracking is enabled.' }),
  });
  if (!Number.isInteger(created?.number)) throw new Error('GitHub did not return publication issue number');
  return created.number;
}

export async function recordPublication(input, github) {
  const target = await findPublicationTarget(input, github);
  if (!target) return { recorded: false, reason: 'no-correlated-publication-target' };
  const markerPrefix = `<!-- ${PACKAGE_PUBLISHED_MARKER} `;
  const packageIdentity = `"package":${JSON.stringify(input.packageName)}`;
  const versionIdentity = `"version":${JSON.stringify(input.version)}`;
  const jobId = target.kind !== 'pr' ? target.jobId : undefined;
  const issueNumber = target.kind !== 'pr'
    ? (target.displayPrNumber ?? await ensurePublicationIssue(input.repository, github))
    : target.pr.number;
  const body = publicationComment({ ...input, jobId });
  for (let page = 1; ; page += 1) {
    const comments = await github(`/repos/${input.repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments)) throw new Error('Invalid GitHub comments response');
    if (comments.some(comment => typeof comment?.body === 'string' && comment.body.includes(markerPrefix)
      && comment.body.includes(packageIdentity) && comment.body.includes(versionIdentity))) {
      return target.kind !== 'pr'
        ? { recorded: false, reason: 'duplicate', jobId, issue: issueNumber, ...(target.displayPrNumber ? { pr: target.displayPrNumber } : {}) }
        : { recorded: false, reason: 'duplicate', pr: issueNumber };
    }
    if (comments.length < 100) break;
  }
  await github(`/repos/${input.repository}/issues/${issueNumber}/comments`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }),
  });
  return target.kind !== 'pr'
    ? { recorded: true, jobId, issue: issueNumber, ...(target.displayPrNumber ? { pr: target.displayPrNumber } : {}) }
    : { recorded: true, pr: issueNumber };
}

async function github(path, init = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const response = await fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${init.method ?? 'GET'} ${path} returned ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : await response.json();
}

async function main() {
  const repository = process.env.SOURCE_REPOSITORY || process.env.GITHUB_REPOSITORY;
  const sha = process.env.SOURCE_SHA || process.env.GITHUB_SHA;
  const version = process.env.PACKAGE_VERSION || process.env.ARTIFACT_VERSION;
  const registry = process.env.PACKAGE_REGISTRY || process.env.RELEASE_CHANNEL || null;
  const packageName = await resolvePackageName(process.env.PACKAGE_NAME || process.env.ARTIFACT_NAME || '');
  const prNumber = Number(process.env.ORIGIN_PR || 0) || undefined;
  if (!repository || !sha || !version) throw new Error('SOURCE_REPOSITORY/GITHUB_REPOSITORY, SOURCE_SHA/GITHUB_SHA, and PACKAGE_VERSION/ARTIFACT_VERSION are required');
  const result = await recordPublication({ repository, sha, packageName, version, registry, prNumber, allowUnmanagedMain: true }, github);
  if (!result.recorded && result.reason === 'no-correlated-publication-target') {
    process.stdout.write(`No originating Agents Relay Job/display PR or historical merged PR found for ${sha}; publication event was not recorded.\n`);
    process.exitCode = 2;
    return;
  }
  const target = result.pr ? `PR #${result.pr}` : `publication issue #${result.issue} for Job ${result.jobId}`;
  process.stdout.write(result.recorded
    ? `Recorded ${packageName}@${version} publication on ${target}.\n`
    : `Publication marker already exists on ${target}.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
}
