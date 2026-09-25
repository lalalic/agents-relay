import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const PACKAGE_PUBLISHED_MARKER = 'agents-relay:package-published:v1';

export function publicationComment(input) {
  const payload = JSON.stringify({
    package: input.packageName,
    version: input.version,
    registry: input.registry,
    sha: input.sha,
  });
  return `<!-- ${PACKAGE_PUBLISHED_MARKER} ${payload} -->\nPublished \`${input.packageName}@${input.version}\` to ${input.registry}.`;
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
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const version = process.env.PACKAGE_VERSION;
  const registry = process.env.PACKAGE_REGISTRY ?? 'https://registry.npmjs.org';
  if (!repository || !sha || !version) throw new Error('GITHUB_REPOSITORY, GITHUB_SHA, and PACKAGE_VERSION are required');

  const pkg = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  if (typeof pkg.name !== 'string' || !pkg.name) throw new Error('package.json must contain a package name');

  const pulls = await github(`/repos/${repository}/commits/${sha}/pulls`);
  const pr = Array.isArray(pulls) ? pulls.find(item => item && typeof item === 'object' && item.merged_at) : null;
  if (!pr || !Number.isInteger(pr.number)) {
    process.stdout.write(`No merged pull request found for ${sha}; publication event will not be correlated to a Job.\n`);
    return;
  }

  const body = publicationComment({ packageName: pkg.name, version, registry, sha });
  const markerPrefix = `<!-- ${PACKAGE_PUBLISHED_MARKER} `;
  let page = 1;
  while (true) {
    const comments = await github(`/repos/${repository}/issues/${pr.number}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments)) break;
    if (comments.some(comment => typeof comment?.body === 'string' && comment.body.includes(markerPrefix) && comment.body.includes(`"package":${JSON.stringify(pkg.name)}`) && comment.body.includes(`"version":${JSON.stringify(version)}`))) {
      process.stdout.write(`Publication marker already exists on PR #${pr.number}.\n`);
      return;
    }
    if (comments.length < 100) break;
    page += 1;
  }

  await github(`/repos/${repository}/issues/${pr.number}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  process.stdout.write(`Recorded ${pkg.name}@${version} publication on PR #${pr.number}.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
}
