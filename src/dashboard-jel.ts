/** A read-only graph projection of the persisted Job Execution Lifecycle. */
export interface JelJob {
  state?: string;
  createdAt?: string;
  updatedAt?: string;
  reviewEnabled?: boolean;
  plans?: Array<{ id?: string; round?: number; status?: string; createdAt?: string; updatedAt?: string; generatedTaskIds?: string[]; trigger?: { source?: string } }>;
  tasks?: Array<{ id?: string; title?: string; state?: string; planningDecisionId?: string; planningRound?: number; agentName?: string; kind?: string; agentGraph?: string; dagNode?: { nodeId?: string }; parentTaskId?: string | null; dependencies?: string[]; recoveryForAttempt?: number; attempt?: number; error?: string | null; failureReason?: string; executionHistory?: Array<{ attempt?: number; startedAt?: string }>; createdAt?: string; updatedAt?: string }>;
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
  const isReviewer = (task: (typeof tasks)[number]) => ['job-acceptance-reviewer', 'reviewer'].includes(task.agentName || '');
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
    const add = (kind: 'failed' | 'retry' | 'troubleshooter', label: string, time: string, origin?: (typeof tasks)[number]) => {
      const id = kind + '_' + suffix + '_' + String(lines.filter(line => line.startsWith('  '+kind+'_'+suffix+'_')).length);
      node(id, label, time);
      lines.push('  ' + (origin ? taskNodeId(origin) : executionId) + ' -.-> ' + id);
      lines.push('  class ' + id + ' jel' + kind[0].toUpperCase() + kind.slice(1));
    };
    for (const task of work) {
      if (task.state === 'FAILED') {
        const key = (task.id || 'unknown') + ':' + String(task.attempt ?? '?');
        failed.add(key);
        add('failed', 'Failed ' + (task.id || 'unknown') + ' / attempt ' + (task.attempt || 'unknown'), elapsed(task.createdAt, task.updatedAt), task);
      }
      if (typeof task.attempt === 'number' && Number.isInteger(task.attempt) && task.attempt > 1) {
        const history = Array.isArray(task.executionHistory) ? task.executionHistory : [];
        const current = history.slice().reverse().find(record => record.attempt === task.attempt);
        add('retry', 'Retry ' + (task.id || 'unknown') + ' / ' + (task.attempt - 1) + ' retries / attempt ' + task.attempt,
          elapsed(current?.startedAt, terminalTask(task) ? task.updatedAt : 'NOW'), task);
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
          add('failed', 'Failed ' + (parent.id || 'unknown') + ' / attempt ' + task.recoveryForAttempt, 'unknown', parent);
        }
      }
      add('troubleshooter', 'Troubleshooter ' + (task.id || 'unknown') + ' / ' + state(task.state, 'UNKNOWN'), workElapsed([task]), parent);
    }
  };
  // Exact Task IDs, DAG lineage and dependencies are persisted facts, not inferred
  // workflow transitions. Task nodes are clickable in the dashboard after SVG sanitization.
  const taskNodeId = (task: (typeof tasks)[number]) => 'task_' + tasks.indexOf(task);
  const taskElapsed = (task: (typeof tasks)[number]) =>
    elapsed(task.createdAt, terminalTask(task) ? task.updatedAt : 'NOW');
  const taskNodes = (stage: string, work: typeof tasks) => {
    const byId = new Map(work.filter(task => task.id).map(task => [task.id, task]));
    for (const task of work) {
      const name = task.agentName || task.kind || 'agent';
      const title = task.title ? ' / ' + task.title.slice(0, 60) : '';
      const dag = task.dagNode?.nodeId ? ' / DAG ' + task.dagNode.nodeId : '';
      const attempts = task.attempt && task.attempt > 1 ? ' / attempt ' + task.attempt : '';
      const history = Array.isArray(task.executionHistory) ? task.executionHistory : [];
      const last = history.slice().reverse().find(record => record.attempt === task.attempt);
      const isCoordinator = (task.kind || '').toLowerCase() === 'coordinator' || (/coordinator/i.test(task.agentName || '') && !task.dagNode) || !!task.agentGraph;
      const queue = history.length && !isCoordinator ? ' / queue ' + elapsed(task.createdAt, history[0].startedAt) : '';
      const run = last && !isCoordinator ? ' / last run ' + elapsed(last.startedAt, terminalTask(task) ? task.updatedAt : 'NOW') : '';
      const id = taskNodeId(task);
      node(id, 'Task ' + (task.id || '?') + ' / ' + name + dag + title + ' / ' + state(task.state, 'UNKNOWN') + attempts + queue + run, taskElapsed(task));
      if (task.state === 'FAILED') lines.push('  class ' + id + ' jelFailed');
      else if ((task.attempt || 0) > 1) lines.push('  class ' + id + ' jelRetry');
      const parent = task.parentTaskId ? byId.get(task.parentTaskId) : undefined;
      if (parent) edge(taskNodeId(parent), id, 'DAG child');
      else lines.push('  ' + stage + ' -.-> ' + id);
      for (const dependency of task.dependencies || []) {
        const upstream = byId.get(dependency);
        if (upstream && upstream !== parent) edge(taskNodeId(upstream), id, 'depends');
      }
    }
  };
  const finish = () => {
    // The browser applies the same palette *after* SVG sanitization; Mermaid
    // styling alone is not trusted to survive the safe SVG renderer.
    lines.push('  classDef jelFailed fill:#fee2e2,stroke:#b91c1c,color:#991b1b,stroke-width:2px');
    lines.push('  classDef jelRetry fill:#ede9fe,stroke:#7c3aed,color:#5b21b6,stroke-width:2px');
    lines.push('  classDef jelTroubleshooter fill:#fef3c7,stroke:#b45309,color:#92400e,stroke-width:2px');
    lines.push('  classDef jelReviewer fill:#dbeafe,stroke:#2563eb,color:#1e40af,stroke-width:2px');
    return lines.join('\n');
  };
  const plans = Array.isArray(job.plans) ? job.plans : [];
  const jobEnd = ['COMPLETED','CANCELLED'].includes(job.state || '') ? job.updatedAt : 'NOW';
  const firstStart = plans[0]?.createdAt || (job.tasks || []).map(task => task.createdAt).filter(Boolean).sort()[0];
  node('created', 'Create / recorded', elapsed(job.createdAt, firstStart || jobEnd));
  const rounds = plans.length ? plans : [{ id: '', round: 1, status: 'NOT STARTED', generatedTaskIds: [] as string[] }];
  let previous = 'created';
  const allocated = new Set<string>();
  for (let i = 0; i < rounds.length; i++) {
    const plan = rounds[i];
    const number = Number.isInteger(plan.round) && (plan.round ?? 0) > 0 ? plan.round : i + 1;
    const suffix = String(i + 1);
    const planId = 'plan_' + suffix;
    const executeId = 'execute_' + suffix;
    const reviewId = 'review_' + suffix;
    const assigned = new Set(Array.isArray(plan.generatedTaskIds) ? plan.generatedTaskIds : []);
    const candidates = tasks.filter(task => !isReviewer(task) && !isTroubleshooter(task));
    if (plans.length) {
      for (const task of candidates) if (task.planningDecisionId === plan.id || task.planningRound === number) assigned.add(task.id || '');
      // DAG children often have only parentTaskId; inherit the parent round.
      for (let depth = 0; depth < candidates.length; depth++) {
        let changed = false;
        for (const task of candidates) if (task.parentTaskId && assigned.has(task.parentTaskId) && !assigned.has(task.id || '')) {
          assigned.add(task.id || ''); changed = true;
        }
        if (!changed) break;
      }
    }
    const work = plans.length
      ? candidates.filter(task => !allocated.has(task.id || '') && (assigned.has(task.id || '') || (i === rounds.length - 1)))
      : candidates;
    for (const task of work) if (task.id) allocated.add(task.id);
    if(plans.length)node(planId, 'Plan ' + number + ' / ' + state(plan.status, 'NOT STARTED'), elapsed(plan.createdAt, plan.status === 'PLANNING' ? 'NOW' : plan.updatedAt));
    node(executeId, 'Execute ' + number + ' / ' + workLabel(work), workElapsed(work));
    const workIds = new Set(work.map(task => task.id));
    const troubleshoot = tasks.filter(task => isTroubleshooter(task) &&
      (workIds.has(task.parentTaskId || '') || task.planningDecisionId === plan.id || !plans.length));
    taskNodes(executeId, work);
    diagnostics(executeId, suffix, work, troubleshoot);
    const nextPlan = plans[i + 1];
    const review = job.reviewEnabled === false ? 'NOT REQUIRED' : nextPlan?.trigger?.source === 'review' ? 'CHANGES REQUIRED' : i === rounds.length - 1 ? state(job.review?.outcome, 'NOT STARTED') : 'NOT RECORDED';
    // Review Tasks are not guaranteed to carry the Plan ID. Use their persisted
    // timestamps within the current round, never guess a Review duration.
    const reviewTasks = tasks.filter(task => isReviewer(task) &&
      (!plans.length || (instant(task.createdAt) !== null && instant(plan.createdAt) !== null &&
        instant(task.createdAt)! >= instant(plan.createdAt)! && (!nextPlan?.createdAt || (instant(nextPlan.createdAt) !== null && instant(task.createdAt)! < instant(nextPlan.createdAt)!)))));
    node(reviewId, 'Final Review ' + number + ' / ' + review, workElapsed(reviewTasks));
    for (const task of reviewTasks) {
      node(taskNodeId(task), 'Final Review Task ' + (task.id || '?') + ' / ' + (task.agentName || 'reviewer') + ' / ' + state(task.state, 'UNKNOWN'), taskElapsed(task));
      lines.push('  ' + reviewId + ' -.-> ' + taskNodeId(task));
      lines.push('  class ' + taskNodeId(task) + (task.state === 'FAILED' ? ' jelFailed' : ' jelReviewer'));
    }
    if(plans.length){edge(previous, planId, i > 0 && plan.trigger?.source === 'review' ? 'changes required' : '');edge(planId, executeId);}
    else edge(previous,executeId);
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

/** Read-only timings for the JEL inspector. No synthetic attempt end timestamps. */
export function jobJelHotspots(job: JelJob): Array<{
  id: string; agent: string; phase: string; state: string; attempt: number;
  queueMs: number | null; runMs: number | null; wallMs: number | null;
  issue: string;
}> {
  const now = Date.now();
  const date = (value: unknown): number | null => {
    if (typeof value !== 'string' || !value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed <= now ? parsed : null;
  };
  const duration = (start: number | null, end: number | null): number | null =>
    start !== null && end !== null && end >= start ? end - start : null;
  return (Array.isArray(job.tasks) ? job.tasks : []).map(task => {
    const history = Array.isArray(task.executionHistory) ? task.executionHistory : [];
    const first = history.map(entry => date(entry.startedAt)).filter((time): time is number => time !== null).sort((a, b) => a - b)[0] ?? null;
    const last = history.slice().reverse().find(entry => entry.attempt === task.attempt);
    const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.state || '');
    const coordinator = (task.kind || '').toLowerCase() === 'coordinator' || (/coordinator/i.test(task.agentName || '') && !task.dagNode) || !!task.agentGraph;
    const end = terminal ? date(task.updatedAt) : now;
    const start = date(task.createdAt);
    return {
      id: task.id || '?',
      agent: task.agentName || task.kind || 'agent',
      phase: ['job-acceptance-reviewer', 'reviewer'].includes(task.agentName || '') ? 'Final Review' : task.agentName === 'troubleshooter' ? 'Troubleshooter' : coordinator ? 'Coordinator' : task.dagNode?.nodeId ? 'DAG' : 'Task',
      state: task.state || 'UNKNOWN',
      attempt: task.attempt || 0,
      queueMs: coordinator ? null : first !== null ? duration(start, first) : task.state === 'QUEUED' ? duration(start, now) : null,
      runMs: coordinator ? null : duration(date(last?.startedAt), end),
      wallMs: duration(start, end),
      issue: String(task.failureReason || task.error || '').slice(0, 240),
    };
  });
}
