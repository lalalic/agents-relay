import { Job, Task, EventRecord, ReviewOutcome, storySizeTimeoutMs, taskOverallTimeoutMs } from './types.js';
import { completionGateSatisfied, schedule, transitionTaskEvent, transitionJobEvent, tryTransitionTaskEvent } from './scheduler.js';
import { implementationComplete, implementationTasks } from './runtime-status.js';
import { eventFor } from './events.js';
import { RoutingDecision, WorkerSelection } from './types.js';
import { workerCandidates, type WorkerCandidate } from './worker-routing.js';
import { routeExecution } from './execution-routing.js';
import { ReconcilerRuntimeBase, type EventHandlingResult, withExecutionBoundary } from './reconciler-runtime.js';

const taskRouteClaims = new Set<string>();

export abstract class ReconcilerReviewBase extends ReconcilerRuntimeBase {
  protected abstract launch(job: Job, task: Task): Promise<void>;
  protected async currentHeadSha(job: Job): Promise<string | null> { return await this.store.headSha?.() ?? job.headSha ?? job.review?.headSha ?? null; }
  protected async invalidateStaleReview(job: Job, headSha: string | null): Promise<void> {
    if (!headSha || !job.review || job.review.headSha === headSha || job.review.outcome === 'stale') return;
    job.review = { ...job.review, outcome: 'stale', updatedAt: new Date().toISOString() };
    const staleTask = job.review.taskId ? job.tasks.find(task => task.id === job.review?.taskId) : undefined;
    if (staleTask && ['DRAFT', 'QUEUED', 'RUNNING'].includes(staleTask.state)) {
      this.live.get(staleTask.id)?.execution.cancel();
      await transitionTaskEvent(staleTask, 'cancel');
      staleTask.error = 'Review evidence became stale after the PR head changed';
      staleTask.leaseOwner = null;
      staleTask.leaseExpiresAt = null;
      await this.store.saveTask(staleTask);
    }
    await this.store.saveJob(job);
  }
  protected async ensureFinalReview(job: Job, prState: string, headSha: string | null): Promise<void> {
    if (job.schedule || job.reviewEnabled === false || prState !== 'OPEN' || job.state !== 'ACTIVE' || !implementationComplete(job) || !headSha) return;
    if (job.executionMode === 'autonomous' && !completionGateSatisfied(job)) return;
    const review = job.review;
    if (review?.headSha === headSha && ['started', 'approved', 'changes_required', 'blocked'].includes(review.outcome)) return;
    const reviewTasks = job.tasks.filter(task => task.agentName === 'reviewer' && task.reviewHeadSha === headSha);
    if (reviewTasks.some(task => ['DRAFT', 'QUEUED', 'RUNNING'].includes(task.state))) return;
    if (reviewTasks.some(task => task.state === 'SUCCEEDED' && review?.headSha === headSha && review.outcome === 'approved')) return;
    const id = `final-review-${headSha.slice(0, 12)}`;
    const now = new Date().toISOString();
    const reviewGateTasks = implementationTasks(job);
    const reviewerRouting = await this.selectReviewer(reviewGateTasks);
    const task: Task = { jobId: job.id, id, kind: 'work', priority: job.priority, storySize: 'M', projectName: job.title, agentName: 'reviewer', parentTaskId: null, dependencies: reviewGateTasks.map(item => item.id), capabilities: ['review'], workerSelection: reviewerRouting.selection, adapter: reviewerRouting.candidate.adapter, input: `Review existing PR #${job.prNumber} at exactly head SHA ${headSha}. Job objective: ${job.objective ?? job.description ?? job.title}. Use the selected reviewer agent contract as the authoritative review protocol.`, output: { kind: 'task_pr' }, routing: reviewerRouting.candidate.routing, continuation: null, continuationDeliveredAt: null, reviewHeadSha: headSha, state: 'QUEUED', attempt: 0, maxAttempts: this.options.reviewer?.maxAttempts ?? 2, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, plannerResult: null, error: null, timeoutMs: this.options.reviewer?.timeoutMs ?? storySizeTimeoutMs('M'), createdAt: now, updatedAt: now };

    await this.store.appendTask(task);
    job.review = { outcome: 'pending', headSha, taskId: id, evidence: null, updatedAt: now };
    job.updatedAt = now;
    await this.store.saveJob(job);
    await this.emit(eventFor(job.id, id, null, 'review.created', 'queued', `Final review task ${id} created for ${headSha} using ${reviewerRouting.reason}`, 'orchestrator', { headSha, agentName: 'reviewer', reviewerRouting: { workerId: reviewerRouting.selection.workerId, reason: reviewerRouting.reason, selectedBy: reviewerRouting.selection.selectedBy } }));
    const ready = schedule(await this.store.load(job.id));
    await this.store.saveJob(ready);
  }
  protected async selectReviewer(implementationTasks: readonly Task[]): Promise<{ candidate: WorkerCandidate & { routing: RoutingDecision }; selection: WorkerSelection; reason: 'worker-router' }> {
    const configured = this.options.reviewer;
    const registered = await this.store.listAgents();
    const usage = this.options.usageSnapshotProvider ? await this.options.usageSnapshotProvider() : undefined;
    let workers = workerCandidates(this.options.adapters, registered, usage).filter(candidate => {
      if (configured?.workerId && configured.workerId !== candidate.workerId) return false;
      if (configured?.adapter && configured.adapter !== candidate.adapter) return false;
      return true;
    });
    // Explicit reviewer runtime/routing is a caller-owned hard constraint and remains
    // usable in isolated/test runtimes that do not instantiate that adapter. It still
    // flows through the same Worker Router path as every other executable task.
    if (workers.length === 0 && configured?.adapter && configured.routing) {
      workers = [{
        workerId: configured.workerId ?? configured.adapter,
        adapter: configured.adapter,
        capabilities: ['model'],
        runtime: configured.adapter,
      }];
    }

    const implementationWorkers = implementationTasks.map(task => task.workerSelection?.workerId ?? task.adapter);
    const implementationRoutes = implementationTasks.filter(task => task.routing).map(task => ({
      provider: task.routing!.provider,
      model: task.routing!.model,
    }));
    const taskFacts = {
      role: 'reviewer',
      reviewer_diversity: {
        preference: 'Prefer a worker/provider-model identity different from implementation when otherwise suitable; this is a soft preference below user environment rules.',
        implementation_workers: implementationWorkers,
        implementation_routes: implementationRoutes,
      },
    };
    const runtimeSummary = this.options.runtimeSummaryProvider?.();
    const routed = await routeExecution(workers, configured?.requirements ?? { capabilities: ['model'] }, {
      decisionEngine: this.options.decisionEngine,
      decisionMode: this.options.decisionMode,
      taskFacts,
      usage,
      registered,
      chatgptRunning: runtimeSummary?.chatgptRunning ?? 0,
      routingConstraints: configured?.routing,
    });
    return {
      candidate: routed.candidate,
      selection: routed.selection,
      reason: 'worker-router',
    };
  }
  protected async routeExecutableTasks(job: Job): Promise<void> {
    const usage = this.options.usageSnapshotProvider ? await this.options.usageSnapshotProvider() : undefined;
    const registered = await this.store.listAgents();
    const candidates = workerCandidates(this.options.adapters, registered, usage);
    const runtimeSummary = this.options.runtimeSummaryProvider?.();
    for (const candidate of job.tasks.filter(item => item.kind !== 'planner' && item.agentName !== 'reviewer' && item.adapter !== 'orchestrator' && ['QUEUED', 'BLOCKED'].includes(item.state) && item.output && !item.workerSelection && (item.workerRequirements || item.planningSource === 'model-planner'))) {
      const claimKey = `${job.id}/${candidate.id}`;
      if (taskRouteClaims.has(claimKey)) continue;
      taskRouteClaims.add(claimKey);
      try {
        await withExecutionBoundary(job.id, candidate.id, async () => {
          const freshJob = await this.store.load(job.id);
          const task = freshJob.tasks.find(item => item.id === candidate.id);
          if (!task || !['QUEUED', 'BLOCKED'].includes(task.state) || task.workerSelection || !task.output) return;
      const requirements = task.workerRequirements ?? { capabilities: [] };
      const taskFacts = {
        id: task.id,
        kind: task.kind ?? 'work',
        storySize: task.storySize ?? 'M',
        agentName: task.agentName ?? null,
        input: task.input,
        attachments: task.attachments ?? [],
        output: task.output ?? null,
      };
      const routingConstraints = task.routing ? { provider: task.routing.provider, model: task.routing.model, profile: task.routing.profile, reasoning: task.routing.reasoning } : undefined;
      const parent = task.agentName === 'troubleshooter' && task.parentTaskId ? freshJob.tasks.find(item => item.id === task.parentTaskId) : undefined;
      const parentRouteFailedBeforeStart = Boolean(parent?.routing && /exited before publishing task\.started|worker_exit_before_start|launch failed/i.test(parent.error ?? parent.failureReason ?? ''));
      const excludedRoutes = parentRouteFailedBeforeStart && parent?.routing
        ? [{ provider: parent.routing.provider, model: parent.routing.model, profile: parent.routing.profile }]
        : [];
      const routed = await routeExecution(candidates, requirements, {
        decisionEngine: this.options.decisionEngine,
        decisionMode: this.options.decisionMode,
        taskFacts: { ...taskFacts, recovery_parent_failed_route: excludedRoutes[0] ?? null },
        usage,
        registered,
        chatgptRunning: runtimeSummary?.chatgptRunning ?? 0,
        routingConstraints,
        excludedRoutes,
        auditStore: this.options.decisionAuditStore,
        auditTask: task,
      });
      task.workerSelection = routed.selection;
      task.adapter = routed.candidate.adapter;
      task.routing = routed.candidate.routing;
      task.timeoutMs = task.timeoutMs || taskOverallTimeoutMs(task.storySize ?? 'M', task.routing.reasoning);
      task.updatedAt = new Date().toISOString();
      await this.store.saveTask(task);
      await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'worker.selected', 'queued', `Worker ${routed.selection.workerId} selected for task ${task.id}`, 'user', { workerSelection: routed.selection, workerRequirements: requirements }, { agent: 'relay', component: 'agents-relay' }));
      await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'model.selected', 'queued', `Selected ${task.routing.model} · thinking ${task.routing.reasoning ?? 'unknown'}`, 'user', { routing: task.routing }, { agent: 'relay', component: 'agents-relay' }));
        });
      } finally {
        taskRouteClaims.delete(claimKey);
      }
    }
  }
  protected async applyReviewEvent(event: EventRecord): Promise<EventHandlingResult> {
    const job = await this.store.load(event.job_id);
    const task = job.tasks.find(item => item.id === event.task_id && item.agentName === 'reviewer');
    const reviewData = event.data?.review && typeof event.data.review === 'object' ? event.data.review as Record<string, unknown> : undefined;
    const headSha = typeof reviewData?.headSha === 'string' ? reviewData.headSha : typeof event.data?.headSha === 'string' ? event.data.headSha : task?.reviewHeadSha;
    if (!task || !headSha || task.reviewHeadSha !== headSha) return { applied: false, reconcile: false, reason: `${event.type}.ignored` };
    const outcome: ReviewOutcome = event.type === 'review.started' ? 'started' : event.type === 'review.approved' ? 'approved' : event.type === 'review.changes_required' ? 'changes_required' : 'blocked';
    const currentHeadSha = await this.store.headSha?.();
    if ((currentHeadSha && currentHeadSha !== headSha) || (job.headSha && job.headSha !== headSha)) return { applied: false, reconcile: false, reason: `${event.type}.stale` };
    const taskDecision = tryTransitionTaskEvent(task, event.type);
    if (!taskDecision.accepted || !taskDecision.target) return { applied: false, reconcile: false, reason: `${event.type}.ignored` };
    task.error = null;
    if (taskDecision.target !== 'RUNNING') {
      task.leaseOwner = null;
      task.leaseExpiresAt = null;
      task.executionId = null;
    }
    await this.store.saveTask(task);

    const evidence = { summary: event.message || `Review ${outcome}`, data: { ...(event.data ?? {}), review: reviewData ?? { headSha }, headSha, outcome } };
    job.review = { outcome, headSha, taskId: task.id, evidence, updatedAt: event.timestamp || new Date().toISOString() };

    if (outcome === 'changes_required') {
      const rawIssues = Array.isArray(reviewData?.issues) ? reviewData.issues : [];
      const issues = rawIssues.map(item => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object') {
          const value = item as Record<string, unknown>;
          const summary = typeof value.summary === 'string' ? value.summary : typeof value.message === 'string' ? value.message : typeof value.title === 'string' ? value.title : '';
          return summary.trim();
        }
        return '';
      }).filter(Boolean);
      if (issues.length === 0) issues.push(event.message || 'Address the reviewer-requested changes');
      const now = event.timestamp || new Date().toISOString();
      const id = `review-fix-${headSha.slice(0, 8)}`;
      if (!job.tasks.some(item => item.id === id)) {
        const input = `Address all reviewer findings for PR #${job.prNumber} at ${headSha}:\n\n${issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}`;
        const fixTask: Task = {
          jobId: job.id, id, kind: 'work', priority: job.priority, storySize: 'M', projectName: job.title,
          agentName: 'implementation', parentTaskId: task.id, dependencies: [task.id], capabilities: ['implementation'],
          workerRequirements: { capabilities: [] }, adapter: 'codex', input, output: { kind: 'task_pr' },
          continuation: null, continuationDeliveredAt: null, state: 'DRAFT', attempt: 0, maxAttempts: 3,
          leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, plannerResult: null,
          error: null, timeoutMs: 0, createdAt: now, updatedAt: now
        };
        await this.store.appendTask(fixTask);
        await this.emit(eventFor(job.id, id, task.id, 'review.fix_task_created', 'queued', `Created one fix task ${id} for ${issues.length} reviewer finding(s)`, 'orchestrator', { headSha, issues }, { agent: 'relay', component: 'agents-relay' }));
      }
    }
    job.updatedAt = job.review.updatedAt;
    await this.store.saveJob(job);
    if (outcome === 'approved' && job.autoMerge !== false && this.store.mergePullRequest) {
      const decision = await transitionJobEvent(job, 'review.approved', { autoMerge: true });
      await this.store.saveJob(job);
      const outcomes = await this.workflowEffects.execute(
        decision.effects,
        { jobId: job.id, taskId: task.id, transitionKey: `review.approved:${headSha}`, data: { headSha } },
      );
      await this.applyJobEffectOutcomes(job, outcomes);
    }
    return { applied: true, reconcile: outcome === 'changes_required', reason: `review.${outcome}`, reconcileMode: outcome === 'changes_required' ? 'detached' : undefined };
  }
}
