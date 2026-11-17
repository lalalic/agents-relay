import { arg, relayControlCommand } from './cli-support.js';

/** Version-matched CLI is a request only; the daemon validates Git and owns Task success. */
export async function runTaskCompleteCommand(args: string[]): Promise<void> {
  const jobId = arg(args, '--id'), taskId = arg(args, '--task-id');
  const executionId = arg(args, '--execution-id'), commitSha = arg(args, '--commit-sha');
  if (!jobId || !taskId || !executionId || !commitSha || !arg(args, '--repo'))
    throw new Error('task complete requires --repo, --id, --task-id, --execution-id and --commit-sha');
  const result = await relayControlCommand(args, { command: 'task.complete', jobId, taskId,
    executionId, commitSha, repository: arg(args, '--repo'),
    summary: arg(args, '--summary') || `Source Task ${taskId} committed ${commitSha}` });
  console.log(JSON.stringify(result, null, 2));
}
