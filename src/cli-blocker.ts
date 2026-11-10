import { arg, hasArg, relayControlCommand, relayControlJob, repository, textOption } from './cli-support.js';
import { usage } from './cli-help.js';

export async function runBlockerCommand(action: string, args: string[]): Promise<void> {
  if (!['add', 'ensure', 'resolve', 'show'].includes(action)) throw new Error(usage);
  if (action === 'ensure') {
    const dependentRepository = repository(args);
    const dependentJobId = arg(args, '--id');
    const targetRepository = arg(args, '--target-repo');
    const requestId = arg(args, '--request-id');
    const dependentTaskId = arg(args, '--dependent-task');
    const reason = arg(args, '--reason');
    const title = arg(args, '--title');
    const objective = await textOption(args, '--objective', '--objective-file');
    const origin = arg(args, '--origin', 'troubleshooter');
    const modeValue = arg(args, '--resolution', 'merge');
    if (!dependentJobId || !targetRepository || !requestId || !dependentTaskId || !title || !reason) {
      throw new Error('blocker ensure requires --id, --target-repo, --request-id, --dependent-task, --title, and --reason');
    }
    if (!objective.trim()) throw new Error('blocker ensure requires --objective-file PATH|- or --objective MARKDOWN');
    if (!hasArg(args, '--authorized')) throw new Error('blocker ensure requires explicit --authorized');
    if (!['planner', 'troubleshooter'].includes(origin)) throw new Error('--origin must be planner or troubleshooter');
    if (!['merge', 'verified'].includes(modeValue)) throw new Error('--resolution must be merge or verified');
    console.log(JSON.stringify(await relayControlCommand(args, {
      command: 'blocker.ensure',
      jobId: dependentJobId,
      request: {
        requestId, targetRepository, dependentRepository, dependentJobId, dependentTaskId, reason,
        title, objective, resolutionMode: modeValue, origin, authorized: true,
        projectPath: arg(args, '--project-path') || undefined,
      },
    }), null, 2));
    return;
  }
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
