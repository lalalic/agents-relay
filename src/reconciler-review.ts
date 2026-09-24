import { Job, Task, EventRecord, ReviewOutcome, storySizeTimeoutMs, taskOverallTimeoutMs } from './types.js';
import { schedule, transitionTaskEvent, transitionJobEvent } from './scheduler.js';
import { implementationComplete } from './runtime-status.js';
import { eventFor } from './events.js';
import { ReviewerCandidate, selectReviewer } from './reviewer-routing.js';
import { WorkerSelection } from './types.js';
import { selectWorker, usageForProvider, workerCandidates } from './worker-routing.js';
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
    const candidates: ReviewerCandidate[] = workerCandidates(this.options.adapters, registered, usage);
    let constrained = candidates.filter(candidate => {
      if (configured?.workerId && configured.workerId !== candidate.workerId) return false;
      if (configured?.adapter && configured.adapter !== candidate.adapter) return false;
      if (configured?.routing?.provider && configured.routing.provider !== candidate.routing.provider) return false;
      if (configured?.routing?.model && configured.routing.model !== candidate.routing.model) return false;
      return true;
    }).map(candidate => ({ ...candidate, routing: configured?.routing ? { ...candidate.routing, ...configured.routing } : candidate.routing }));
    // Explicit reviewer routing is a caller-owned hard constraint and remains
    // readable in isolated/test runtimes that do not instantiate that adapter.
    if (constrained.length === 0 && configured?.adapter && configured.routing) {
      constrained = [{ workerId: configured.workerId ?? configured.adapter, adapter: configured.adapter, capabilities: ['model'], runtime: configured.adapter, routing: configured.routing }];
    }
    const result = selectReviewer(constrained, implementationTasks, configured?.requirements ?? { capabilities: ['model'] });
    const resource = usageForProvider(usage, result.candidate.routing.provider);
    result.selection.resourceHealthy = resource.healthy;
    result.selection.resourceProvider = resource.healthy === undefined ? undefined : result.candidate.routing.provider;
    result.selection.resourceUsedPercent = resource.usedPercent;
    return result;
  }

  protected async routeExecutableTasks(job: Job): Promise<void> {
    const usage = this.options.usageSnapshotProvider ? await this.options.usageSnapshotProvider() : undefined;
    const candidates = workerCandidates(this.options.adapters, await this.store.listAgents(), usage);
    for (const task of job.tasks.filter(item => item.kind !== 'planner' && item.agentName !== 'reviewer' && item.adapter !== 'orchestrator' && ['QUEUED', 'BLOCKED'].includes(item.state) && item.output && !item.workerSelection && (item.workerRequirements || item.planningSource === 'model-planner'))) {
      const requirements = task.workerRequirements ?? { capabilities: task.capabilities.length > 0 ? task.capabilities : ['model'] };
      const routed = selectWorker(candidates, requirements);
      task.workerSelection = routed.selection;
      task.adapter = routed.candidate.adapter;
      task.routing = routed.candidate.routing;
      task.timeoutMs = task.timeoutMs || taskOverallTimeoutMs(task.storySize ?? 'M', task.routing.reasoning);
      task.updatedAt = new Date().toISOString();
      await this.store.saveTask(task);
      await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'worker.selected', 'queued', `Worker ${routed.selection.workerId} selected for task ${task.id}`, 'orchestrator', { workerSelection: routed.selection, workerRequirements: requirements }, { agent: 'relay', component: 'agents-relay' }));
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
