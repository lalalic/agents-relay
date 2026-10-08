import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const PACKAGE_FAILED_MARKER = 'agents-relay:package-publish-failed:v1';
export function failureComment(input) {
  const marker = { runId: String(input.runId), attempt: Number(input.attempt), sha: input.sha, stage: input.stage };
  return `<!-- ${PACKAGE_FAILED_MARKER} ${JSON.stringify(marker)} -->\n` +
    `Publish failed at **${input.stage}** for commit \`${input.sha}\`.\n` +
    `Workflow: ${input.runUrl}\n\n` +
    `Failure details:\n\`\`\`text\n${String(input.details || 'See workflow run for logs').slice(0, 3000).replaceAll('```','~~~')}\n\`\`\``;
}
export async function recordFailure(input, github) {
  const pulls = await github(`/repos/${input.repository}/commits/${input.sha}/pulls`);
  const pr = Array.isArray(pulls) ? pulls.find(row => row?.merged_at && Number.isInteger(row.number)) : null;
  if (!pr) return { recorded: false, reason: 'no-correlated-merged-pr' };
  const marker = `<!-- ${PACKAGE_FAILED_MARKER} `;
  const identity = `"runId":"${input.runId}","attempt":${Number(input.attempt)}`;
  for (let page = 1; ; page++) {
    const comments = await github(`/repos/${input.repository}/issues/${pr.number}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments)) throw new Error('Invalid GitHub comments response');
    if (comments.some(row => typeof row.body === 'string' && row.body.includes(marker) && row.body.includes(identity))) return { recorded: false, reason: 'duplicate', pr: pr.number };
    if (comments.length < 100) break;
  }
  await github(`/repos/${input.repository}/issues/${pr.number}/comments`, { method: 'POST', body: JSON.stringify({ body: failureComment(input) }) });
  return { recorded: true, pr: pr.number };
}
async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const runId = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT || '1';
  if (!token || !repository || !sha || !runId) throw Error('Missing GitHub action environment');
  const github = async (path, init={}) => {
    const response = await fetch('https://api.github.com'+path,{ ...init,headers:{accept:'application/vnd.github+json',authorization:`Bearer ${token}`,'content-type':'application/json','x-github-api-version':'2022-11-28'} });
    if (!response.ok) throw Error(`GitHub API ${response.status}: ${await response.text()}`);
    return response.json();
  };
  const run = await github(`/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`);
  const steps = (run.jobs || []).flatMap(job => job.steps || []);
  const failed = steps.filter(step => step.conclusion === 'failure').map(step => step.name);
  const stage = failed.join(', ') || 'unknown publish stage';
  const result = await recordFailure({ repository,sha,runId,attempt,stage,runUrl:`https://github.com/${repository}/actions/runs/${runId}`,details:failed.join('\n') },github);
  process.stdout.write(JSON.stringify(result)+'\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode=1; });
