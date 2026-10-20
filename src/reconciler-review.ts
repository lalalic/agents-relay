import { ChatGptThreadDelivery, Job, Task, EventRecord, ReviewOutcome, storySizeTimeoutMs, taskOverallTimeoutMs, WorkerRequirements } from './types.js';
import { completionGateSatisfied, schedule, transitionTaskEvent, transitionJobEvent, tryTransitionTaskEvent } from './scheduler.js';
import { implementationComplete, implementationTasks } from './runtime-status.js';
import { eventFor } from './events.js';
import { RoutingDecision, WorkerSelection } from './types.js';
import { workerCandidates, type WorkerCandidate } from './worker-routing.js';
import { routeExecution } from './execution-routing.js';
import { ReconcilerRuntimeBase, type EventHandlingResult } from './reconciler-runtime.js';
import { dispatchReviewLifecycle, reviewOutcome } from './workflow/review-v2.js';
import { dispatchTaskLifecycleSync } from './workflow/lifecycle.js';
import { createTaskEntity } from './workflow/entity-creation.js';
import { localSourceHead, localWorkingHead } from './local-git-merge.js';
import { chatgptThreadRequirements, resolveReviewerThreadDestination, resolveImplementationTaskThreadDestination, prepareReviewerThreadDelivery } from './reviewer-thread.js';
import { reviewGenerationMatches } from './review-generation-fence.js';
import { codexFallbackRouting, quarantineUnavailableCodexFallback } from './chatgpt-platform-fallback.js';


export abstract class ReconcilerReviewBase extends ReconcilerRuntimeBase {
  protected abstract launch(job: Job, task: Task): Promise<void>;
  protected async currentHeadSha(job: Job): Promise<string | null> {
    // Tests may replace the external Git effect entirely; in that case its
    // immutable input SHA is already present in the authoritative Job.
    if (this.options.noGitHub && this.options.localMergeEffect) return job.headSha ?? job.review?.headSha ?? null;
    // GitHub PR head facts are audit-only. Source identity is local Git.
    if (!this.options.projectPathForJob) return job.headSha ?? job.review?.headSha ?? null;
    try {
      const project = await this.options.projectPathForJob(job);
      if (job.localMerge?.sourceRef) return localSourceHead(project, job.localMerge.sourceRef);
      return localWorkingHead(project);
    } catch {
      return job.headSha ?? job.review?.headSha ?? null;
    }
  }
  private reviewFacts(job: Job, headSha: string | null): Readonly<Record<string, unknown>> {
    const reviewTasks = job.tasks.filter(task => task.agentName === 'reviewer' && task.reviewHeadSha === headSha);
    const currentReviewTask = job.review?.taskId ? job.tasks.find(task => task.id === job.review?.taskId) : undefined;
    return {
      unscheduled: !job.schedule,
      reviewEnabled: job.reviewEnabled !== false,
      jobActive: job.state === 'ACTIVE',
      implementationComplete: implementationComplete(job),
      headAvailable: Boolean(headSha),
      completionGateSatisfied: completionGateSatisfied(job),
      noActiveReviewTask: !reviewTasks.some(task => ['DRAFT', 'QUEUED', 'RUNNING'].includes(task.state)),
      currentReviewCancelled: currentReviewTask?.reviewHeadSha === headSha && currentReviewTask.state === 'CANCELLED',
      noApprovedCurrentReview: !reviewTasks.some(task => task.state === 'SUCCEEDED' && job.review?.headSha === headSha && job.review.outcome === 'approved'),
    };
  }

  private static reviewRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private static reviewHeadSha(event: EventRecord): string | undefined {
    const data = ReconcilerReviewBase.reviewRecord(event.data);
    const outcome = ReconcilerReviewBase.reviewRecord(data.outcome);
    const review = ReconcilerReviewBase.reviewRecord(data.review);
    return [outcome.head_sha, outcome.headSha, review.head_sha, review.headSha, data.head_sha, data.headSha]
      .find((value): value is string => typeof value === 'string' && value.length > 0);
  }

  private static reviewIssues(event: EventRecord): string[] {
    const data = ReconcilerReviewBase.reviewRecord(event.data);
    const outcome = ReconcilerReviewBase.reviewRecord(data.outcome);
    const review = ReconcilerReviewBase.reviewRecord(data.review);
    const rawIssues = outcome.blocking_findings !== undefined ? outcome.blocking_findings
      : outcome.blockingFindings !== undefined ? outcome.blockingFindings
      : review.issues !== undefined ? review.issues
      : data.issues;
    if (!Array.isArray(rawIssues)) return [];
    return rawIssues.map(item => {
      if (typeof item === 'string') return item.trim();
      if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
      const value = item as Record<string, unknown>;
      return (typeof value.summary === 'string' ? value.summary
        : typeof value.message === 'string' ? value.message
        : typeof value.finding === 'string' ? value.finding
        : typeof value.title === 'string' ? value.title : '').trim();
    }).filter(Boolean);
  }

  private static normalizeReviewEvidence(event: EventRecord, task: Task): { headSha: string; issues: string[] } | null {
    const explicitHeadSha = ReconcilerReviewBase.reviewHeadSha(event);
    const headSha = explicitHeadSha ?? (event.type === 'review.approved' ? task.reviewHeadSha : undefined);
    if (!headSha) return null;
    return { headSha, issues: ReconcilerReviewBase.reviewIssues(event) };
  }

  private async cancelStaleReviewTask(job: Job): Promise<void> {
    const staleTask = job.review?.taskId ? job.tasks.find(task => task.id === job.review?.taskId) : undefined;
    if (!staleTask || !['DRAFT', 'QUEUED', 'RUNNING'].includes(staleTask.state)) return;
    this.cancelExecutionGeneration(job.id, staleTask.id, staleTask.executionId ?? staleTask.executionHistory?.at(-1)?.id);
    await transitionTaskEvent(staleTask, 'cancel');
    staleTask.error = 'Review evidence became stale after the PR head changed';
    staleTask.leaseOwner = null;
    staleTask.leaseExpiresAt = null;
    await this.store.saveTask(staleTask);
  }

  protected async invalidateStaleReview(job: Job, headSha: string | null): Promise<void> {
    if (!headSha || !job.review || job.review.headSha === headSha) return;
    const decision = await dispatchReviewLifecycle(job.review.outcome, 'head.changed', {}, async actionId => {
      if (actionId === 'review.cancelStale') { await this.cancelStaleReviewTask(job); return {}; }
      throw new Error('Unsupported stale review action ' + actionId);
    });
    if (!decision.accepted) return;
    const outcome = reviewOutcome(decision.target);
    if (!outcome) throw new Error('Review graph produced invalid stale target ' + decision.target);
    job.review = { ...job.review, outcome, updatedAt: new Date().toISOString() };
    await this.store.saveJob(job);
  }

  private nextFinalReviewTaskId(job: Job, headSha: string): string {
    const base = 'final-review-' + headSha.slice(0, 12);
    const ids = new Set(job.tasks.filter(task => task.reviewHeadSha === headSha && task.agentName === 'reviewer').map(task => task.id));
    if (!ids.has(base)) return base;
    for (let round = 2; round < 1000; round += 1) {
      const candidate = base + '-r' + round;
      if (!ids.has(candidate)) return candidate;
    }
    throw new Error('Too many final review rounds for ' + headSha);
  }

  private externalReviewPrNumber(job: Job): number {
    return job.prNumber;
  }

  private async createFinalReviewTask(job: Job, headSha: string): Promise<string> {
    const id = this.nextFinalReviewTaskId(job, headSha);
    const reviewPrNumber = this.externalReviewPrNumber(job);
    const now = new Date().toISOString();
    const reviewGateTasks = implementationTasks(job);
    const reviewThread = resolveReviewerThreadDestination(job, this.options.reviewer?.threadId);
    const reviewerRouting = await this.selectReviewer(
      reviewGateTasks,
      reviewThread ? chatgptThreadRequirements(this.options.reviewer?.requirements) : undefined,
    );
    const chatgptThreadDelivery = prepareReviewerThreadDelivery(job, {
      id, agentName: 'reviewer', reviewHeadSha: headSha, routing: reviewerRouting.candidate.routing,
    }, this.options.reviewer?.threadId);
    const input = [
      `Job ID: ${job.id}`,
      reviewPrNumber > 0 ? `Review PR #${reviewPrNumber} at exactly head SHA ${headSha}.` : `Review the local Job artifact at exactly head SHA ${headSha}.`,
      `Review head SHA: ${headSha}`,
      'Job objective: ' + (job.objective ?? job.description ?? job.title),
      'Use the selected reviewer agent contract as the authoritative review protocol.',
      'This is a PRE-MERGE artifact approval gate: inspect exact PR head, requirements, tests and genuine blocking defects.',
      'Do not block approval because automatic merge, Job COMPLETED, or post-merge E2E evidence has not occurred yet.',
      'Do not treat historical failed attempts as current artifact defects; distinguish preserved baseline files from implementation.',
    ].join('\n\n');
    const task = createTaskEntity(job, {
      jobId: job.id, id, title: `Review ${headSha.slice(0, 8)}`, kind: 'work', priority: job.priority, storySize: 'M', projectName: job.title, agentName: 'reviewer',
      parentTaskId: null, dependencies: reviewGateTasks.map(item => item.id), capabilities: ['review'],
      workerSelection: reviewerRouting.selection, adapter: reviewerRouting.candidate.adapter,
      input,
      output: { kind: 'task_pr' }, routing: reviewerRouting.candidate.routing, continuation: null, continuationDeliveredAt: null,
      chatgptThreadDelivery,
      reviewHeadSha: headSha, attempt: 0, maxAttempts: this.options.reviewer?.maxAttempts ?? 2,
      leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, plannerResult: null,
      error: null, timeoutMs: this.options.reviewer?.timeoutMs ?? storySizeTimeoutMs('M'), createdAt: now, updatedAt: now
    });
    await this.store.appendTask(task);
    await this.emit(eventFor(job.id, id, null, 'review.created', 'queued', 'Final review task ' + id + ' created for ' + headSha + ' using ' + reviewerRouting.reason, 'orchestrator', { headSha, agentName: 'reviewer', reviewerRouting: { workerId: reviewerRouting.selection.workerId, reason: reviewerRouting.reason, selectedBy: reviewerRouting.selection.selectedBy } }));
    return id;
  }

  private async projectedReviewHeadReady(job: Job, headSha: string): Promise<boolean> {
    // Local-first Jobs may expose a review-only GitHub PR. Once such a PR is
    // bound, its projected head must match the authoritative local head before
    // a reviewer is asked to review that immutable PR identity.
    if (!job.localMerge?.sourceRef || job.prNumber <= 0 || !this.store.pullRequestHead) return true;
    try {
      const projected = await this.store.pullRequestHead();
      return projected?.sha === headSha;
    } catch {
      return false;
    }
  }

  protected async ensureFinalReview(job: Job, headSha: string | null): Promise<void> {
    if (headSha && !(await this.projectedReviewHeadReady(job, headSha))) return;
    // Restore the review gate only after an authoritative unblock of the original reviewer.
    const priorReviewTask = job.tasks.find(task => task.id === job.review?.taskId);
    if (job.review?.outcome === 'blocked' && job.review.headSha === headSha
      && priorReviewTask?.agentName === 'reviewer' && priorReviewTask.unblock?.event === 'task.unblocked'
      && ['QUEUED', 'RUNNING', 'FAILED'].includes(priorReviewTask.state)) {
      const recovered = await dispatchReviewLifecycle('blocked', 'review.retry', { reviewUnblocked: true });
      if (recovered.accepted && recovered.target === 'PENDING') {
        job.review = { ...job.review, outcome: 'pending', updatedAt: new Date().toISOString() };
        await this.store.saveJob(job);
      }
    }
    let reviewTaskId: string | null = null;
    const decision = await dispatchReviewLifecycle(job.review?.outcome, 'reconcile', this.reviewFacts(job, headSha), async actionId => {
      if (actionId !== 'review.create') throw new Error('Unsupported review reconcile action ' + actionId);
      if (!headSha) throw new Error('Review graph requested creation without a durable head SHA');
      reviewTaskId = await this.createFinalReviewTask(job, headSha); return {};
    });
    if (!decision.accepted || !reviewTaskId || !headSha) return;
    const outcome = reviewOutcome(decision.target);
    if (!outcome) throw new Error('Review graph produced invalid create target ' + decision.target);
    const now = new Date().toISOString();
    job.review = { outcome, headSha, taskId: reviewTaskId, evidence: null, updatedAt: now };
    job.updatedAt = now;
    await this.store.saveJob(job);
    const ready = schedule(await this.store.load(job.id));
    await this.store.saveJob(ready);
  }
  protected async selectReviewer(implementationTasks: readonly Task[], requirementsOverride?: WorkerRequirements): Promise<{ candidate: WorkerCandidate & { routing: RoutingDecision }; selection: WorkerSelection; reason: 'worker-router' }> {
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
    const routed = await routeExecution(workers, requirementsOverride ?? configured?.requirements ?? { capabilities: ['model'] }, {
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
  protected async routeTaskForExecution(job: Job, task: Task): Promise<{ task: Task; routed: boolean }> {
    const implementationThread = resolveImplementationTaskThreadDestination(job, task);
    const reviewerThread = task.agentName === 'reviewer' ? resolveReviewerThreadDestination(job, this.options.reviewer?.threadId) : null;
    if (task.routing && !((implementationThread || reviewerThread) && task.adapter !== 'chatgpt')) return { task, routed: false };
    if (!task.output || task.adapter === 'orchestrator') return { task, routed: false };

    const usage = this.options.usageSnapshotProvider ? await this.options.usageSnapshotProvider() : undefined;
    const registered = await this.store.listAgents();
    const codexFallback = task.platformFailure?.safeToReroute === true && task.adapter === 'chatgpt';
    const fallbackRouting = codexFallback ? codexFallbackRouting(task, this.options.adapters, registered, usage) : undefined;
    const excludedWorkers = new Set((task.routingExclusions ?? []).map(item => item.workerId).filter((id): id is string => Boolean(id)));
    const excludedAdapters = new Set((task.routingExclusions ?? []).map(item => item.adapter).filter((adapter): adapter is NonNullable<typeof adapter> => Boolean(adapter)));
    const candidates = fallbackRouting?.candidates ?? workerCandidates(this.options.adapters, registered, usage)
      .filter(candidate => !excludedWorkers.has(candidate.workerId))
      .filter(candidate => !excludedAdapters.has(candidate.adapter))
      .filter(candidate => (implementationThread || reviewerThread) ? candidate.adapter === 'chatgpt' : true);
    const runtimeSummary = this.options.runtimeSummaryProvider?.();
    const requirements = (implementationThread || reviewerThread) ? chatgptThreadRequirements(task.workerRequirements) : (task.workerRequirements ?? { capabilities: [] });
    const taskFacts = {
      job: {
        id: job.id, title: job.title, objective: job.objective ?? null,
        description: job.description ?? null, priority: job.priority ?? null,
        executionMode: job.executionMode, repository: job.repository,
        prNumber: this.externalReviewPrNumber(job), state: job.state,
      },
      task: {
        id: task.id, kind: task.kind ?? 'work', storySize: task.storySize ?? 'M',
        priority: task.priority ?? null, agentName: task.agentName ?? null,
        parentTaskId: task.parentTaskId, dependencies: task.dependencies,
        capabilities: task.capabilities, taskCapabilities: task.taskCapabilities, workerCapabilities: task.workerCapabilities, input: task.input,
        attachments: task.attachments ?? [], output: task.output ?? null,
        state: task.state, attempt: task.attempt, maxAttempts: task.maxAttempts,
      },
      storySize: task.storySize ?? 'M',
    };
    const routingConstraints = undefined;
    const parent = task.agentName === 'troubleshooter' && task.parentTaskId
      ? job.tasks.find(item => item.id === task.parentTaskId)
      : undefined;
    const parentRouteFailedBeforeStart = Boolean(parent?.routing && /exited before publishing task\.started|worker_exit_before_start|launch failed/i.test(parent.error ?? parent.failureReason ?? ''));
    const parentExcludedRoutes = parentRouteFailedBeforeStart && parent?.routing
      ? [{ provider: parent.routing.provider, model: parent.routing.model, profile: parent.routing.profile }]
      : [];
    const taskExcludedRoutes = fallbackRouting?.excludedRoutes ?? (task.routingExclusions ?? []).map(item => ({ provider: item.provider, model: item.model, profile: item.profile }));
    const excludedRoutes = [...taskExcludedRoutes, ...parentExcludedRoutes];
    const routed = await routeExecution(candidates, requirements, {
      decisionEngine: this.options.decisionEngine,
      decisionMode: this.options.decisionMode,
      taskFacts: { ...taskFacts, recovery: task.recoveryContext ?? null, recovery_parent_failed_route: excludedRoutes[0] ?? null },
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
    await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'worker.selected', 'queued', 'Worker ' + routed.selection.workerId + ' selected for task ' + task.id, 'user', { workerSelection: routed.selection, workerRequirements: requirements }, { agent: 'relay', component: 'agents-relay' }));
    await this.emit(eventFor(job.id, task.id, task.parentTaskId, 'model.selected', 'queued', 'Selected ' + task.routing.model + ' · thinking ' + (task.routing.reasoning ?? 'unknown'), 'user', { routing: task.routing }, { agent: 'relay', component: 'agents-relay' }));
    return { task, routed: true };
  }
  protected async routeTaskForExecutionFailClosed(job: Job, task: Task): Promise<{ task: Task; routed: boolean } | undefined> {
    try { return await this.routeTaskForExecution(job, task); }
    catch (error) {
      if (task.adapter !== 'chatgpt' || !task.platformFailure?.safeToReroute) throw error;
      await quarantineUnavailableCodexFallback(this.taskTransitions, event => this.emit(event), job.id, task.id, error);
      return undefined;
    }
  }
  protected async applyReviewEvent(event: EventRecord): Promise<EventHandlingResult> {
    const job = await this.store.load(event.job_id);
    const task = job.tasks.find(item => item.id === event.task_id && item.agentName === 'reviewer');
    if (!task) return { applied: false, reconcile: false, reason: event.type + '.ignored' };
    const normalizedEvidence = ReconcilerReviewBase.normalizeReviewEvidence(event, task);
    if (!normalizedEvidence) return { applied: false, reconcile: false, reason: event.type + '.ignored' };
    const headSha = normalizedEvidence.headSha;
    if (task.reviewHeadSha !== headSha) return { applied: false, reconcile: false, reason: event.type + '.stale' };
    const currentHeadSha = await this.currentHeadSha(job);
    if ((currentHeadSha && currentHeadSha !== headSha) || (job.headSha && job.headSha !== headSha)) return { applied: false, reconcile: false, reason: event.type + '.stale' };
    // Planner-created reviewer tasks predate the final-review Job gate. Bind
    // their first trustworthy review event to PENDING before dispatching it.
    const freshAfterStale = job.review?.outcome === 'stale'
      && job.review.headSha !== headSha && Boolean(task.planningDecisionId);
    const initialReviewOutcome = (!job.review || freshAfterStale) && task.planningDecisionId
      ? 'pending' : job.review?.outcome;

    const taskDecision = this.store.mutateJob
      ? dispatchTaskLifecycleSync(structuredClone(task) as Task & Record<string, unknown>, event.type)
      : tryTransitionTaskEvent(task, event.type);
    if (!taskDecision.accepted || !taskDecision.target) return { applied: false, reconcile: false, reason: event.type + '.ignored' };
    if (!this.store.mutateJob && taskDecision.target !== 'RUNNING' && !this.finalizeReviewExecution(job.id, task, event)) {
      return { applied: false, reconcile: false, reason: event.type + '.stale-execution' };
    }
    if (!this.store.mutateJob) {
      task.error = null;
      if (taskDecision.target !== 'RUNNING') task.result = { summary: event.message || `Review ${event.type}`, data: event.data ?? {} };
      await this.store.saveTask(task);
    }

    let needsReconcile = false;
    let pendingFixTask: Task | null = null;
    const reviewDecision = await dispatchReviewLifecycle(initialReviewOutcome, event.type, { autoMerge: job.autoMerge !== false }, async actionId => {
      if (actionId === 'review.createFix') {
        needsReconcile = true;
        const issues = normalizedEvidence.issues;
        if (issues.length === 0) issues.push(event.message || 'Address the reviewer-requested changes');
        const now = event.timestamp || new Date().toISOString(); const id = 'review-fix-' + headSha.slice(0, 8);
        if (!job.tasks.some(item => item.id === id)) {
          const fixPrNumber = this.externalReviewPrNumber(job);
          const fixTarget = fixPrNumber > 0 ? `PR #${fixPrNumber}` : `Job ${job.id} artifact`;
          const input = 'Address all reviewer findings for ' + fixTarget + ' at ' + headSha + ':\n\n' + issues.map((issue, index) => (index + 1) + '. ' + issue).join('\n');
          const fixTask = createTaskEntity(job, { jobId: job.id, id, title: `Fix review ${headSha.slice(0, 8)}`, kind: 'work', priority: job.priority, storySize: 'M', projectName: job.title, agentName: 'implementation', parentTaskId: task.id, dependencies: [task.id], capabilities: ['implementation'], workerRequirements: { capabilities: [] }, adapter: 'codex', input, output: { kind: 'task_pr' }, continuation: null, continuationDeliveredAt: null, attempt: 0, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, plannerResult: null, error: null, timeoutMs: 0, createdAt: now, updatedAt: now });
          pendingFixTask = fixTask;
        }
        return {};
      }
      if (actionId === 'review.requestMerge') {
        // Approval is a local fact; only subsequent local Git delivery may complete the Job.
        return {};
      }
      throw new Error('Unsupported review event action ' + actionId);
    });
    if (!reviewDecision.accepted) return { applied: false, reconcile: false, reason: event.type + '.ignored' };
    const outcome = reviewOutcome(reviewDecision.target);
    if (!outcome) return { applied: false, reconcile: false, reason: event.type + '.ignored' };
    const reviewData = event.data?.review && typeof event.data.review === 'object' && !Array.isArray(event.data.review)
      ? event.data.review as Record<string, unknown> : undefined;
    const evidence = { summary: event.message || 'Review ' + outcome, data: {
      ...(event.data ?? {}), review: { ...(reviewData ?? {}), headSha }, headSha, outcome, source: event.source,
    } };
    const reviewUpdatedAt = event.timestamp || new Date().toISOString();
    if (this.store.mutateJob) {
      let committed = false;
      let terminalExecutionId: string | null = null;
      const updated = await this.store.mutateJob(job.id, current => {
        const freshTask = current.tasks.find(item => item.id === task.id);
        if (!freshTask || !reviewGenerationMatches(current, job, task, headSha)) return current;
        const candidate = structuredClone(freshTask);
        const freshDecision = tryTransitionTaskEvent(candidate, event.type);
        if (!freshDecision.accepted || !freshDecision.target) return current;
        if (freshDecision.target !== 'RUNNING') {
          // Capture the execution generation before finalization clears it.
          // Post-commit cleanup must cancel the matching live watchdog.
          terminalExecutionId = freshTask.executionId;
          if (!this.finalizeReviewExecution(job.id, candidate, event, false)) return current;
        }
        Object.assign(freshTask, candidate);
        // Bind the first Planner review only after the generation fence has
        // checked the unmodified outer snapshot and authoritative SQLite state.
        if ((!current.review || (current.review.outcome === 'stale' && current.review.headSha !== headSha)) && freshTask.planningDecisionId) {
          current.review = { outcome: 'pending', headSha, taskId: freshTask.id, evidence: null, updatedAt: reviewUpdatedAt };
        }
        freshTask.error = null;
        if (freshDecision.target !== 'RUNNING') freshTask.result = { summary: event.message || `Review ${event.type}`, data: event.data ?? {} };
        if (pendingFixTask && !current.tasks.some(item => item.id === pendingFixTask!.id)) current.tasks.push(structuredClone(pendingFixTask));
        current.review = { outcome, headSha, taskId: freshTask.id, evidence, updatedAt: reviewUpdatedAt };
        current.updatedAt = reviewUpdatedAt;
        committed = true;
        return current;
      });
      if (!committed) return { applied: false, reconcile: false, reason: event.type + '.stale-execution' };
      Object.assign(job, structuredClone(updated));
      // Live waiter cleanup/terminal claims are irreversible; run after commit.
      if (terminalExecutionId) {
        this.finalizeReviewExecution(job.id, { ...task, executionId: terminalExecutionId }, event);
      }
      const committedFixTask = pendingFixTask as Task | null;
      if (committedFixTask) await this.emit(eventFor(job.id, committedFixTask.id, task.id, 'review.fix_task_created', 'queued', 'Created one fix task ' + committedFixTask.id + ' for reviewer findings', 'orchestrator', { headSha }, { agent: 'relay', component: 'agents-relay' }));
    } else {
      const legacyFixTask = pendingFixTask as Task | null;
      if (legacyFixTask) {
        await this.store.appendTask(legacyFixTask);
        await this.emit(eventFor(job.id, legacyFixTask.id, task.id, 'review.fix_task_created', 'queued', 'Created one fix task ' + legacyFixTask.id + ' for reviewer findings', 'orchestrator', { headSha }, { agent: 'relay', component: 'agents-relay' }));
      }
      job.review = { outcome, headSha, taskId: task.id, evidence, updatedAt: reviewUpdatedAt };
      job.updatedAt = reviewUpdatedAt; await this.store.saveTask(task); await this.store.saveJob(job);
    }
    if (event.type==='review.started' && this.store.verifyWorkflowLaunch) {
      const outcome=await this.store.verifyWorkflowLaunch(job.id,task.id,task.executionId!);
      if (outcome==='Failed')throw Error('reviewer start postcondition violated');
    }
    // Review approval records evidence only. The subsequent Graph reconcile
    // drives durable local Git merge delivery and terminalization.
    if (outcome === 'approved') needsReconcile = true;
    return { applied: true, reconcile: needsReconcile, reason: 'review.' + outcome, reconcileMode: needsReconcile ? 'detached' : undefined };
  }

}
