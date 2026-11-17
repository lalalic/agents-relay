function jobJelDiagram(job) {
    const lines = ['flowchart LR'];
    const safe = (value) => String(value ?? 'Unknown').replace(/https?:\/\/[^\s]*/gi, '').replace(/[^\p{L}\p{N} _./()—:-]/gu, '').slice(0, 100);
    const now = Date.now();
    const instant = (value) => {
        if (typeof value !== 'string' || !value)
            return null;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) && parsed <= now ? parsed : null;
    };
    const elapsed = (start, end) => {
        const from = instant(start);
        const to = end === 'NOW' ? now : instant(end);
        if (from === null || to === null || to < from)
            return '—';
        const seconds = Math.floor((to - from) / 1000);
        if (seconds < 60)
            return seconds + 's';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60)
            return minutes + 'm' + String(seconds % 60).padStart(2, '0') + 's';
        const hours = Math.floor(minutes / 60);
        if (hours < 24)
            return hours + 'h' + String(minutes % 60).padStart(2, '0') + 'm';
        return Math.floor(hours / 24) + 'd' + String(hours % 24).padStart(2, '0') + 'h';
    };
    const terminalTask = (task) => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.state || '');
    const workElapsed = (work) => {
        const starts = work.map(task => instant(task.createdAt)).filter((time) => time !== null);
        if (starts.length !== work.length || !starts.length)
            return '—';
        const ends = work.map(task => instant(task.updatedAt)).filter((time) => time !== null);
        return elapsed(new Date(Math.min(...starts)).toISOString(), work.every(terminalTask) && ends.length === work.length ? new Date(Math.max(...ends)).toISOString() : 'NOW');
    };
    const node = (id, label, time) => lines.push('  ' + id + '["' + safe(label).slice(0, 80) + ' (' + safe(time) + ')"]');
    const edge = (from, to, reason = '') => lines.push('  ' + from + ' -->' + (reason ? '|' + safe(reason) + '|' : '') + ' ' + to);
    const tasks = Array.isArray(job.tasks) ? job.tasks : [];
    const isReviewer = (task) => ['job-acceptance-reviewer', 'reviewer'].includes(task.agentName || '');
    const isTroubleshooter = (task) => task.agentName === 'troubleshooter';
    // These dashed observation branches are not workflow transitions: persisted
    // Task facts are projected without inferring a new scheduling decision.
    const diagnostics = (executionId, suffix, work, troubleshoot) => {
        const failed = new Set();
        const add = (kind, label, time, origin) => {
            const id = kind + '_' + suffix + '_' + String(lines.filter(line => line.startsWith('  ' + kind + '_' + suffix + '_')).length);
            node(id, label, time);
            lines.push('  ' + (origin ? taskNodeId(origin) : executionId) + ' -.-> ' + id);
            lines.push('  class ' + id + ' jel' + kind[0].toUpperCase() + kind.slice(1));
        };
        for (const task of work) {
            if (task.state === 'FAILED') {
                const key = (task.id || 'unknown') + ':' + String(task.attempt ?? '?');
                failed.add(key);
                add('failed', 'Failed', elapsed(task.createdAt, task.updatedAt), task);
            }
            if (typeof task.attempt === 'number' && Number.isInteger(task.attempt) && task.attempt > 1) {
                const history = Array.isArray(task.executionHistory) ? task.executionHistory : [];
                const current = history.slice().reverse().find(record => record.attempt === task.attempt);
                add('retry', 'Retry', elapsed(current?.startedAt, terminalTask(task) ? task.updatedAt : 'NOW'), task);
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
                    add('failed', 'Failed', '—', parent);
                }
            }
            add('troubleshooter', task.title || task.agentName || 'Troubleshooter', workElapsed([task]), parent);
        }
    };
    // Exact Task IDs, DAG lineage and dependencies are persisted facts, not inferred
    // workflow transitions. Task nodes are clickable in the dashboard after SVG sanitization.
    const taskNodeId = (task) => 'task_' + tasks.indexOf(task);
    const taskElapsed = (task) => {
        const end = terminalTask(task) ? task.updatedAt : 'NOW';
        const coordinator = (task.kind || '').toLowerCase() === 'coordinator' ||
            (/coordinator/i.test(task.agentName || '') && !task.dagNode) || !!task.agentGraph;
        const history = Array.isArray(task.executionHistory) ? task.executionHistory : [];
        const last = history.slice().reverse().find(record => record.attempt === task.attempt);
        const run = coordinator ? '—' : elapsed(last?.startedAt, end);
        return run !== '—' ? run : elapsed(task.createdAt, end);
    };
    const taskNodes = (stage, work) => {
        const byId = new Map(work.filter(task => task.id).map(task => [task.id, task]));
        for (const task of work) {
            const id = taskNodeId(task);
            node(id, task.title?.trim() || task.agentName?.trim() || task.id || 'Task', taskElapsed(task));
            if (task.state === 'FAILED')
                lines.push('  class ' + id + ' jelFailed');
            else if ((task.attempt || 0) > 1)
                lines.push('  class ' + id + ' jelRetry');
            const parent = task.parentTaskId ? byId.get(task.parentTaskId) : undefined;
            if (parent)
                edge(taskNodeId(parent), id, 'DAG child');
            else
                lines.push('  ' + stage + ' -.-> ' + id);
            for (const dependency of task.dependencies || []) {
                const upstream = byId.get(dependency);
                if (upstream && upstream !== parent)
                    edge(taskNodeId(upstream), id, 'depends');
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
    const jobEnd = ['COMPLETED', 'CANCELLED'].includes(job.state || '') ? job.updatedAt : 'NOW';
    const firstStart = plans[0]?.createdAt || (job.tasks || []).map(task => task.createdAt).filter(Boolean).sort()[0];
    node('created', 'Create', elapsed(job.createdAt, firstStart || jobEnd));
    const rounds = plans.length ? plans : [{ id: '', round: 1, status: 'NOT STARTED', generatedTaskIds: [] }];
    let previous = 'created';
    const allocated = new Set();
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
            for (const task of candidates)
                if (task.planningDecisionId === plan.id || task.planningRound === number)
                    assigned.add(task.id || '');
            // DAG children often have only parentTaskId; inherit the parent round.
            for (let depth = 0; depth < candidates.length; depth++) {
                let changed = false;
                for (const task of candidates)
                    if (task.parentTaskId && assigned.has(task.parentTaskId) && !assigned.has(task.id || '')) {
                        assigned.add(task.id || '');
                        changed = true;
                    }
                if (!changed)
                    break;
            }
        }
        const work = plans.length
            ? candidates.filter(task => !allocated.has(task.id || '') && (assigned.has(task.id || '') || (i === rounds.length - 1)))
            : candidates;
        for (const task of work)
            if (task.id)
                allocated.add(task.id);
        if (plans.length)
            node(planId, 'Plan ' + number, elapsed(plan.createdAt, plan.status === 'PLANNING' ? 'NOW' : plan.updatedAt));
        node(executeId, 'Execute ' + number, workElapsed(work));
        const workIds = new Set(work.map(task => task.id));
        const troubleshoot = tasks.filter(task => isTroubleshooter(task) &&
            (workIds.has(task.parentTaskId || '') || task.planningDecisionId === plan.id || !plans.length));
        taskNodes(executeId, work);
        diagnostics(executeId, suffix, work, troubleshoot);
        const nextPlan = plans[i + 1];
        // Review Tasks are not guaranteed to carry the Plan ID. Use their persisted
        // timestamps within the current round, never guess a Review duration.
        const reviewTasks = tasks.filter(task => isReviewer(task) &&
            (!plans.length || (instant(task.createdAt) !== null && instant(plan.createdAt) !== null &&
                instant(task.createdAt) >= instant(plan.createdAt) && (!nextPlan?.createdAt || (instant(nextPlan.createdAt) !== null && instant(task.createdAt) < instant(nextPlan.createdAt))))));
        node(reviewId, 'Final Review ' + number, workElapsed(reviewTasks));
        for (const task of reviewTasks) {
            node(taskNodeId(task), task.title?.trim() || task.agentName || task.id || 'Final Review', taskElapsed(task));
            lines.push('  ' + reviewId + ' -.-> ' + taskNodeId(task));
            lines.push('  class ' + taskNodeId(task) + (task.state === 'FAILED' ? ' jelFailed' : ' jelReviewer'));
        }
        if (plans.length) {
            edge(previous, planId, i > 0 && plan.trigger?.source === 'review' ? 'changes required' : '');
            edge(planId, executeId);
        }
        else
            edge(previous, executeId);
        edge(executeId, reviewId);
        previous = reviewId;
    }
    const merge = job.localMerge?.status === 'failed' ? 'FAILED' : job.localMerge?.status === 'succeeded' || job.githubState === 'MERGED' || job.publication?.version ? 'DONE' : job.state === 'COMPLETED' ? 'NOT RECORDED' : 'PENDING';
    const mergeStart = job.review?.outcome === 'approved' ? job.review.updatedAt : undefined;
    const mergeEnd = merge === 'DONE' ? job.localMerge?.updatedAt || job.mergedAt : merge === 'PENDING' && mergeStart ? 'NOW' : undefined;
    node('merge', 'Merge', elapsed(mergeStart, mergeEnd));
    node('finished', 'Job', elapsed(job.createdAt, jobEnd));
    edge(previous, 'merge');
    edge('merge', 'finished');
    return finish();
}
