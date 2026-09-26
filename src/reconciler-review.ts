import { Job, Task, EventRecord, ReviewOutcome, storySizeTimeoutMs, taskOverallTimeoutMs } from './types.js';
import { schedule, transitionTaskEvent, transitionJobEvent } from './scheduler.js';
import { implementationComplete } from './runtime-status.js';
import { eventFor } from './events.js';
import { ReviewerCandidate, selectReviewer } from './reviewer-routing.js';
import { WorkerSelection } from './types.js';
import { routeWorker, workerCandidates, type WorkerCandidate } from './worker-routing.js';
import { discoverModelCandidates, routeModel } from './model-routing.js';
import { ReconcilerRuntimeBase } from './reconciler-runtime.js';

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
    if (!this.preReviewGatesPass(job)) return;
    const review = job.review;
    if (review?.headSha === headSha && ['started', 'approved', 'changes_required', 'blocked'].includes(review.outcome)) return;
    const reviewTasks = job.tasks.filter(task => task.agentName === 'reviewer' && task.reviewHeadSha === headSha);
    if (reviewTasks.some(task => ['DRAFT', 'QUEUED', 'RUNNING'].includes(task.state))) return;
    if (reviewTasks.some(task => task.state === 'SUCCEEDED' && review?.headSha === headSha && review.outcome === 'approved')) return;
    const id = `final-review-${headSha.slice(0, 12)}`;
    const now = new Date().toISOString();
    const implementationTasks = job.tasks.filter(item => item.agentName !== 'reviewer' && !this.isSupersededTask(item));
    const reviewerRouting = await this.selectReviewer(implementationTasks);
    const task: Task = { jobId: job.id, id, kind: 'work', priority: job.priority, storySize: 'M', projectName: job.title, agentName: 'reviewer', parentTaskId: null, dependencies: implementationTasks.map(item => item.id), capabilities: ['review'], workerSelection: reviewerRouting.selection, adapter: reviewerRouting.candidate.adapter, input: `Review existing PR #${job.prNumber} at exactly head SHA ${headSha}. Job objective: ${job.objective ?? job.description ?? job.title}. Use the selected reviewer agent contract as the authoritative review protocol.`, output: { kind: 'task_pr' }, routing: reviewerRouting.candidate.routing, continuation: null, continuationDeliveredAt: null, reviewHeadSha: headSha, state: 'QUEUED', attempt: 0, maxAttempts: this.options.reviewer?.maxAttempts ?? 2, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, plannerResult: null, error: null, timeoutMs: this.options.reviewer?.timeoutMs ?? storySizeTimeoutMs('M'), createdAt: now, updatedAt: now };

    await this.store.appendTask(task);
    job.review = { outcome: 'pending', headSha, taskId: id, evidence: null, updatedAt: now };
    job.updatedAt = now;
    await this.store.saveJob(job);
    await this.emit(eventFor(job.id, id, null, 'review.created', 'queued', `Final review task ${id} created for ${headSha} using ${reviewerRouting.reason}`, 'orchestrator', { headSha, agentName: 'reviewer', reviewerRouting: { workerId: reviewerRouting.selection.workerId, reason: reviewerRouting.reason, selectedBy: reviewerRouting.selection.selectedBy } }));
    const ready = schedule(await this.store.load(job.id));
    await this.store.saveJob(ready);
  }
  protected async selectReviewer(implementationTasks: readonly Task[]): Promise<{ candidate: ReviewerCandidate; selection: WorkerSelection; reason: 'worker-diversity' | 'provider-model-diversity' | 'eligible-fallback' }> {
    const configured = this.options.reviewer;
    const registered = await this.store.listAgents();
    const usage = this.options.usageSnapshotProvider ? await this.options.usageSnapshotProvider() : undefined;
    const workers = workerCandidates(this.options.adapters, registered, usage).filter(candidate => {
      if (configured?.workerId && configured.workerId !== candidate.workerId) return false;
      if (configured?.adapter && configured.adapter !== candidate.adapter) return false;
      return true;
    });
    // Explicit reviewer routing is a caller-owned hard constraint and remains
    // readable in isolated/test runtimes that do not instantiate that adapter.
    if (workers.length === 0 && configured?.adapter && configured.routing) {
      const candidate: ReviewerCandidate = {
        workerId: configured.workerId ?? configured.adapter,
        adapter: configured.adapter,
        capabilities: ['model'],
        runtime: configured.adapter,
        routing: configured.routing,
      };
      return {
        candidate,
        selection: { workerId: candidate.workerId, adapter: candidate.adapter, capabilities: [...candidate.capabilities], selectedBy: 'worker-router:reviewer-diversity:eligible-fallback', selectedAt: new Date().toISOString() },
        reason: 'eligible-fallback',
      };
    }

    const previews = new Map<string, ReviewerCandidate>();
    for (const worker of workers) {
      try {
        const models = await discoverModelCandidates(worker, registered, usage);
        const preview = await routeModel(worker, models, { decisionMode: 'off', constraints: configured?.routing });
        previews.set(worker.workerId, { ...worker, routing: preview.routing });
      } catch {
        continue;
      }
    }
    const result = selectReviewer([...previews.values()], implementationTasks, configured?.requirements ?? { capabilities: ['model'] });
    const selectedWorker = workers.find(worker => worker.workerId === result.selection.workerId) as WorkerCandidate | undefined;
    if (selectedWorker) {
      result.selection.resourceHealthy = selectedWorker.resourceHealthy;
      result.selection.resourceProvider = selectedWorker.resourceProvider;
      result.selection.resourceUsedPercent = selectedWorker.resourceUsedPercent;
      const models = await discoverModelCandidates(selectedWorker, registered, usage);
      const routedModel = await routeModel(selectedWorker, models, {
        decisionEngine: this.options.decisionEngine,
        decisionMode: this.options.decisionMode,
        constraints: configured?.routing,
        taskFacts: { role: 'reviewer', implementationWorkers: implementationTasks.map(task => task.workerSelection?.workerId ?? task.adapter) },
      });
      result.candidate.routing = routedModel.routing;
    }
    return result;
  }
  protected async routeExecutableTasks(job: Job): Promise<void> {
    const usage = this.options.usageSnapshotProvider ? await this.options.usageSnapshotProvider() : undefined;
    const registered = await this.store.listAgents();
    const candidates = workerCandidates(this.options.adapters, registered, usage);
    const runtimeSummary = this.options.runtimeSummaryProvider?.();
    for (const task of job.tasks.filter(item => item.kind !== 'planner' && item.agentName !== 'reviewer' && item.adapter !== 'orchestrator' && ['QUEUED', 'BLOCKED'].includes(item.state) && item.output && !item.workerSelection && (item.workerRequirements || item.planningSource === 'model-planner'))) {
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
      const routedWorker = await routeWorker(candidates, requirements, {
        decisionEngine: this.options.decisionEngine,
        decisionMode: this.options.decisionMode,
        taskFacts,
        usage,
        chatgptRunning: runtimeSummary?.chatgptRunning ?? 0,
      });
      const models = await discoverModelCandidates(routedWorker.candidate, registered, usage);
      const routingConstraints = task.routing ? { provider: task.routing.provider, model: task.routing.model, profile: task.routing.profile, reasoning: task.routing.reasoning } : undefined;
      const parent = task.agentName === 'troubleshooter' && task.parentTaskId ? job.tasks.find(item => item.id === task.parentTaskId) : undefined;
      const parentRouteFailedBeforeStart = Boolean(parent?.routing && /exited before publishing task\.started|worker_exit_before_start|launch failed/i.test(parent.error ?? parent.failureReason ?? ''));
      const excludedRoutes = parentRouteFailedBeforeStart && parent?.routing
        ? [{ provider: parent.routing.provider, model: parent.routing.model, profile: parent.routing.profile }]
        : [];
      const routedModel = await routeModel(routedWorker.candidate, models, { decisionEngine: this.options.decisionEngine, decisionMode: this.options.decisionMode, taskFacts: { ...taskFacts, recovery_parent_failed_route: excludedRoutes[0] ?? null }, constraints: routingConstraints, excludedRoutes, auditStore: this.options.decisionAuditStore, auditTask: task });
      task.workerSelection = routedWorker.selection;
      task.adapter = routedWorker.candidate.adapter;
      task.routing = routedModel.routing;
      task.timeoutMs = task.timeoutMs || taskOverallTimeoutMs(task.storySize ?? 'M', task.routing.reasoning);
      task.updatedAt = new Date().toISOString();
      await this.store.saveTask(task);
      await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'worker.selected', 'queued', `Worker ${routedWorker.selection.workerId} selected for task ${task.id}`, 'user', { workerSelection: routedWorker.selection, workerRequirements: requirements }, { agent: 'relay', component: 'agents-relay' }));
      await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'model.selected', 'queued', `Selected ${task.routing.model} · thinking ${task.routing.reasoning ?? 'unknown'}`, 'user', { routing: task.routing }, { agent: 'relay', component: 'agents-relay' }));
    }
  }
  protected isSupersededTask(task: Task): boolean {
    return task.state === 'CANCELLED' && typeof task.error === 'string' && task.error.startsWith('Superseded ');
  }
  protected preReviewGatesPass(job: Job): boolean {
    return job.tasks.filter(task => task.agentName !== 'reviewer' && !this.isSupersededTask(task)).every(task => task.state === 'SUCCEEDED');
  }
  protected async applyReviewEvent(event: EventRecord): Promise<void> {
    const job = await this.store.load(event.job_id);
    const task = job.tasks.find(item => item.id === event.task_id && item.agentName === 'reviewer');
    const reviewData = event.data?.review && typeof event.data.review === 'object' ? event.data.review as Record<string, unknown> : undefined;
    const headSha = typeof reviewData?.headSha === 'string' ? reviewData.headSha : typeof event.data?.headSha === 'string' ? event.data.headSha : task?.reviewHeadSha;
    if (!task || !headSha || task.reviewHeadSha !== headSha) return;
    const outcome: ReviewOutcome = event.type === 'review.started' ? 'started' : event.type === 'review.approved' ? 'approved' : event.type === 'review.changes_required' ? 'changes_required' : 'blocked';
    const currentHeadSha = await this.store.headSha?.();
    if ((currentHeadSha && currentHeadSha !== headSha) || (job.headSha && job.headSha !== headSha)) return;
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
          agentName: 'review-fix', parentTaskId: task.id, dependencies: [task.id], capabilities: ['implementation'],
          adapter: 'codex', input, output: { kind: 'task_pr' },
          routing: { provider: 'openai', model: 'gpt-5.6-luna', reasoning: 'medium', decidedBy: 'review-fix', decidedAt: now },
          continuation: null, continuationDeliveredAt: null, state: 'DRAFT', attempt: 0, maxAttempts: 3,
          leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, plannerResult: null,
          error: null, timeoutMs: storySizeTimeoutMs('M'), createdAt: now, updatedAt: now
        };
        await this.store.appendTask(fixTask);
        await this.emit(eventFor(job.id, id, task.id, 'review.fix_task_created', 'queued', `Created one fix task ${id} for ${issues.length} reviewer finding(s)`, 'orchestrator', { headSha, issues }, { agent: 'relay', component: 'agents-relay' }));
      }
    }
    job.updatedAt = job.review.updatedAt;
    await this.store.saveJob(job);
    if (outcome === 'changes_required') this.detach(this.reconcile(job.id), job.id, task.id, 'review-fix reconciliation');
    if (outcome === 'approved' && job.autoMerge !== false && this.store.mergePullRequest) {
      const decision = await transitionJobEvent(job, 'review.approved', { autoMerge: true });
      await this.store.saveJob(job);
      const outcomes = await this.workflowEffects.execute(
        decision.effects,
        { jobId: job.id, taskId: task.id, transitionKey: `review.approved:${headSha}`, data: { headSha } },
      );
      await this.applyJobEffectOutcomes(job, outcomes);
      if (outcomes.some(item => item.effect === 'effect.mergePullRequest' && item.status !== 'failed')) {
        await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'review.merged', 'succeeded', 'Reviewer-approved PR #' + job.prNumber + ' merge requested', 'user', { headSha, autoMerge: true }, { agent: 'reviewer', component: 'agents-relay' }));
      }
    }
  }
}
