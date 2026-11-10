/** A read-only graph projection of the persisted Job Execution Lifecycle. */
export interface JelJob {
  state?: string;
  createdAt?: string;
  updatedAt?: string;
  executionMode?: string;
  reviewEnabled?: boolean;
  plans?: Array<{ id?: string; round?: number; status?: string; createdAt?: string; updatedAt?: string; generatedTaskIds?: string[]; trigger?: { source?: string } }>;
  tasks?: Array<{ id?: string; state?: string; planningDecisionId?: string; agentName?: string; createdAt?: string; updatedAt?: string }>;
  review?: { outcome?: string; updatedAt?: string };
  localMerge?: { status?: string; updatedAt?: string };
  githubState?: string;
  mergedAt?: string;
  publication?: { version?: string };
}

/** Keep this function self-contained: dashboard-html embeds its JS source in the browser. */
export function jobJelDiagram(job: JelJob): string {
  const lines = ['flowchart LR'];
  const safe = (value: unknown) => String(value ?? 'Unknown').replace(/[^A-Za-z0-9 _./-]/g, '').slice(0, 240);
  const now = Date.now();
  const instant = (value: unknown): number | null => {
    if (typeof value !== 'string' || !value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed <= now ? parsed : null;
  };
  const elapsed = (start: unknown, end: unknown): string => {
    const from = instant(start);
    const to = end === 'NOW' ? now : instant(end);
    if (from === null || to === null || to < from) return 'unknown';
    const seconds = Math.floor((to - from) / 1000);
    if (seconds < 60) return seconds + 's';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ' + seconds % 60 + 's';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ' + minutes % 60 + 'm';
    return Math.floor(hours / 24) + 'd ' + hours % 24 + 'h';
  };
  const terminalTask = (task: NonNullable<typeof job.tasks>[number]) => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.state || '');
  const workElapsed = (work: NonNullable<typeof job.tasks>): string => {
    const starts = work.map(task => instant(task.createdAt)).filter((time): time is number => time !== null);
    if (starts.length !== work.length || !starts.length) return 'unknown';
    const ends = work.map(task => instant(task.updatedAt)).filter((time): time is number => time !== null);
    return elapsed(new Date(Math.min(...starts)).toISOString(), work.every(terminalTask) && ends.length === work.length ? new Date(Math.max(...ends)).toISOString() : 'NOW');
  };
  const node = (id: string, label: string, time: string) => lines.push('  ' + id + '["' + safe(label + ' / elapsed ' + time) + '"]');
  const edge = (from: string, to: string, reason = '') => lines.push('  ' + from + ' -->' + (reason ? '|' + safe(reason) + '|' : '') + ' ' + to);
  const tasks = Array.isArray(job.tasks) ? job.tasks : [];
  const isReviewer = (task: (typeof tasks)[number]) => task.agentName === 'job-acceptance-reviewer';
  const state = (value: unknown, fallback: string) => typeof value === 'string' && value ? safe(value).toUpperCase() : fallback;
  const workLabel = (work: typeof tasks) => {
    const succeeded = work.filter(task => task.state === 'SUCCEEDED').length;
    const failed = work.filter(task => task.state === 'FAILED').length;
    const active = work.filter(task => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.state || '')).length;
    return work.length + ' tasks / ' + succeeded + ' succeeded / ' + failed + ' failed / ' + active + ' active';
  };
  const plans = Array.isArray(job.plans) ? job.plans : [];
  const jobEnd = ['COMPLETED','CANCELLED'].includes(job.state || '') ? job.updatedAt : 'NOW';
  const firstStart = plans[0]?.createdAt || (job.tasks || []).map(task => task.createdAt).filter(Boolean).sort()[0];
  node('created', 'Create / recorded', elapsed(job.createdAt, firstStart || jobEnd));
  if (job.executionMode === 'shortcut') {
    const work = tasks.filter(task => !isReviewer(task));
    node('execute', 'Shortcut execute / ' + workLabel(work), workElapsed(work));
    node('finished', 'Job / ' + state(job.state, 'UNKNOWN'), elapsed(job.createdAt, jobEnd));
    edge('created', 'execute');
    edge('execute', 'finished');
    return lines.join('\n');
  }
  const rounds = plans.length ? plans : [{ id: '', round: 1, status: 'NOT STARTED', generatedTaskIds: [] as string[] }];
  let previous = 'created';
  for (let i = 0; i < rounds.length; i++) {
    const plan = rounds[i];
    const number = Number.isInteger(plan.round) && (plan.round ?? 0) > 0 ? plan.round : i + 1;
    const suffix = String(i + 1);
    const planId = 'plan_' + suffix;
    const executeId = 'execute_' + suffix;
    const reviewId = 'review_' + suffix;
    const assigned = new Set(Array.isArray(plan.generatedTaskIds) ? plan.generatedTaskIds : []);
    const work = (plans.length ? tasks.filter(task => !isReviewer(task) && (task.planningDecisionId === plan.id || assigned.has(task.id || ''))) : tasks.filter(task => !isReviewer(task)));
    node(planId, 'Plan ' + number + ' / ' + state(plan.status, 'NOT STARTED'), elapsed(plan.createdAt, plan.status === 'PLANNING' ? 'NOW' : plan.updatedAt));
    node(executeId, 'Execute ' + number + ' / ' + workLabel(work), workElapsed(work));
    const nextPlan = plans[i + 1];
    const review = job.reviewEnabled === false ? 'NOT REQUIRED' : nextPlan?.trigger?.source === 'review' ? 'CHANGES REQUIRED' : i === rounds.length - 1 ? state(job.review?.outcome, 'NOT STARTED') : 'NOT RECORDED';
    // Review Tasks are not guaranteed to carry the Plan ID. Use their persisted
    // timestamps within the current round, never guess a Review duration.
    const reviewTasks = tasks.filter(task => isReviewer(task) && instant(task.createdAt) !== null && instant(plan.createdAt) !== null &&
      instant(task.createdAt)! >= instant(plan.createdAt)! && (!nextPlan?.createdAt || (instant(nextPlan.createdAt) !== null && instant(task.createdAt)! < instant(nextPlan.createdAt)!)));
    node(reviewId, 'Final Review ' + number + ' / ' + review, workElapsed(reviewTasks));
    edge(previous, planId, i > 0 && plan.trigger?.source === 'review' ? 'changes required' : '');
    edge(planId, executeId);
    edge(executeId, reviewId);
    previous = reviewId;
  }
  const merge = job.localMerge?.status === 'failed' ? 'FAILED' : job.localMerge?.status === 'succeeded' || job.githubState === 'MERGED' || job.publication?.version ? 'DONE' : job.state === 'COMPLETED' ? 'NOT RECORDED' : 'PENDING';
  const mergeStart = job.review?.outcome === 'approved' ? job.review.updatedAt : undefined;
  const mergeEnd = merge === 'DONE' ? job.localMerge?.updatedAt || job.mergedAt : merge === 'PENDING' && mergeStart ? 'NOW' : undefined;
  node('merge', 'Merge / ' + merge, elapsed(mergeStart, mergeEnd));
  node('finished', 'Job / ' + state(job.state, 'UNKNOWN'), elapsed(job.createdAt, jobEnd));
  edge(previous, 'merge');
  edge('merge', 'finished');
  return lines.join('\n');
}
