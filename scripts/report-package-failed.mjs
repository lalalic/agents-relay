import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

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
export function publishRepairIdentity(sha, originBranch = '') {
  if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('Invalid published commit SHA');
  if (originBranch.startsWith('fix/auto-publish-')) return null; // Do not cascade repair PRs infinitely.
  const key = sha.slice(0, 12).toLowerCase();
  return { jobId: `job-auto-publish-repair-${key}`, branch: `fix/auto-publish-${key}`, taskId: 'repair-publish' };
}

export async function enqueuePublishRepair(input, originatingPr, github, invoke = execFileSync) {
  const pr = await github(`/repos/${input.repository}/pulls/${originatingPr}`);
  if (!pr?.head?.ref) throw Error('Cannot safely identify originating PR branch');
  const identity = publishRepairIdentity(input.sha, pr.head.ref);
  if (!identity) return { created: false, reason: 'repair-origin-loop-protection' };
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-publish-repair-'));
  const objectiveFile = join(directory, 'objective.md');
  try {
    const objective = `# Repair automated package publication failure\n\nPublish failed for ${input.repository} at ${input.sha}.\nOriginating PR: #${originatingPr}\nWorkflow: ${input.runUrl}\nRun: ${input.runId} attempt ${input.attempt}\nFailed stage: ${input.stage}\nDetails: ${input.details}\n\nDiagnose and fix this failure, run npm run test:publish, review, and merge only through agents-relay job merge. Do not use gh pr merge. Do not bypass source-size checks or tests. Successful publish must drive package.published -> npm latest updater.\n`;
    await writeFile(objectiveFile, objective);
    const cli = args => invoke('npx', ['-y', '--package', 'agents-relay@latest', 'agents-relay', ...args], { encoding: 'utf8', timeout: 120000, env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN } });
    const created = JSON.parse(cli(['job','create','--repo',input.repository,'--head',identity.branch,'--id',identity.jobId,'--title',`Repair failed publish for ${input.sha.slice(0,12)}`,'--objective-file',objectiveFile,'--priority','P0','--mode','autonomous']));
    const prNumber = Number(created.pr);
    if (!Number.isInteger(prNumber) || prNumber < 1) throw Error('Repair Job creation returned invalid PR number');
    cli(['task','create','--repo',input.repository,'--pr',String(prNumber),'--id',identity.jobId,'--task-id',identity.taskId,'--priority','P0','--story-size','M','--output','task-pr','--input-file',objectiveFile]);
    return { created: true, repairPr: prNumber, jobId: identity.jobId };
  } finally { await rm(directory, { recursive: true, force: true }); }
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
  const input = { repository,sha,runId,attempt,stage,runUrl:`https://github.com/${repository}/actions/runs/${runId}`,details:failed.join('\n') };
  const result = await recordFailure(input,github);
  let repair = null;
  if (result.pr) repair = await enqueuePublishRepair(input,result.pr,github);
  process.stdout.write(JSON.stringify({ report: result, repair })+'\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode=1; });
