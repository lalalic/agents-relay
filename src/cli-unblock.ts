import type { DurableStore } from './store.js';
import type { Job, Task } from './types.js';
import { arg, publishTaskUnblocked, publishWake, saveLocal, withEventBus } from './cli-support.js';
import { isEffectivelyBlocked, unblockAutonomousTasks, unblockTask } from './unblock.js';
import { resumeTroubleshooter } from './task-recovery.js';

export async function runTaskUnblockCommand(args: string[], store: DurableStore, job: Job, task: Task, localFile: string | null): Promise<void> {
  const reason = arg(args, '--reason');
  const response = arg(args, '--response');
  if (!reason.trim() && !response.trim()) throw new Error('task unblock requires --reason or --response');
  if (task.agentName === 'troubleshooter' && task.escalation?.status === 'pending' && response.trim()) {
    const result = await resumeTroubleshooter(store, job.id, task.id, response);
    await saveLocal(localFile, result.job);
    await withEventBus(args, async bus => { await publishTaskUnblocked(bus, result.job, task.id, reason || 'Human response recorded'); await publishWake(bus, result.job, task.id, 'Troubleshooter resumed after human response'); });
    console.log(JSON.stringify({ taskId: task.id, resumed: true, task: result.task }, null, 2));
    return;
  }
  const result = await unblockTask({ store, job, task, trigger: { source: 'cli', reason } });
  const refreshed = await store.load(job.id);
  await saveLocal(localFile, refreshed);
  await withEventBus(args, async bus => {
    await publishTaskUnblocked(bus, refreshed, task.id, reason);
    await publishWake(bus, refreshed, task.id, `Task ${task.id} unblocked${result.replanning ? ' for replanning' : ''}`);
  });
  console.log(JSON.stringify({ taskId: task.id, ...result, task: refreshed.tasks.find(item => item.id === task.id) }, null, 2));
}

export async function runJobUnblockCommand(args: string[], store: DurableStore, job: Job): Promise<void> {
  const reason = arg(args, '--reason');
  if (!reason.trim()) throw new Error('job unblock requires --reason');
  const blocked = job.tasks.filter(isEffectivelyBlocked);
  if (blocked.length === 0) throw new Error(`Job ${job.id} has no effective BLOCKED work task`);
  if (job.executionMode === 'autonomous') {
    const planTrigger = await unblockAutonomousTasks({ store, job, tasks: blocked, trigger: { source: 'cli', reason } });
    const refreshed = await store.load(job.id);
    await withEventBus(args, async bus => {
      for (const task of blocked) await publishTaskUnblocked(bus, refreshed, task.id, reason);
      await publishWake(bus, refreshed, 'job', `Job ${job.id} unblocked for replanning`);
    });
    console.log(JSON.stringify({ jobId: job.id, replanning: true, planTrigger }, null, 2));
    return;
  }
  for (const task of blocked) await unblockTask({ store, job, task, trigger: { source: 'cli', reason } });
  const refreshed = await store.load(job.id);
  await withEventBus(args, async bus => {
    for (const task of blocked) await publishTaskUnblocked(bus, refreshed, task.id, reason);
    await publishWake(bus, refreshed, 'job', `Job ${job.id} unblocked`);
  });
  console.log(JSON.stringify({ jobId: job.id, replanning: false, resumedTasks: blocked.map(task => task.id) }, null, 2));
}
