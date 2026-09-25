import { GitHubStore } from './store.js';
import { githubAuthContext } from './github-auth.js';
import { registerBlockerDependency } from './blockers.js';
import { arg, repository } from './cli-support.js';
import { usage } from './cli-help.js';

export async function runBlockerCommand(action: string, args: string[]): Promise<void> {
  if (!['add', 'resolve', 'show'].includes(action)) throw new Error(usage);
  const repo = repository(args);
  const id = arg(args, '--id');
  const pr = Number(arg(args, '--pr'));
  if (!id || !Number.isInteger(pr) || pr <= 0) throw new Error('blocker commands require --repo, --pr, and --id for the blocker Job');
  const auth = await githubAuthContext(args);
  const blockerStore = new GitHubStore(auth.client, repo, pr, auth.trustedAuthors);
  if (action === 'show') {
    console.log(JSON.stringify(await blockerStore.load(id), null, 2));
    return;
  }
  if (action === 'resolve') {
    const summary = await blockerStore.resolveBlockerDependents(id, 'verified');
    console.log(JSON.stringify({ blocker: id, resolution: 'verified', ...summary }, null, 2));
    return;
  }
  const dependentRepo = arg(args, '--dependent-repo');
  const dependentPr = Number(arg(args, '--dependent-pr'));
  const dependentJob = arg(args, '--dependent-job');
  const dependentTask = arg(args, '--dependent-task');
  if (!dependentRepo || !Number.isInteger(dependentPr) || dependentPr <= 0 || !dependentJob || !dependentTask) {
    throw new Error('blocker add requires --dependent-repo, --dependent-pr, --dependent-job, and --dependent-task');
  }
  const modeValue = arg(args, '--resolution', 'merge');
  if (!['merge', 'verified'].includes(modeValue)) throw new Error('--resolution must be merge or verified');
  const relation = await registerBlockerDependency({
    blockerStore,
    blockerJobId: id,
    dependentStore: new GitHubStore(auth.client, dependentRepo, dependentPr, auth.trustedAuthors),
    dependentJobId: dependentJob,
    dependentTaskId: dependentTask,
    resolutionMode: modeValue as 'merge' | 'verified',
  });
  console.log(JSON.stringify(relation, null, 2));
}
