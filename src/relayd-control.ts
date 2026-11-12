import { submitTargetedRevisionRequest } from './review-revision-model.js';
import {beginInteractiveReview,abortInteractiveReview,failInteractiveReview,interactiveWaitingEvent} from './interactive-request.js';
import { localSourceHead, localWorkingHead } from './local-git-merge.js';
import type { RevisionFinding } from './types.js';
import { appendTaskComment } from './task-comments.js';
import type { Job, Task } from './types.js';
import { once } from 'node:events';
import { spawnOwnedProcess } from './owned-process.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ChatGptAdapter, CodexAdapter, ensureChatGptWebHelmReady } from './adapters.js';
import { CodexThreadContinuation, CommandContinuation, WebhookContinuation } from './continuation.js';
import { serveDashboard } from './dashboard.js';
import { RepositoryWorkerPool } from './pool.js';
import { Reconciler } from './reconciler.js';
import { dashboardManagedJobs, GitHubStore, InMemoryStore, ManagedJobOverview, resolvePullRequest, type DurableStore, type ManagedGitHubPullRequestSnapshot } from './store.js';
import { GitHubProjectionWriter } from './projected-store.js';
import { LocalAuthorityDurableStore } from './local-authority-store.js';
import { discoverLocalRelayStoreSnapshots, SQLiteRelayStore } from './relay-store.js';
import { openLocalManagedStore } from './local-managed-store.js';
import { relayStoreDirectory } from './relay-store.js';
import { createJobIdRegistryResolver } from './local-job-registry.js';
import { projectAuthoritativeLocalMerge } from './local-merge-projection.js';
import { archiveDisplayPullRequest } from './github-pr-archive.js';
import { orderGitHubBindingCandidates } from './github-binding-order.js';
import { githubAuthContext } from './github-auth.js';
import { GhApiClient } from './github-client.js';
import { DisabledGitHubClient, noGitHubMode } from './no-github.js';
import { basename } from 'node:path';
import { normalizeThreadId } from './reviewer-thread.js';
import { dashboardJobAction, isEntrypoint, runtimePlanner, runtimeReviewer, startService, SERVICE_DEFAULTS } from './cli.js';
import { eventBusResolutionMessage, publishTaskBlocked, publishTaskUnblocked, resolveEventBus } from './cli-support.js';
import { classifyFailedTask, dispatchTaskAction, supersedeCancelledTask } from './task-actions.js';
import { isEffectivelyBlocked, unblockTask } from './unblock.js';
import { requestTroubleshooterEscalation, resumeTroubleshooter } from './task-recovery.js';
import { registerBlockerDependency } from './blockers.js';
import { ensureBlockerRecovery, type BlockerRecoveryInput } from './blocker-recovery.js';
import { ensureManagedGitHubJob } from './cli-job-create.js';
import { applyJobActivateAction } from './job-actions.js';
import { managedTaskUpdateHandler } from './task-update.js';
import { dashboardJobSetState, dashboardTaskAction, dashboardTaskSetState } from './dashboard-actions.js';
import { codexAndZaiUsageRegistry } from './usage.js';
import { defaultWorkspaceRoot, discoverWorkspaceRepositories, ensureLocalJobSourceBranch, prepareLocalJobExecutionWorktree, resolveJobProjectRoot, resolveManagedProjectPath, resolveRepositoryProjectPath } from './workspace.js';
import { GitHubWebhookWake } from './github-webhook.js';
import { deriveJobRuntimeStatus } from './runtime-status.js';
import { createRuntimeStatusPublisher } from './runtime-status-events.js';
import { subscribeLocalCommits } from './local-commit-events.js';
import { decisionMode, executionDecisionEngine } from './decision.js';
import { JsonlDecisionAuditStore } from './decision-audit.js';
import { summarizeRuntime } from './runtime-summary.js';
import { executionRouterRulesPath } from './routing-policy.js';
import { workerCandidates } from './worker-routing.js';
import { discoverAgents } from './registry.js'; import { shutdownOwnedProcesses } from './owned-process.js';
import { routeExecution } from './execution-routing.js';
import { RelayObservability, classifyFailure, errorMessage, observability, setObservability } from './observability.js';

export function createWorkspaceControl(deps: any) {
  const { client, trusted, noGitHub, repositories, repositoryPaths, refreshAll, requireLocalJobBinding, makeReconciler, concurrency, pool, bus, isEffectivelyBlocked, unblockTask, publishTaskUnblocked, dispatchTaskAction, registerBlockerDependency, discoverAgents, ensureManagedGitHubJob, ensureBlockerRecovery: runBlockerRecovery = ensureBlockerRecovery } = deps;
  const workspaceControl = async (body: Record<string, unknown>): Promise<unknown> => {
    const command = typeof body.command === 'string' ? body.command : '';
    const jobId = typeof body.jobId === 'string' ? body.jobId : '';
    if (!command) throw new Error('control command is required');

    if (command === 'job.create') {
      const repository = typeof body.repository === 'string' ? body.repository : '';
      const options = (body.options && typeof body.options === 'object' ? body.options : {}) as Record<string, unknown>;
      if (options.contentOnly !== undefined || options.executionMode !== undefined) throw new Error('Execution mode/content-only is obsolete; use normal Job reviewEnabled and autoMerge policy');
      if (!repository) throw new Error('job.create requires repository');
      if ('schedule' in options) throw new Error('Job schedules are unsupported');
      if(options.coordinator && body.initialPlan===true)throw Error('Coordinator Job must not request an initial Planner');
      const result = await ensureManagedGitHubJob(client, repository, trusted, {
        id: typeof options.id === 'string' && options.id ? options.id : undefined,
        idempotencyKey: typeof options.idempotencyKey === 'string' ? options.idempotencyKey : undefined,
        title: typeof options.title === 'string' ? options.title : undefined,
        objective: typeof options.objective === 'string' ? options.objective : undefined,
        projectRoot: typeof options.projectRoot === 'string' ? options.projectRoot : undefined,
        githubRepo: typeof options.githubRepo === 'string' ? options.githubRepo : undefined,
        projectPath: typeof options.projectPath === 'string' ? options.projectPath : undefined,
        priority: options.priority as import('./types.js').Priority | undefined,
                tag: options.tag as import('./types.js').Job['tag'] | undefined,
        reviewEnabled: typeof options.reviewEnabled === 'boolean' ? options.reviewEnabled : undefined,
        autoMerge: typeof options.autoMerge === 'boolean' ? options.autoMerge : undefined,
        continuation: options.continuation as import('./types.js').Job['continuation'] | undefined,
        reviewerThreadId: typeof options.reviewerThreadId === 'string' ? options.reviewerThreadId : undefined,
        creatorThreadId: typeof options.creatorThreadId === 'string' ? options.creatorThreadId : undefined,
        implementationThreadId: typeof options.implementationThreadId === 'string' ? options.implementationThreadId : undefined,
        noGitHub,
        coordinator: options.coordinator as {graph:string;input:string;outputPath:string;projectRoot:string;workspaceRoot:string;sharedRoot?:string;globalRoot?:string}|undefined,
        persist: body.initialPlan !== true,
      });
      if (!repositories.includes(repository)) repositories.push(repository);
      await refreshAll();
      if (body.initialPlan === true) {
        const current = result.job;
        const existingPlan = current.plans?.at(-1);
        if (existingPlan) return { repository, pr: result.pr.number, job: current.id, state: current.state, initialPlan: existingPlan.id, reused: true };
        const unpublished = new InMemoryStore(current);
        const reconciler = makeReconciler(unpublished, concurrency);
        try {
          const planned = await reconciler.planJob(result.job.id);
          const unpublishedStore = openLocalManagedStore(repository, 0, { directory: relayStoreDirectory(), jobId: result.job.id, noGitHub: true });
          let committed = planned.job;
          try {
            committed = unpublishedStore.store.createJobIfAbsent
              ? await unpublishedStore.store.createJobIfAbsent(planned.job)
              : (await unpublishedStore.store.saveJob(planned.job), planned.job);
          } finally { unpublishedStore.relay.close(); }
          await pool.reconcileLocalJob(result.job.id, 'control.job.create.initial-plan');
          return { repository, pr: committed.prNumber, job: committed.id, state: committed.state, initialPlan: committed.plans?.at(-1)?.id };
        } finally { await reconciler.close(); }
      }
      if(options.coordinator)return {repository,pr:result.pr.number,job:result.job.id,state:result.job.state,taskId:'coordinator'};
      return { repository, pr: result.pr.number, job: result.job.id, state: result.job.state };
    }

    if (!jobId) throw new Error(command + ' requires jobId');
    const binding = await requireLocalJobBinding(jobId);
    const store = binding.store;
    const job = await store.load(jobId);

    if (command.startsWith('review.interactive.')) {
      const taskId=typeof body.taskId==='string'?body.taskId:'';
      const executionId=typeof body.executionId==='string'?body.executionId:'';
      if(!taskId||!executionId)throw new Error('Interactive review requires taskId and executionId');
      if(command==='review.interactive.begin')
        return await beginInteractiveReview(store,jobId,taskId,executionId);
      if(command==='review.interactive.abort'){
        await abortInteractiveReview(store,jobId,taskId,executionId);
        return {aborted:true};
      }
      if(command==='review.interactive.wait'){
        const current=(await store.load(jobId)).tasks.find((t:Task)=>t.id===taskId);
        if(current?.state==='AWAITING_DECISION'&&current.interactiveInvocation?.executionId===executionId)
          return {waiting:true,taskState:'AWAITING_DECISION'};
        if(current?.state!=='RUNNING'||current.executionId!==executionId||
           current.interactiveInvocation?.executionId!==executionId)
          throw new Error('Stale interactive waiting request');
        const reconciler=makeReconciler(store,concurrency);
        const event=interactiveWaitingEvent(jobId,taskId,current.parentTaskId,executionId);
        try{
          const outcome=await reconciler.applyEvent(event);
          if(!outcome.applied)throw new Error('Relay rejected interactive waiting event: '+outcome.reason);
          // The durable graph transition is authoritative. The ordinary bus
          // records the handoff for event history; duplicate consumption is inert.
          try{await bus?.publish(event);}catch(error){
            process.stderr.write(`warning: interactive wait event transport: ${String(error)}\n`);
          }
          return {waiting:true,taskState:'AWAITING_DECISION'};
        }finally{await reconciler.close();}
      }
      if(command==='review.interactive.fail'){
        const result=await failInteractiveReview(store,jobId,taskId,executionId,
          typeof body.reason==='string'?body.reason:'Interactive review failed');
        if(result.requeued)await pool.reconcileLocalJob(jobId,'interactive.preview-failed');
        return result;
      }
      throw new Error('Unknown interactive review command');
    }
    if (command === 'job.update') {
      const patch = (body.patch && typeof body.patch === 'object' ? body.patch : {}) as Record<string, unknown>;
      if ('executionMode' in patch || 'schedule' in patch) throw new Error('Job execution modes and schedules are unsupported');
      const mutable = ['title','objective','projectPath','priority','tag','autoMerge','reviewEnabled','reviewerThreadId','creatorThreadId','implementationThreadId','continuation','localMerge'] as const;
      for (const key of mutable) if (Object.prototype.hasOwnProperty.call(patch, key)) {
        const value = patch[key];
        if (['reviewerThreadId', 'creatorThreadId', 'implementationThreadId'].includes(key)) {
          (job as unknown as Record<string, unknown>)[key] = value === undefined || value === null ? undefined : normalizeThreadId(value, `Job ${key}`);
        } else (job as unknown as Record<string, unknown>)[key] = value;
      }
      job.updatedAt = new Date().toISOString();
      await store.saveJob(job); await refreshAll(); return await store.load(jobId);
    }
    if (command === 'job.plan') {
      const reconciler = makeReconciler(store, concurrency);
      try { const planned = await reconciler.planJob(jobId, typeof body.guidance === 'string' && body.guidance.trim() ? body.guidance : undefined, body.forceRestate === true); await pool.reconcileLocalJob(jobId, 'control.job.plan'); return planned.round; }
      finally { await reconciler.close(); }
    }
    if (command === 'job.unblock') {
      const reason = typeof body.reason === 'string' ? body.reason : '';
      if (!reason.trim()) throw new Error('job unblock requires reason');
      const blocked = job.tasks.filter(isEffectivelyBlocked);
      if (!blocked.length) throw new Error(`Job ${job.id} has no effective BLOCKED work task`);
      for (const task of blocked) await unblockTask({ store, job, task, trigger: { source: 'cli', reason } });
      const refreshed = await store.load(jobId);
      for (const task of blocked) await publishTaskUnblocked(bus, refreshed, task.id, reason);
      await pool.reconcileLocalJob(jobId, 'control.job.unblock');
      return await store.load(jobId);
    }
    if (command === 'task.revise') {
      const repository = typeof body.repository === 'string' ? body.repository : '';
      const originalTaskId = typeof body.taskId === 'string' ? body.taskId : '';
      const reviewTaskId = typeof body.reviewTaskId === 'string' ? body.reviewTaskId : '';
      const reviewExecutionId = typeof body.reviewExecutionId === 'string' ? body.reviewExecutionId : '';
      const headSha = typeof body.headSha === 'string' ? body.headSha : '';
      const requestId = typeof body.requestId === 'string' ? body.requestId : '';
      const findings = body.findings;
      if (!repository || repository !== job.repository || !originalTaskId || !reviewTaskId || !reviewExecutionId || !requestId
          || !/^[a-f0-9]{40,64}$/i.test(headSha) || !Array.isArray(findings) || findings.length < 1 || findings.length > 200)
        throw new Error('task.revise requires matching repository, original/reviewer IDs, active execution ID, valid SHA, stable request ID and nonempty findings');
      // Trust fresh local Git truth, not the caller or PR projection. The
      // atomic reducer independently checks durable head and execution.
      const projectRoot = await resolveJobProjectRoot(job);
      const projectPath = resolveRepositoryProjectPath(projectRoot, job.projectPath);
      const liveHead = job.localMerge?.sourceRef
        ? localSourceHead(projectPath, job.localMerge.sourceRef)
        : localWorkingHead(projectPath);
      if (liveHead !== headSha) throw new Error('task.revise rejected: local Git source head changed since immutable review');
      const response = await submitTargetedRevisionRequest(store, jobId, {
        requestId, reviewTaskId, reviewExecutionId, headSha, originalTaskId,
        findings: findings as RevisionFinding[],
      });
      // Reviewer is still RUNNING: verdict event will wake the reconciler.
      // The committed receipt must not be obscured by an unrelated wake failure.
      return response;
    }
    if (command === 'task.comment') {
      const taskId = typeof body.taskId === 'string' ? body.taskId : '';
      const message = typeof body.message === 'string' ? body.message : '';
      if (!taskId || !message.trim()) throw new Error('task comment requires taskId and message');
      let appended;
      await store.mutateJob(jobId, (current: Job) => { appended = appendTaskComment(current, taskId, message); return current; });
      return appended;
    }
    if (command === 'task.supersede') {
      const taskId = typeof body.taskId === 'string' ? body.taskId : '';
      const reason = typeof body.reason === 'string' ? body.reason : '';
      if (!taskId || !reason.trim()) throw new Error('task supersede requires taskId and reason');
      await supersedeCancelledTask(store, jobId, taskId, reason);
      await pool.reconcileLocalJob(jobId, 'control.task.supersede');
      return await store.load(jobId);
    }
    if (command === 'task.classify') {
      const taskId = typeof body.taskId === 'string' ? body.taskId : '';
      const raw = body.classification as Record<string, unknown> | undefined;
      if (!taskId || !raw || (raw.kind !== 'superseded' && raw.kind !== 'invalid') || typeof raw.targetTaskId !== 'string' || typeof raw.evidence !== 'string' || typeof raw.reason !== 'string') throw new Error('task classify requires taskId, classification, targetTaskId, evidence, and reason');
      await classifyFailedTask(store, jobId, taskId, { kind: raw.kind, targetTaskId: raw.targetTaskId, evidence: raw.evidence, reason: raw.reason });
      await pool.reconcileLocalJob(jobId, 'control.task.classify');
      return await store.load(jobId);
    }
    if (command === 'task.recover') {
      const taskId = typeof body.taskId === 'string' ? body.taskId : '';
      const recoveryTaskId = typeof body.recoveryTaskId === 'string' ? body.recoveryTaskId : '';
      if (!taskId || !recoveryTaskId) throw new Error('task recover requires taskId and recoveryTaskId');
      await dispatchTaskAction(store, { id: 'task.recover', jobId, taskId, recoveryTaskId, recoveryDiagnosis: body.recoveryDiagnosis as import('./task-actions.js').TaskActionRequest['recoveryDiagnosis'] });
      await pool.reconcileLocalJob(jobId, 'control.task.recover'); return await store.load(jobId);
    }
    if (command === 'task.unblock') {
      const taskId = typeof body.taskId === 'string' ? body.taskId : ''; const reason = typeof body.reason === 'string' ? body.reason : '';
      const task = job.tasks.find((item: {id: string}) => item.id === taskId); if (!task) throw new Error(`Task ${taskId} not found`);
      if (task.agentName === 'troubleshooter' && task.escalation?.status === 'pending' && typeof body.response === 'string') {
        const resumed = await resumeTroubleshooter(store, jobId, taskId, body.response);
        await publishTaskUnblocked(bus, resumed.job, taskId, reason || 'Human response recorded');
        await pool.reconcileLocalJob(jobId, 'control.task.unblock.troubleshooter'); return await store.load(jobId);
      }
      await unblockTask({ store, job, task, trigger: { source: 'cli', reason } });
      const refreshed = await store.load(jobId); await publishTaskUnblocked(bus, refreshed, taskId, reason);
      await pool.reconcileLocalJob(jobId, 'control.task.unblock'); return await store.load(jobId);
    }
    if (command === 'task.escalate') {
      const recoveryTaskId = typeof body.taskId === 'string' ? body.taskId : '';
      const requiredAction = typeof body.requiredAction === 'string' ? body.requiredAction : '';
      const resolutionCondition = typeof body.resolutionCondition === 'string' ? body.resolutionCondition : '';
      const context = typeof body.context === 'string' ? body.context : '';
      const result = await requestTroubleshooterEscalation(store, jobId, recoveryTaskId, { requiredAction, resolutionCondition, context });
      await publishTaskBlocked(bus, result.job, recoveryTaskId, requiredAction, { escalationId: result.escalation.id, originalTaskId: result.escalation.originalTaskId });
      await pool.reconcileLocalJob(jobId, 'control.task.escalate');
      return await store.load(jobId);
    }
    if (command === 'task.resume-troubleshooter') {
      const recoveryTaskId = typeof body.taskId === 'string' ? body.taskId : '';
      const response = typeof body.response === 'string' ? body.response : '';
      const resumed = await resumeTroubleshooter(store, jobId, recoveryTaskId, response);
      await publishTaskUnblocked(bus, resumed.job, recoveryTaskId, 'Human response recorded');
      await pool.reconcileLocalJob(jobId, 'control.task.resume-troubleshooter');
      return await store.load(jobId);
    }
    if (command === 'review.request') {
      if (job.state === 'CANCELLED' || job.state === 'COMPLETED') throw new Error('Cannot request review for terminal Job');
      if (!job.reviewEnabled) throw new Error('Review disabled for this Job');
      if (typeof body.threadId === 'string') { job.reviewerThreadId = body.threadId; job.updatedAt = new Date().toISOString(); await store.saveJob(job); }
      await pool.reconcileLocalJob(jobId, 'control.review.request'); return await store.load(jobId);
    }
    if (command === 'blocker.add') {
      const dependentJobId = typeof body.dependentJobId === 'string' ? body.dependentJobId : '';
      const dependentTaskId = typeof body.dependentTaskId === 'string' ? body.dependentTaskId : '';
      const dependent = await requireLocalJobBinding(dependentJobId);
      const relation = await registerBlockerDependency({ blockerStore: store, blockerJobId: jobId, dependentStore: dependent.store, dependentJobId, dependentTaskId, resolutionMode: body.resolutionMode === 'verified' ? 'verified' : 'merge' });
      // Registering a blocker is itself runnable-work creation. Wake the blocker
      // Job immediately instead of waiting for inventory polling/stale rescue.
      await pool.reconcileLocalJob(jobId, 'control.blocker.add');
      await refreshAll(); return relation;
    }
    if (command === 'blocker.ensure') {
      const request = body.request && typeof body.request === 'object' ? body.request as Record<string, unknown> : {};
      const readText = (field: string): string => typeof request[field] === 'string' ? request[field] : '';
      if (request.origin !== 'planner' && request.origin !== 'troubleshooter') throw new Error('blocker.ensure origin must be planner or troubleshooter');
      if (request.resolutionMode !== 'merge' && request.resolutionMode !== 'verified') throw new Error('blocker.ensure resolutionMode must be merge or verified');
      const recoveryInput: BlockerRecoveryInput = {
        requestId: readText('requestId'),
        targetRepository: readText('targetRepository'),
        targetProjectRoot: repositoryPaths.get(readText('targetRepository')) ?? '',
        dependentRepository: readText('dependentRepository'),
        dependentJobId: readText('dependentJobId'),
        dependentTaskId: readText('dependentTaskId'),
        reason: readText('reason'),
        title: readText('title'),
        objective: readText('objective'),
        projectPath: typeof request.projectPath === 'string' && request.projectPath ? request.projectPath : undefined,
        resolutionMode: request.resolutionMode,
        origin: request.origin,
        authorized: request.authorized === true,
        authorizedRepositories: repositories,
      };
      const recovered = await runBlockerRecovery(recoveryInput);
      if (!repositories.includes(recoveryInput.targetRepository)) repositories.push(recoveryInput.targetRepository);
      let planningRecoveryRequired = recovered.planningRecoveryRequired;
      let status = recovered.status;
      if (recovered.planningRecoveryRequired) {
        const blocker = openLocalManagedStore(recoveryInput.targetRepository, 0, {
          directory: relayStoreDirectory(), jobId: recovered.blockerJobId, noGitHub: true,
        });
        const planner = makeReconciler(blocker.store, concurrency);
        try {
          await planner.planJob(recovered.blockerJobId);
          planningRecoveryRequired = false;
          status = 'planned';
          if (blocker.store.mutateJob) {
            await blocker.store.mutateJob(recovered.blockerJobId, (current: Job) => ({
              ...current,
              blockerRecoveryRequest: current.blockerRecoveryRequest
                ? { ...current.blockerRecoveryRequest, status: 'planned', updatedAt: new Date().toISOString() }
                : undefined,
            }));
          }
        } catch (error) {
          const current = await blocker.store.load(recovered.blockerJobId);
          const latestPlan = [...(current.plans ?? [])].sort((left, right) => right.round - left.round)[0];
          if (latestPlan?.status !== 'PLANNING') throw error;
        } finally {
          await planner.close();
          blocker.relay.close();
        }
        if (!planningRecoveryRequired && store.mutateJob) {
          await store.mutateJob(recovered.dependentJobId, (current: Job) => {
            const task = current.tasks.find((item: Task) => item.id === recovered.dependentTaskId);
            const receipt = task?.blockerRecoveryReceipt;
            if (task && receipt && receipt.requestId === recovered.requestId) {
              task.blockerRecoveryReceipt = { ...receipt, status: 'planned', planningRecoveryRequired: false, updatedAt: new Date().toISOString() };
            }
            current.updatedAt = new Date().toISOString();
            return current;
          });
        }
      }
      const blockerSnapshot = openLocalManagedStore(recoveryInput.targetRepository, 0, {
        directory: relayStoreDirectory(), jobId: recovered.blockerJobId, noGitHub: true,
      });
      try {
        if (blockerSnapshot.store.resolveBlockerDependents) {
          const released = await blockerSnapshot.store.resolveBlockerDependents(recovered.blockerJobId, 'merge');
          for (const target of released.unblocked) await pool.reconcileLocalJob(target.jobId, 'control.blocker.ensure.resolution');
        }
      } finally { blockerSnapshot.relay.close(); }
      await pool.reconcileLocalJob(recovered.dependentJobId, 'control.blocker.ensure.dependent');
      await pool.reconcileLocalJob(recovered.blockerJobId, 'control.blocker.ensure.blocker');
      await refreshAll();
      return { ...recovered, status: planningRecoveryRequired ? 'planning_required' : status, planningRecoveryRequired };
    }
    if (command === 'blocker.resolve') {
      if (!store.resolveBlockerDependents) throw new Error('Blocker resolution unavailable');
      const summary = await store.resolveBlockerDependents(jobId, body.resolution === 'merge' ? 'merge' : 'verified');
      for (const target of summary.unblocked) await pool.reconcileLocalJob(target.jobId, 'control.blocker.resolve');
      await refreshAll(); return summary;
    }
    if (command === 'projection.conflicts') return await binding.relay.listProjectionConflicts();
    if (command === 'job.reconcile') { await pool.reconcileLocalJob(jobId, 'control.job.reconcile'); return await store.load(jobId); }
    if (command === 'agent.discover') {
      return discoverAgents(await store.listAgents(), (body.requirements && typeof body.requirements === 'object' ? body.requirements : {}) as Parameters<typeof discoverAgents>[1]);
    }
    if (command === 'projection.resolve') {
      const id = Number(body.projectionId); const action = body.action === 'discard_local' ? 'discard_local' : 'requeue';
      if (!Number.isInteger(id) || id <= 0) throw new Error('projection resolve requires projectionId');
      const resolved = await binding.relay.resolveProjectionConflict(id, { action, ...(typeof body.note === 'string' && body.note ? { note: body.note } : {}) });
      if (!resolved) throw new Error(`Projection ${id} is not in a resolvable conflict state`); return { resolved: id, action };
    }
    if (command === 'record') {
      const task = body.task as import('./types.js').Task | undefined; if (!task || task.jobId !== jobId) throw new Error('record requires a task for this Job');
      await store.appendTask(task); await pool.reconcileLocalJob(jobId, 'control.record'); return await store.load(jobId);
    }
    if (command === 'agent.register') {
      const agent = body.agent as import('./types.js').AgentRegistration | undefined; if (!agent) throw new Error('agent.register requires agent');
      await store.saveAgent(agent); return agent;
    }
    throw new Error('Unsupported control command ' + command);
  };
  return workspaceControl;
}
