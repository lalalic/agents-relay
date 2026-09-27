import { Job, Task } from './types.js';

export type RunningTaskSummary = {
  repository: string;
  prNumber: number;
  jobId: string;
  jobTitle: string;
  taskId: string;
  agentName: string | null;
  worker: string;
  provider: string | null;
  model: string | null;
  executionId: string | null;
  leaseExpiresAt: string | null;
};

export type RuntimeSummary = {
  activeJobs: number;
  runningTasks: number;
  workers: { chatgpt: number; codex: number };
  models: Array<{ model: string; count: number }>;
  running: RunningTaskSummary[];
};

function runningWorker(task: Task): 'chatgpt' | 'codex' | null {
  if (task.state !== 'RUNNING') return null;
  const adapter = task.workerSelection?.adapter ?? task.adapter;
  return adapter === 'chatgpt' || adapter === 'codex' ? adapter : null;
}

export function summarizeRuntime(jobs: readonly Job[]): RuntimeSummary {
  let activeJobs = 0;
  let runningTasks = 0;
  let chatgpt = 0;
  let codex = 0;
  const models = new Map<string, number>();
  const running: RunningTaskSummary[] = [];

  for (const job of jobs) {
    if (job.state === 'ACTIVE') activeJobs += 1;
    for (const task of job.tasks) {
      if (task.state !== 'RUNNING') continue;
      runningTasks += 1;
      const worker = runningWorker(task);
      if (worker === 'chatgpt') chatgpt += 1;
      if (worker === 'codex') codex += 1;
      const model = task.routing?.model;
      if (model) models.set(model, (models.get(model) ?? 0) + 1);
      running.push({
        repository: job.repository,
        prNumber: job.prNumber,
        jobId: job.id,
        jobTitle: job.title,
        taskId: task.id,
        agentName: task.agentName ?? null,
        worker: task.workerSelection?.adapter ?? task.adapter,
        provider: task.routing?.provider ?? null,
        model: model ?? null,
        executionId: task.executionId,
        leaseExpiresAt: task.leaseExpiresAt,
      });
    }
  }

  return {
    activeJobs,
    runningTasks,
    workers: { chatgpt, codex },
    models: [...models.entries()]
      .map(([model, count]) => ({ model, count }))
      .sort((left, right) => right.count - left.count || left.model.localeCompare(right.model)),
    running,
  };
}
