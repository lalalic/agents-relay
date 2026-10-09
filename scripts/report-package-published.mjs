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

export async function findMergedPullRequest(input, github) {
  if (Number.isInteger(input.prNumber) && input.prNumber > 0) {
    const pr = await github(`/repos/${input.repository}/pulls/${input.prNumber}`);
    return pr?.merged_at ? pr : null;
  }
  const pulls = await github(`/repos/${input.repository}/commits/${input.sha}/pulls`);
  if (!Array.isArray(pulls)) throw new Error('Invalid GitHub commit-to-PR response');
  return pulls.find(item => item && typeof item === 'object' && item.merged_at && Number.isInteger(item.number)) ?? null;
}

export async function recordPublication(input, github) {
  const pr = await findMergedPullRequest(input, github);
  if (!pr) return { recorded: false, reason: 'no-correlated-merged-pr' };
  const markerPrefix = `<!-- ${PACKAGE_PUBLISHED_MARKER} `;
  const packageIdentity = `"package":${JSON.stringify(input.packageName)}`;
  const versionIdentity = `"version":${JSON.stringify(input.version)}`;
  for (let page = 1; ; page += 1) {
    const comments = await github(`/repos/${input.repository}/issues/${pr.number}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments)) throw new Error('Invalid GitHub comments response');
    if (comments.some(comment => typeof comment?.body === 'string' && comment.body.includes(markerPrefix)
      && comment.body.includes(packageIdentity) && comment.body.includes(versionIdentity))) {
      return { recorded: false, reason: 'duplicate', pr: pr.number };
    }
    if (comments.length < 100) break;
  }
  await github(`/repos/${input.repository}/issues/${pr.number}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: publicationComment(input) }),
  });
  return { recorded: true, pr: pr.number };
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
  const result = await recordPublication({ repository, sha, packageName, version, registry, prNumber }, github);
  if (!result.recorded && result.reason === 'no-correlated-merged-pr') {
    process.stdout.write(`No merged pull request found for ${sha}; publication event was not recorded.\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(result.recorded
    ? `Recorded ${packageName}@${version} publication on PR #${result.pr}.\n`
    : `Publication marker already exists on PR #${result.pr}.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
}
