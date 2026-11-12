import { DisabledGitHubClient } from './no-github.js';
import { ensureManagedGitHubJob } from './cli-job-create.js';
import { workerTaskFromArgs } from './cli-worker-task.js';
import { arg, hasArg, repository, storeFor, textOption } from './cli-support.js';
import { relayStoreDirectory } from './relay-store.js';

/** Private foreground shortcut bootstrap. This must never contact relayd.
 * Only content-only Shortcut Jobs use this path; the conventional CLI stays
 * daemon-owned. Atomic SQLite records remain authoritative for both paths. */
export async function runLocalShortcutBinding(kind: 'job'|'task', action: string, args: string[]): Promise<void> {
  if (kind === 'job' && action === 'create') {
    if (!hasArg(args, '--shortcut-execution') || hasArg(args, '--initial-plan'))
      throw new Error('local shortcut create requires --shortcut-execution without --initial-plan');
    const objective = await textOption(args, '--objective', '--objective-file');
    if (!objective.trim()) throw new Error('local shortcut create requires objective');
    const { job } = await ensureManagedGitHubJob(new DisabledGitHubClient(), repository(args), new Set(), {
      title: arg(args, '--title') || undefined, objective,
      projectPath: arg(args, '--project-path') || undefined,
      legacyShortcutBootstrap: true, storeDirectory: arg(args, '--store-dir') || relayStoreDirectory(),
      noGitHub: true,
    });
    console.log(JSON.stringify({ repository: job.repository, job: job.id, state: job.state }));
    return;
  }
  if (kind === 'job' && action === 'show' || kind === 'task' && action === 'list') {
    const { job } = await storeFor(args, false, kind === 'job');
    const requestedRepo = kind === 'job' ? arg(args, '--repo') : repository(args);
    if ((requestedRepo && job.repository !== requestedRepo) || job.executionMode !== 'shortcut' || job.contentOnly !== true)
      throw new Error('local shortcut Job identity mismatch');
    console.log(JSON.stringify(kind === 'job' ? job : job.tasks, null, 2));
    return;
  }
  if (kind === 'task' && action === 'create') {
    const { store, job, localFile } = await storeFor(args);
    if (localFile !== null || !store.mutateJob || job.repository !== repository(args) || job.executionMode !== 'shortcut' || job.contentOnly !== true || job.state !== 'DRAFT')
      throw new Error('local shortcut Task creation requires a DRAFT content-only SQLite Job');
    const task = await workerTaskFromArgs(job, args, new Date().toISOString());
    if (task.id !== arg(args, '--task-id') || !task.agentGraph || task.output?.kind !== 'file')
      throw new Error('local shortcut Task must have explicit ID, Agent Graph and file output');
    await store.mutateJob(job.id, current => {
      if (current.state !== 'DRAFT' || current.tasks.some(existing => existing.id === task.id))
        throw new Error('local shortcut Task already exists or Job is no longer DRAFT');
      current.tasks.push(structuredClone(task));
      return current;
    });
    console.log(JSON.stringify(task, null, 2));
    return;
  }
  throw new Error('unsupported local shortcut command; only create, show and list bindings are allowed');
}
