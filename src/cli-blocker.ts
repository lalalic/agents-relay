import { arg, relayControlCommand, relayControlJob, repository } from './cli-support.js';
import { usage } from './cli-help.js';

export async function runBlockerCommand(action: string, args: string[]): Promise<void> {
  if (!['add', 'resolve', 'show'].includes(action)) throw new Error(usage);
  repository(args);
  const id = arg(args, '--id');
  if (!id) throw new Error('blocker commands require --repo and --id for the blocker Job');
  if (action === 'show') { console.log(JSON.stringify(await relayControlJob(args, id), null, 2)); return; }
  if (action === 'resolve') {
    const result = await relayControlCommand(args, { command: 'blocker.resolve', jobId: id, resolution: 'verified' });
    console.log(JSON.stringify({ blocker: id, resolution: 'verified', ...(result as object) }, null, 2)); return;
  }
  const dependentJobId = arg(args, '--dependent-job');
  const dependentTaskId = arg(args, '--dependent-task');
  if (!dependentJobId || !dependentTaskId) throw new Error('blocker add requires --dependent-job and --dependent-task');
  const modeValue = arg(args, '--resolution', 'merge');
  if (!['merge', 'verified'].includes(modeValue)) throw new Error('--resolution must be merge or verified');
  console.log(JSON.stringify(await relayControlCommand(args, { command: 'blocker.add', jobId: id, dependentJobId, dependentTaskId, resolutionMode: modeValue }), null, 2));
}
