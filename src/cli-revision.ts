import { readFile } from 'node:fs/promises';
import { arg, relayControlCommand } from './cli-support.js';
import type { RevisionFinding, ReviewRevisionRequest } from './types.js';

/** Reviewer-controlled file intake; findings are structured immutable evidence. */
export function parseRevisionFindings(source: string): RevisionFinding[] {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error('findings-file must contain a JSON array of {id,summary,evidence?}'); }
  if (!Array.isArray(value) || !value.length || value.length > 200) throw new Error('findings-file requires 1..200 identified findings');
  const findings = value.map((item: unknown, index): RevisionFinding => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`finding ${index} must be an object`);
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 160
      || typeof entry.summary !== 'string' || !entry.summary.trim() || entry.summary.length > 4000
      || (entry.evidence !== undefined && (typeof entry.evidence !== 'string' || entry.evidence.length > 10000))) {
      throw new Error(`finding ${index} requires valid id, summary, optional evidence`);
    }
    if (Object.keys(entry).some(key => !['id', 'summary', 'evidence'].includes(key))) throw new Error(`finding ${index} contains unsupported fields`);
    return { id: entry.id.trim(), summary: entry.summary.trim(), ...(typeof entry.evidence === 'string' ? { evidence: entry.evidence } : {}) };
  });
  if (new Set(findings.map(item => item.id)).size !== findings.length) throw new Error('findings-file contains duplicate IDs');
  return findings;
}

export async function runTaskReviseCommand(args: string[]): Promise<void> {
  const jobId = arg(args, '--id');
  const repository = arg(args, '--repo');
  const taskId = arg(args, '--task-id');
  const reviewTaskId = arg(args, '--review-task-id');
  const reviewExecutionId = arg(args, '--execution-id');
  const headSha = arg(args, '--head-sha');
  const requestId = arg(args, '--request-id');
  const findingsFile = arg(args, '--findings-file');
  if ([jobId, repository, taskId, reviewTaskId, reviewExecutionId, headSha, requestId, findingsFile].some(value => !value || value.startsWith('--')))
    throw new Error('task revise requires --repo --id --task-id --review-task-id --execution-id --head-sha --request-id --findings-file');
  const findings = parseRevisionFindings(await readFile(findingsFile, 'utf8'));
  const response = await relayControlCommand<{ request: ReviewRevisionRequest; created: boolean }>(args, {
    command: 'task.revise', jobId, repository, taskId, reviewTaskId, reviewExecutionId, headSha, requestId, findings,
  });
  if (!response.request || response.request.requestId !== requestId || response.request.originalTaskId !== taskId || !response.request.revisionTaskId)
    throw new Error('Relay targeted revision receipt has unexpected request or Task identity');
  console.log(JSON.stringify({ status: 'durable', ...response }, null, 2));
}
