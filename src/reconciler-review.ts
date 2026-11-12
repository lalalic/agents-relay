import { settleReviewRevisionRound } from './review-revision-settlement.js';
import { isFinalReviewAgent, FINAL_REVIEW_AGENT, nextFinalReviewTaskId } from './final-review-role.js';
import { normalizeReviewEvidence } from './review-evidence.js';
import { browserWorkerPool } from './browser-worker-runtime.js';
import { ChatGptThreadDelivery, Job, Task, EventRecord, ReviewOutcome, storySizeTimeoutMs, taskOverallTimeoutMs, WorkerRequirements } from './types.js';
import { refreshTaskDependencies, transitionTaskEvent, transitionJobEvent, tryTransitionTaskEvent } from './task-transitions.js';
import { implementationTasks } from './runtime-status.js';
import { reviewPlanReady, reviewWorkSettled } from './review-replan.js';
import { eventFor } from './events.js';
import { RoutingDecision, WorkerSelection } from './types.js';
import { workerCandidates, type WorkerCandidate } from './worker-routing.js';
import { routeExecution } from './execution-routing.js';
import { recordRouteOutcome } from './route-outcome-recording.js';
import { ReconcilerRuntimeBase, type EventHandlingResult } from './reconciler-runtime.js';
import { dispatchReviewLifecycle, reviewOutcome } from './workflow/review-v2.js';
import { staleReviewRevisions } from './review-revision-stale.js';
import { dispatchTaskLifecycleSync } from './workflow/lifecycle.js';
import { createTaskEntity } from './workflow/entity-creation.js';
import { localSourceHead, localWorkingHead } from './local-git-merge.js';
import { chatgptThreadRequirements, resolveReviewerThreadDestination, resolveImplementationTaskThreadDestination, prepareReviewerThreadDelivery } from './reviewer-thread.js';
import { reviewGenerationMatches } from './review-generation-fence.js';
import { targetedRequestsForReview, targetedRequestsCoverReview } from './review-revision-model.js';
import { reviewFindingFingerprint } from './review-revision-policy.js';
import { codexFallbackRouting, codexNoStartFallbackRoute, quarantineUnavailableCodexFallback } from './chatgpt-platform-fallback.js';
import { agentModelPreferenceForJob } from './reconciler-context.js';


export abstract class ReconcilerReviewBase extends ReconcilerRuntimeBase {
  protected abstract launch(job: Job, task: Task): Promise<void>;
  protected async currentHeadSha(job: Job): Promise<string | null> {
    // Tests may replace the external Git effect entirely; in that case its
    // immutable input SHA is already present in the authoritative Job.
    if (this.options.noGitHub && this.options.localMergeEffect) return job.headSha ?? job.review?.headSha ?? null;
    if (this.options.headShaProvider) return this.options.headShaProvider(job);
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
    const reviewTasks = job.tasks.filter(task => isFinalReviewAgent(task.agentName) && task.reviewHeadSha === headSha);
    const currentReviewTask = job.review?.taskId ? job.tasks.find(task => task.id === job.review?.taskId) : undefined;
    return {
      reviewEnabled: job.reviewEnabled !== false,
      jobActive: job.state === 'ACTIVE' || job.projectionRecovery?.status === 'repairing',
      reviewWorkSettled: reviewWorkSettled(job),
      headAvailable: Boolean(headSha),
      reviewPlanReady: reviewPlanReady(job),
      noActiveReviewTask: !reviewTasks.some(task => ['DRAFT', 'QUEUED', 'RUNNING'].includes(task.state)),
      currentReviewCancelled: currentReviewTask?.reviewHeadSha === headSha && currentReviewTask.state === 'CANCELLED',
      noApprovedCurrentReview: !reviewTasks.some(task => task.state === 'SUCCEEDED' && job.review?.headSha === headSha && job.review.outcome === 'approved'),
    };
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
    const staleReview = job.review;
    if (!headSha || !staleReview || staleReview.headSha === headSha) return;
    const decision = await dispatchReviewLifecycle(staleReview.outcome, 'head.changed', {}, async actionId => {
      if (actionId === 'review.cancelStale') {
        await this.cancelStaleReviewTask(job);
        if (staleReview.taskId) await staleReviewRevisions(this.store, job, staleReview.taskId, staleReview.headSha,
          (taskId, executionId) => this.cancelExecutionGeneration(job.id, taskId, executionId));
        return {};
      }
      throw new Error('Unsupported stale review action ' + actionId);
    });
    if (!decision.accepted) return;
    const outcome = reviewOutcome(decision.target);
    if (!outcome) throw new Error('Review graph produced invalid stale target ' + decision.target);
    const updatedAt = new Date().toISOString();
    if (this.store.mutateJob) {
      const persisted = await this.store.mutateJob(job.id, current => {
        const currentReview = current.review;
        if (!currentReview || currentReview.taskId !== staleReview.taskId || currentReview.headSha !== staleReview.headSha) return current;
        current.review = { ...currentReview, outcome, updatedAt };
        current.updatedAt = updatedAt;
        return current;
      });
      Object.assign(job, persisted);
    } else {
      job.review = { ...staleReview, outcome, updatedAt };
      await this.store.saveJob(job);
    }
  }

  private async createFinalReviewTask(job: Job, headSha: string): Promise<string> {
    const id = nextFinalReviewTaskId(job, headSha);
    const reviewPrNumber = job.prNumber;
    const now = new Date().toISOString();
    const reviewGateTasks = implementationTasks(job);
    const reviewThread = resolveReviewerThreadDestination(job, this.options.reviewer?.threadId);
    const reviewerRouting = await this.selectReviewer(
      reviewGateTasks,
      reviewThread ? chatgptThreadRequirements(this.options.reviewer?.requirements) : undefined,
      job,
    );
    const chatgptThreadDelivery = prepareReviewerThreadDelivery(job, {
      id, agentName: FINAL_REVIEW_AGENT, reviewHeadSha: headSha, routing: reviewerRouting.candidate.routing,
    }, this.options.reviewer?.threadId);
    const input = [
      `Job ID: ${job.id}`,
      reviewPrNumber > 0 ? `Review PR #${reviewPrNumber} at exactly head SHA ${headSha}.` : `Review the local Job artifact at exactly head SHA ${headSha}.`,
      `Review head SHA: ${headSha}`,
      'Job objective: ' + (job.objective ?? job.description ?? job.title),
      'Review the complete PR diff at this exact immutable head SHA, not only the dependency Tasks.',
      'Use the selected reviewer agent contract as the authoritative review protocol.',
      'This is a PRE-MERGE artifact approval gate: inspect exact PR head, requirements, tests and genuine blocking defects.',
      'Do not block approval because automatic merge, Job COMPLETED, or post-merge validation has not occurred yet.',
      'All non-review Tasks have terminal outcomes. Examine FAILED and CANCELLED Tasks and their recovery evidence; never approve an unresolved required outcome.',
      'The Final Review is the Job completion check. Persist concrete, owner-attributed findings with a changes-required verdict. A Job without an explicit Planner remains plan-free; request targeted revisions rather than assuming Relay creates a Planner round.',
      'Do not treat historical failed attempts as current artifact defects; distinguish preserved baseline files from implementation.',
    ].join('\n\n');
    const task = createTaskEntity(job, {
      jobId: job.id, id, title: 'Review', kind: 'work', priority: job.priority, storySize: 'M', projectName: job.title, agentName: FINAL_REVIEW_AGENT,
      parentTaskId: null, dependencies: [], capabilities: ['review'],
      workerSelection: reviewerRouting.selection, adapter: reviewerRouting.candidate.adapter,
      input,
      output: { kind: 'task_pr' }, routing: reviewerRouting.candidate.routing, continuation: null, continuationDeliveredAt: null,
      chatgptThreadDelivery,
      reviewHeadSha: headSha, attempt: 0, maxAttempts: this.options.reviewer?.maxAttempts ?? 2,
      leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, plannerResult: null,
      error: null, timeoutMs: this.options.reviewer?.timeoutMs ?? storySizeTimeoutMs('M'), createdAt: now, updatedAt: now
    });
    await this.store.appendTask(task);
    await this.emit(eventFor(job.id, id, task.parentTaskId, 'review.created', 'queued', 'Final review task ' + id + ' created for ' + headSha + ' using ' + reviewerRouting.reason, 'orchestrator', { headSha, agentName: FINAL_REVIEW_AGENT, reviewerRouting: { workerId: reviewerRouting.selection.workerId, reason: reviewerRouting.reason, selectedBy: reviewerRouting.selection.selectedBy } }));
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
    job = await settleReviewRevisionRound(this.store, job);
    // Restore the review gate only after an authoritative unblock of the original reviewer.
    const priorReviewTask = job.tasks.find(task => task.id === job.review?.taskId);
    if (job.review?.outcome === 'blocked' && job.review.headSha === headSha
      && isFinalReviewAgent(priorReviewTask?.agentName) && priorReviewTask?.unblock?.event === 'task.unblocked'
      && ['QUEUED', 'RUNNING', 'FAILED'].includes(priorReviewTask?.state ?? '')) {
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
    const ready = refreshTaskDependencies(await this.store.load(job.id));
    await this.store.saveJob(ready);
  }
  protected async selectReviewer(implementationTasks: readonly Task[], requirementsOverride?: WorkerRequirements, job?: Job): Promise<{ candidate: WorkerCandidate & { routing: RoutingDecision }; selection: WorkerSelection; reason: 'worker-router' }> {
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
      modelPreference: job ? await agentModelPreferenceForJob(this.options, job, FINAL_REVIEW_AGENT) : undefined,
      usage,
      registered,
      chatgptRunning: runtimeSummary?.chatgptRunning ?? 0,
      routingConstraints: configured?.routing,
      auditStore: this.options.decisionAuditStore,
    });
    return {
      candidate: routed.candidate,
      selection: routed.selection,
      reason: 'worker-router',
    };
  }
  protected async routeTaskForExecution(job: Job, task: Task): Promise<{ task: Task; routed: boolean }> {
    const implementationThread = resolveImplementationTaskThreadDestination(job, task);
    const reviewerThread = isFinalReviewAgent(task.agentName) ? resolveReviewerThreadDestination(job, this.options.reviewer?.threadId) : null;
    if (task.routing && !((implementationThread || reviewerThread) && task.adapter !== 'chatgpt')) return { task, routed: false };
    if (!task.output || task.adapter === 'orchestrator') return { task, routed: false };

    const usage = this.options.usageSnapshotProvider ? await this.options.usageSnapshotProvider() : undefined;
    const registered = await this.store.listAgents();
    const excludedWorkers = new Set((task.routingExclusions ?? []).map(item => item.workerId).filter((id): id is string => Boolean(id)));
    const excludedAdapters = new Set((task.routingExclusions ?? []).map(item => item.adapter).filter((adapter): adapter is NonNullable<typeof adapter> => Boolean(adapter)));
    const candidates = workerCandidates(this.options.adapters, registered, usage)
      .filter(candidate => !excludedWorkers.has(candidate.workerId))
      .filter(candidate => !excludedAdapters.has(candidate.adapter))
      .filter(candidate => (candidate.adapter !== 'chatgpt' && candidate.adapter !== 'z') ||
        browserWorkerPool().snapshot(candidate.adapter).health === 'HEALTHY')
      .filter(candidate => (implementationThread || reviewerThread) ? candidate.adapter === 'chatgpt' : true);
    const runtimeSummary = this.options.runtimeSummaryProvider?.();
    const requirements = (implementationThread || reviewerThread) ? chatgptThreadRequirements(task.workerRequirements) : (task.workerRequirements ?? { capabilities: [] });
    const taskFacts = {
      job: {
        id: job.id, title: job.title, objective: job.objective ?? null,
        description: job.description ?? null, priority: job.priority ?? null,
        repository: job.repository,
        prNumber: job.prNumber, state: job.state,
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
    const taskExcludedRoutes = (task.routingExclusions ?? []).map(item => ({ provider: item.provider, model: item.model, profile: item.profile }));
    const excludedRoutes = [...taskExcludedRoutes, ...parentExcludedRoutes];
    const routed = task.noStartFallback
      ? await codexNoStartFallbackRoute(task, this.options.adapters, registered, usage)
      : await routeExecution(candidates, requirements, {
      decisionEngine: this.options.decisionEngine,
      decisionMode: this.options.decisionMode,
      taskFacts: { ...taskFacts, recovery: task.recoveryContext ?? null, recovery_parent_failed_route: excludedRoutes[0] ?? null },
      modelPreference: await agentModelPreferenceForJob(this.options, job, task.agentName ?? 'implementation', task),
      usage,
      registered,
      chatgptRunning: runtimeSummary?.chatgptRunning ?? 0,
      routingConstraints,
      excludedRoutes,
      auditStore: this.options.decisionAuditStore,
      auditTask: task,
    });
    if (!routed) throw new Error('Codex configured default unavailable for no-start recovery');
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
      if (task.noStartFallback) {
        const message = error instanceof Error ? error.message : String(error);
        const transition = await this.taskTransitions.apply(job.id, task.id, 'fail', {
          eligible: (_job, current) => current.state === 'QUEUED'
            && current.executionId === null
            && current.noStartFallback?.failedExecutionId === task.noStartFallback?.failedExecutionId,
          mutate: (_job, current) => {
            current.error = 'Codex default fallback route unavailable: ' + message;
            current.failureReason = 'codex_default_fallback_unavailable';
          },
        });
        if (transition?.decision.accepted) await this.emit(eventFor(
          job.id, task.id, task.parentTaskId, 'task.failed', 'failed',
          transition.task.error ?? message, 'user', { reason: 'codex_default_fallback_unavailable' },
          { agent: 'relay', component: 'agents-relay' },
        ));
        return undefined;
      }
      if (!['chatgpt','z'].includes(task.adapter) || !task.platformFailure?.safeToReroute) throw error;
      await quarantineUnavailableCodexFallback(this.taskTransitions, event => this.emit(event), job.id, task.id, error);
      return undefined;
    }
  }
  protected async applyReviewEvent(event: EventRecord): Promise<EventHandlingResult> {
    const job = await this.store.load(event.job_id);
    const task = job.tasks.find(item => item.id === event.task_id && isFinalReviewAgent(item.agentName));
    if (!task) return { applied: false, reconcile: false, reason: event.type + '.ignored' };
    const normalizedEvidence = normalizeReviewEvidence(event, task);
    if (!normalizedEvidence) return { applied: false, reconcile: false, reason: event.type + '.ignored' };
    const headSha = normalizedEvidence.headSha;
    if (task.reviewHeadSha !== headSha) return { applied: false, reconcile: false, reason: event.type + '.stale' };
    const currentHeadSha = await this.currentHeadSha(job);
    if (currentHeadSha ? currentHeadSha !== headSha : Boolean(job.headSha && job.headSha !== headSha)) return { applied: false, reconcile: false, reason: event.type + '.stale' };
    // Reviewer attempts may restart at the same SHA. Graph-stale requests
    // from prior execution generations before accepting this generation's
    // verdict; otherwise their DRAFT children can block approval forever.
    if (task.executionId && job.reviewRevisionRequests?.some(request =>
      request.reviewTaskId === task.id && request.reviewHeadSha === headSha
      && request.reviewExecutionId !== task.executionId && request.status !== 'stale')) {
      await staleReviewRevisions(this.store, job, task.id, headSha,
        (taskId, executionId) => this.cancelExecutionGeneration(job.id, taskId, executionId),
        task.executionId);
    }
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
    let revisionDisposition: 'targeted' | 'needs-ownership' | undefined;
    const reviewDecision = await dispatchReviewLifecycle(initialReviewOutcome, event.type, { autoMerge: job.autoMerge !== false, targetedRevisionRequestsReady: targetedRequestsCoverReview(job, task, headSha, normalizedEvidence.issues) }, async actionId => {
      if (actionId === 'review.awaitTargetedRevisions') {
        revisionDisposition = 'targeted';
        // Subsequent revision child scheduling is owned by the revision Graph;
        // the review verdict never creates an unowned generic fix.
        needsReconcile = true;
        return {};
      }
      if (actionId === 'review.requireOwnerResolution') {
        revisionDisposition = 'needs-ownership';
        // An explicitly authorized Planner re-plan may resolve ownership,
        // but there is no implicit generic fix or automatic escalation.
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
        // The graph verdict was decided on the outer snapshot. Never commit a
        // different disposition if concurrent intake changed the requests.
        if (event.type === 'review.changes_required'
          && targetedRequestsCoverReview(current, freshTask, headSha, normalizedEvidence.issues)
            !== (revisionDisposition === 'targeted')) return current;
        const requestIds = targetedRequestsForReview(current, freshTask, headSha).map(item => item.requestId);
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
        if (currentHeadSha === headSha) current.headSha = headSha;
        freshTask.error = null;
        if (freshDecision.target !== 'RUNNING') freshTask.result = { summary: event.message || `Review ${event.type}`, data: event.data ?? {} };
        current.review = { outcome, headSha, taskId: freshTask.id, evidence, updatedAt: reviewUpdatedAt,
          ...(revisionDisposition ? { revisionDisposition } : {}) };
        if ((event.type === 'review.changes_required' || event.type === 'review.approved') && terminalExecutionId
          && !current.reviewRevisionRounds?.some(round => round.reviewTaskId === freshTask.id && round.reviewExecutionId === terminalExecutionId)) {
          current.reviewRevisionRounds = [...(current.reviewRevisionRounds ?? []), {
            reviewTaskId: freshTask.id, reviewExecutionId: terminalExecutionId, headSha,
            requestIds,
            status: outcome === 'approved' ? 'approved' : 'changes_required',
            findingFingerprint: reviewFindingFingerprint(normalizedEvidence.issues),
            recordedAt: reviewUpdatedAt,
          }];
        }
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
    } else {
      job.review = { outcome, headSha, taskId: task.id, evidence, updatedAt: reviewUpdatedAt, ...(revisionDisposition ? { revisionDisposition } : {}) };
      job.updatedAt = reviewUpdatedAt; await this.store.saveTask(task); await this.store.saveJob(job);
    }
    if (event.type==='review.started' && this.store.verifyWorkflowLaunch) {
      const outcome=await this.store.verifyWorkflowLaunch(job.id,task.id,task.executionId!);
      if (outcome==='Failed')throw Error('reviewer start postcondition violated');
    }
    // A changes-requested verdict is a successfully delivered review, not a failed model route.
    if (event.type === 'review.approved' || event.type === 'review.changes_required') {
      const committedReviewer = job.tasks.find(item => item.id === task.id) ?? task;
      await recordRouteOutcome(this.options.decisionAuditStore, committedReviewer, 'success', 'review.' + outcome, { event_type: event.type });
    }
    // Review approval records evidence only. The subsequent Graph reconcile
    // drives durable local Git merge delivery and terminalization.
    if (outcome === 'approved' || outcome === 'changes_required') needsReconcile = true;
    return { applied: true, reconcile: needsReconcile, reason: 'review.' + outcome, reconcileMode: needsReconcile ? 'detached' : undefined };
  }

}
