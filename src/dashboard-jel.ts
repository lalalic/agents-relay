/** A read-only graph projection of the persisted Job Execution Lifecycle. */
export interface JelJob {
  state?: string;
  createdAt?: string;
  updatedAt?: string;
  executionMode?: string;
  reviewEnabled?: boolean;
  plans?: Array<{ id?: string; round?: number; status?: string; createdAt?: string; updatedAt?: string; generatedTaskIds?: string[]; trigger?: { source?: string } }>;
  tasks?: Array<{ id?: string; state?: string; planningDecisionId?: string; agentName?: string; parentTaskId?: string | null; recoveryForAttempt?: number; attempt?: number; executionHistory?: Array<{ attempt?: number; startedAt?: string }>; createdAt?: string; updatedAt?: string }>;
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
  const isTroubleshooter = (task: (typeof tasks)[number]) => task.agentName === 'troubleshooter';
  const state = (value: unknown, fallback: string) => typeof value === 'string' && value ? safe(value).toUpperCase() : fallback;
  const workLabel = (work: typeof tasks) => {
    const succeeded = work.filter(task => task.state === 'SUCCEEDED').length;
    const failed = work.filter(task => task.state === 'FAILED').length;
    const active = work.filter(task => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.state || '')).length;
    return work.length + ' tasks / ' + succeeded + ' succeeded / ' + failed + ' failed / ' + active + ' active';
  };
  // These dashed observation branches are not workflow transitions: persisted
  // Task facts are projected without inferring a new scheduling decision.
  const diagnostics = (executionId: string, suffix: string, work: typeof tasks, troubleshoot: typeof tasks) => {
    const failed = new Set<string>();
    const add = (kind: 'failed' | 'retry' | 'troubleshooter', label: string, time: string) => {
      const id = kind + '_' + suffix + '_' + String(lines.filter(line => line.startsWith('  '+kind+'_'+suffix+'_')).length);
      node(id, label, time);
      lines.push('  ' + executionId + ' -.-> ' + id);
      lines.push('  class ' + id + ' jel' + kind[0].toUpperCase() + kind.slice(1));
    };
    for (const task of work) {
      if (task.state === 'FAILED') {
        const key = (task.id || 'unknown') + ':' + String(task.attempt ?? '?');
        failed.add(key);
        add('failed', 'Failed ' + (task.id || 'unknown') + ' / attempt ' + (task.attempt || 'unknown'), elapsed(task.createdAt, task.updatedAt));
      }
      if (typeof task.attempt === 'number' && Number.isInteger(task.attempt) && task.attempt > 1) {
        const history = Array.isArray(task.executionHistory) ? task.executionHistory : [];
        const current = history.slice().reverse().find(record => record.attempt === task.attempt);
        add('retry', 'Retry ' + (task.id || 'unknown') + ' / ' + (task.attempt - 1) + ' retries / attempt ' + task.attempt,
          elapsed(current?.startedAt, terminalTask(task) ? task.updatedAt : 'NOW'));
      }
    }
    for (const task of troubleshoot) {
      const parent = work.find(candidate => candidate.id === task.parentTaskId);
      if (parent && Number.isInteger(task.recoveryForAttempt) && (task.recoveryForAttempt ?? 0) > 0) {
        const key = (parent.id || 'unknown') + ':' + task.recoveryForAttempt;
        if (!failed.has(key)) {
          failed.add(key);
          // Recovery-for-attempt is durable evidence of a failed attempt, but
          // not of its terminal timestamp: display unknown, never fabricate.
          add('failed', 'Failed ' + (parent.id || 'unknown') + ' / attempt ' + task.recoveryForAttempt, 'unknown');
        }
      }
      add('troubleshooter', 'Troubleshooter ' + (task.id || 'unknown') + ' / ' + state(task.state, 'UNKNOWN'), workElapsed([task]));
    }
  };
  const finish = () => {
    // The browser applies the same palette *after* SVG sanitization; Mermaid
    // styling alone is not trusted to survive the safe SVG renderer.
    lines.push('  classDef jelFailed fill:#fee2e2,stroke:#b91c1c,color:#991b1b,stroke-width:2px');
    lines.push('  classDef jelRetry fill:#ede9fe,stroke:#7c3aed,color:#5b21b6,stroke-width:2px');
    lines.push('  classDef jelTroubleshooter fill:#fef3c7,stroke:#b45309,color:#92400e,stroke-width:2px');
    return lines.join('\n');
  };
  const plans = Array.isArray(job.plans) ? job.plans : [];
  const jobEnd = ['COMPLETED','CANCELLED'].includes(job.state || '') ? job.updatedAt : 'NOW';
  const firstStart = plans[0]?.createdAt || (job.tasks || []).map(task => task.createdAt).filter(Boolean).sort()[0];
  node('created', 'Create / recorded', elapsed(job.createdAt, firstStart || jobEnd));
  if (job.executionMode === 'shortcut') {
    const work = tasks.filter(task => !isReviewer(task) && !isTroubleshooter(task));
    node('execute', 'Shortcut execute / ' + workLabel(work), workElapsed(work));
    diagnostics('execute', 'shortcut', work, tasks.filter(isTroubleshooter));
    node('finished', 'Job / ' + state(job.state, 'UNKNOWN'), elapsed(job.createdAt, jobEnd));
    edge('created', 'execute');
    edge('execute', 'finished');
    return finish();
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
    const work = (plans.length ? tasks.filter(task => !isReviewer(task) && !isTroubleshooter(task) && (task.planningDecisionId === plan.id || assigned.has(task.id || ''))) : tasks.filter(task => !isReviewer(task) && !isTroubleshooter(task)));
    node(planId, 'Plan ' + number + ' / ' + state(plan.status, 'NOT STARTED'), elapsed(plan.createdAt, plan.status === 'PLANNING' ? 'NOW' : plan.updatedAt));
    node(executeId, 'Execute ' + number + ' / ' + workLabel(work), workElapsed(work));
    const workIds = new Set(work.map(task => task.id));
    const troubleshoot = tasks.filter(task => isTroubleshooter(task) &&
      (workIds.has(task.parentTaskId || '') || task.planningDecisionId === plan.id || !plans.length));
    diagnostics(executeId, suffix, work, troubleshoot);
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
  return finish();
}
