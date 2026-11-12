import { assertV2StateTransition, jobLifecycleV2, taskLifecycleV2 } from './workflow/definitions-v2.js';
export type JobLifecycleState = 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type JobRuntimeStatus = 'IDLE' | 'WAITING' | 'QUEUED' | 'RUNNING' | 'BLOCKED' | 'FAILED' | 'REVIEWING' | 'MERGE_PENDING' | 'MERGED' | 'COMPLETED' | 'CANCELLED';
export type TaskState = 'DRAFT' | 'QUEUED' | 'RUNNING' | 'AWAITING_DECISION' | 'BLOCKED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type JobTag = { description: string; values: Record<string, string> };
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type WorkerAdapterName = 'codex' | 'chatgpt' | 'z' | 'script';
/** Persisted compatibility only: new Tasks may use WorkerAdapterName values only. */
export type AdapterName = WorkerAdapterName | 'orchestrator';
export type ChatGptTabClosePolicy = 'after-start' | 'never' | 'after-terminal';
export type TaskKind = 'work' | 'planner';
export type PlanningDecisionSource = 'orchestrator' | 'model-planner';
export type StorySize = 'S' | 'M' | 'L';
export const STORY_SIZE_TIMEOUT_MS: Record<StorySize, number> = { S: 300000, M: 900000, L: 2700000 };
export function storySizeTimeoutMs(size: StorySize): number { return STORY_SIZE_TIMEOUT_MS[size]; }
export function taskOverallTimeoutMs(size: StorySize, reasoning?: string): number { return storySizeTimeoutMs(size) * (reasoning?.toLowerCase() === 'high' ? 2 : 1); }
export function chatGptStartAckTimeoutMs(overallTimeoutMs: number): number { return Math.min(600000, Math.max(120000, Math.floor(overallTimeoutMs / 3))); }
export type AgentAvailability = 'available' | 'degraded' | 'offline';
export type AgentEndpoint = { kind: 'adapter' | 'command' | 'http'; target: string };
export type AgentEvidence = {
  evaluations: Array<{ taskKind: string; outcome: 'success' | 'failure' | 'timeout'; observedAt: string; summary?: string; latencyMs?: number; cost?: number }>;
  outcomes: { succeeded: number; failed: number; timedOut: number };
  lastObservedAt: string | null;
};
export type AgentRegistration = {
  id: string;
  name: string;
  responsibility: string;
  role: string;
  capabilities: string[];
  boundaries: string[];
  endpoint: AgentEndpoint;
  runtime: { adapter: string; provider?: string; model?: string };
  availability: AgentAvailability;
  routing: { labels?: Record<string, string>; trustDomains?: string[]; regions?: string[] };
  evidence: AgentEvidence;
  registeredAt: string;
  updatedAt: string;
};
export type DecisionEvidence = { mode: 'off' | 'shadow' | 'active'; engine?: string; proposed?: string; probabilities?: Record<string, number>; proposedFields?: Record<string, string>; fallback: boolean; error?: string };
export type RoutingDecision = { provider: string; model: string; profile?: string; reasoning?: string; cwd?: string; projectId?: string; decisionId?: string; decidedBy: string; decidedAt: string; decisionEvidence?: DecisionEvidence };
/** Requirements declared by a planner before a worker is selected. */
export type WorkerRequirements = {
  capabilities: string[];
  runtime?: string;
  taskKind?: string;
  trustDomain?: string;
  region?: string;
  labels?: Record<string, string>;
};
/** The worker-router's selection; model routing happens only after this exists. */
export type ResourceUsageWindow = { remainingPercent: number; resetAt: number | null; resetInMinutes: number | null };
export type BrowserWorkspaceCapacity = { name: string; poolSize: number | null; idle: number | null; leased: number | null; available: number | null; observedAt: string; reason: string | null };
export type WorkerSelection = {
  workerId: string;
  adapter: WorkerAdapterName;
  capabilities: string[];
  selectedBy: string;
  selectedAt: string;
  resourceHealthy?: boolean;
  resourceProvider?: string;
  resourceUsedPercent?: number;
  resourceRemainingPercent?: number;
  resourceResetAt?: number;
  resourceResetInMinutes?: number;
  resourceWindows?: { fiveHour?: ResourceUsageWindow; weekly?: ResourceUsageWindow };
  browserWorkspaceCapacity?: BrowserWorkspaceCapacity;
  decisionEvidence?: DecisionEvidence;
};
export type Result = { summary: string; artifacts?: string[]; data?: Record<string, unknown> };
export type BlockerResolutionMode = 'merge' | 'verified';
export type BlockerReference = { repository: string; prNumber: number; jobId: string };
export type TaskBlockerReference = BlockerReference & { blockedAttempt: number; registeredAt: string };
export type BlockedBaseline = { blockedAt: string; headSha?: string; reason?: string };
export type TaskUnblockRecord = { event: 'task.unblocked'; at: string; source: 'cli' | 'blocker_job'; reason: string; baseline: BlockedBaseline; currentHeadSha?: string; facts?: string[]; blockerJobId?: string; resolution?: 'merge' | 'verified' };
export type TaskResolutionPath = 'exact_original_retry' | 'same_job_dependency' | 'blocker_job_dependency' | 'escalation_gate' | 'cancel_supersede';
export type TaskResolutionOwner = 'planner' | 'troubleshooter' | 'blocker-job' | 'human' | 'external' | null;
export type TaskResolutionState = 'proposed' | 'active' | 'waiting' | 'resolved' | 'cancelled';
export type TaskResolution = {
  path: TaskResolutionPath;
  state: TaskResolutionState;
  owner: TaskResolutionOwner;
  targetTaskId?: string;
  targetJobId?: string;
  mode?: BlockerResolutionMode;
  rootCause?: string;
  solution?: string;
  deviations?: string[];
  validationEvidence?: string[];
  recoveryExecutionId?: string;
  updatedAt: string;
};
export type TaskResolutionProposal = Pick<TaskResolution, 'path' | 'targetTaskId' | 'targetJobId' | 'mode' | 'rootCause' | 'solution' | 'deviations' | 'validationEvidence' | 'recoveryExecutionId'>;
export type TaskEscalation = {
  id: string;
  fingerprint?: string;
  originalTaskId?: string;
  originalPlanId?: string;
  originalExecutionId?: string;
  recoveryExecutionId?: string;
  requiredAction: string;
  resolutionCondition: string;
  context: string;
  status: 'pending' | 'responded' | 'resolved' | 'rejected';
  requestedAt: string;
  respondedAt?: string;
  response?: string;
  notification?: Record<string, unknown> | null;
};
export type JobChangeCycle = { triggeredAt: string; source: 'cli' | 'blocker_job'; reason: string; taskIds: string[]; baselineHeadShas: string[]; currentHeadSha?: string; facts: string[]; consumedByPlannerTaskId?: string }; // legacy read compatibility
export type PlanTrigger = { source: 'initial' | 'continuation' | 'manual' | 'schedule' | 'unblock' | 'review'; reviewTaskId?: string; taskIds?: string[]; reason?: string; facts?: string[]; blockedHeadShas?: string[]; currentHeadSha?: string; unblockSource?: 'cli' | 'blocker_job' };
export type Plan = { jobId: string; id: string; round: number; source: PlanningDecisionSource; previousPlanId: string | null; trigger: PlanTrigger; status: 'PLANNING' | 'SUCCEEDED' | 'FAILED'; guidance?: string; forceRestate?: boolean; restateTaskIds?: string[]; objectiveStatus?: 'in_progress' | 'satisfied'; plannerResult?: import('./planner.js').PlannerResult; appliedCandidateFingerprint?: string; assessment: string; generatedTaskIds: string[]; pendingUnblocks?: import('./planner.js').PlannerUnblockSpec[]; headSha?: string; error?: string; attempt?: number; maxAttempts?: number; leaseOwner?: string | null; leaseExpiresAt?: string | null; executionId?: string | null; appliedExecutionId?: string; pausedExecutionId?: string; retryFeedback?: string; timeoutMs?: number; manualPlanning?: boolean; createdAt: string; updatedAt: string; planUrl?: string };
export type BlockerDependentState = 'waiting' | 'resumed' | 'obsolete';
export type BlockerDependent = { repository: string; prNumber: number; jobId: string; taskId: string; blockedAttempt: number; registeredAt: string; state: BlockerDependentState; resolvedAt?: string; resolution?: 'merge' | 'verified'; note?: string };
export type BlockerRecoveryRequest = {
  requestId: string;
  intentFingerprint: string;
  reason: string;
  status: 'created' | 'registered' | 'planning_required' | 'planned';
  targetRepository: string;
  dependentRepository: string;
  dependentJobId: string;
  dependentTaskId: string;
  blockedAttempt?: number;
  title: string;
  objective: string;
  projectPath?: string;
  resolutionMode: BlockerResolutionMode;
  origin: 'planner' | 'troubleshooter';
  authorized: boolean;
  createdAt: string;
  updatedAt: string;
};
export type BlockerRecoveryReceipt = {
  requestId: string;
  reason: string;
  status: 'registered' | 'planning_required' | 'planned';
  blockerJobId: string;
  blockerRepository: string;
  dependentRepository: string;
  dependentJobId: string;
  dependentTaskId: string;
  resolutionMode: BlockerResolutionMode;
  outcome: 'created' | 'reused' | 'registered';
  planningRecoveryRequired: boolean;
  createdAt: string;
  updatedAt: string;
};
export type TaskOutput = { kind: 'task_pr' } | { kind: 'file'; path: string };
export type ReviewTarget = { artifact: string; version: string };
export type ReviewTaskMetadata = {
  role: 'chair' | 'specialist';
  target: ReviewTarget;
  dimension?: string;
  selectionReason?: string;
  round?: number;
};
export type ManualTaskStateOverride = { from: TaskState; to: TaskState; at: string; actor: 'dashboard-user' };
export type ReviewOutcome = 'pending' | 'started' | 'approved' | 'changes_required' | 'blocked' | 'stale';
/** A review verdict never authorizes editing an already SUCCEEDED Task. */
export type ReviewRevisionDisposition = 'targeted' | 'needs-ownership';
export type ReviewState = { outcome: ReviewOutcome; headSha: string; taskId: string | null; evidence: Result | null; updatedAt: string; revisionDisposition?: ReviewRevisionDisposition };
/** Missing dependency policy means order-only (the pre-revision default). */
export type DependencyValidity = 'order-only' | 'revalidate' | 'rerun';
/** Each value identifies the exact upstream successful evidence generation. */
export type DependencyRevisionVector = Record<string, string>;
export type RevisionKind = 'targeted' | 'revalidate' | 'rerun';
export type RevisionStatus = 'requested' | 'queued' | 'running' | 'verified' | 'failed' | 'stale';
export type RevisionFinding = { id: string; summary: string; evidence?: string };
/** Durable request identity; status/task linkage is monotone. */
export type ReviewRevisionRequest = {
  requestId: string;
  reviewTaskId: string;
  reviewExecutionId: string;
  reviewHeadSha: string;
  originalTaskId: string;
  findings: RevisionFinding[];
  createdAt: string;
  status: RevisionStatus;
  revisionTaskId?: string;
  dependencyVector?: DependencyRevisionVector;
  feedbackOrigin: 'final-review' | 'authenticated-adapter';
};
/** Review rounds are historical; Job.review is the current delivery gate. */
export type ReviewRevisionRound = {
  reviewTaskId: string;
  reviewExecutionId: string;
  headSha: string;
  requestIds: string[];
  status: 'changes_required' | 'approved';
  findingFingerprint?: string;
  nextReviewTaskId?: string;
  recordedAt: string;
};
/** A separate Task owns each new result, leaving the original Task immutable. */
export type TaskRevision = {
  kind: RevisionKind;
  originalTaskId: string;
  requestIds: string[];
  reviewTaskId: string;
  basedOnHeadSha: string;
  dependencyVector?: DependencyRevisionVector;
  threadContinuation?: { decision: 'reuse' | 'fallback'; reason: string; originalThreadId?: string; decidedAt: string };
};
export type ChatGptThreadDelivery = {
  kind: 'new-turn';
  threadId: string;
  threadSource: 'override' | 'reviewer' | 'creator' | 'implementation' | 'original-task';
  requestId: string;
  jobId: string;
  repository?: string;
  taskId?: string;
  prNumber: number;
  reviewHeadSha?: string;
  executionId?: string;
  projectId?: string | null;
  deliveredAt?: string | null;
};
export type Task = {
  comments?: import('./task-comments.js').TaskComment[];
  jobId?: string; id: string; title?: string; taskUrl?: string; kind?: TaskKind; priority?: Priority; storySize?: StorySize; projectName?: string; agentName?: string; agentGraph?: string; dagNode?: { parentTaskId: string; nodeId: string; graphHash: string; executor: 'script' | 'model' }; parentTaskId: string | null; dependencies: string[]; capabilities: string[]; taskCapabilities?: string[]; workerCapabilities?: string[]; adapter: AdapterName;
  planningDecisionId?: string; planningSource?: PlanningDecisionSource; planningRound?: number; previousPlannerTaskId?: string | null; planTrigger?: PlanTrigger; tag?: string; plannerRetryFeedback?: string; plannerGuidance?: string; manualPlanning?: boolean; dependencyValidity?: Record<string, DependencyValidity>; revision?: TaskRevision;
  resolutionClassification?: { kind: 'superseded' | 'invalid'; targetTaskId: string; evidence: string; reason: string; updatedAt: string };
  input: string; attachments?: string[]; output?: TaskOutput; review?: ReviewTaskMetadata; workerRequirements?: WorkerRequirements; workerSelection?: WorkerSelection; routing?: RoutingDecision; continuation?: Continuation | null; continuationDeliveredAt?: string | null; chatgptTabClosePolicy?: ChatGptTabClosePolicy; state: TaskState; attempt: number; maxAttempts: number;
  leaseOwner: string | null; leaseExpiresAt: string | null; executionId: string | null; executionHistory?: Array<{ id: string; attempt: number; startedAt: string }>; threadId: string | null; threadUrl?: string | null; threadHistory?: Array<{executionId:string;threadUrl:string;attempt:number;at:string}>;
  threadDeletedAt?: string | null; threadCleanupError?: string | null;
  reviewHeadSha?: string;
  recoveryPlanId?: string;
  recoveryContext?: { failureKind: string; reason: string; evidence?: string; recoveryTaskId: string; at: string; reroute: boolean };
  routingExclusions?: Array<{ provider: string; model: string; profile?: string; workerId?: string; adapter?: WorkerAdapterName; reason: string; at: string }>;
  noStartFallback?: {
    failedExecutionId: string;
    failedAttempt: number;
    previous: { adapter: WorkerAdapterName; workerId: string; provider: string; model: string; profile?: string };
    reason: string;
    at: string;
  };
  platformFailure?: {
    classification: 'adapter_failure' | 'transport_failure' | 'launch_failure' | 'start_ack_timeout' | 'browser_workspace_unavailable' | 'mcp_login_required' | 'project_setup_unavailable' | 'model_unavailable' | 'pool_capacity_full' | 'provider_unavailable' | 'outcome_unknown';
    executionId: string;
    route: { workerId: string; adapter: WorkerAdapterName; provider: string; model: string; profile?: string };
    evidence: string;
    safeToReroute: boolean;
    at: string;
  };
  chatgptThreadDelivery?: ChatGptThreadDelivery;
  interactiveInvocation?: import('./interactive-invocation.js').InteractiveInvocation;
  manualStateOverrides?: ManualTaskStateOverride[];
  resolution?: TaskResolution;
  blockerRecoveryReceipt?: BlockerRecoveryReceipt;
  escalation?: TaskEscalation;
  recoveryForAttempt?: number;
  pausedExecution?: { id: string; state: Extract<TaskState, 'RUNNING' | 'QUEUED'>; attempt: number; at: string };
  failureReason?: string;
  blockedBy?: TaskBlockerReference;
  blockedBaseline?: BlockedBaseline;
  unblock?: TaskUnblockRecord;
  result: Result | null; plannerResult?: import('./planner.js').PlannerResult | null; error: string | null; timeoutMs: number; lastProgressAt?: string; lastProgressEventAt?: string; processExitedAt?: string; createdAt: string; updatedAt: string;
};
/** Normalize snapshots written before UNBLOCKED was removed from the lifecycle graph. */
export function normalizeLegacyTaskLifecycle(task: Task): Task {
  const legacy = task as Task & { state: string };
  if ((legacy.state as string) === 'UNBLOCKED') {
    legacy.state = task.agentName === 'troubleshooter' ? 'QUEUED' : 'FAILED';
    task.failureReason ??= 'legacy_unblocked_task_requires_recovery';
    task.maxAttempts = Math.max(3, task.maxAttempts ?? 0, task.attempt + 1);
    task.unblock = task.unblock ? { ...task.unblock, event: 'task.unblocked' } : undefined;
  }
  // Migrate persisted interactive waits from their former overloaded DRAFT state.
  // Ordinary dependency-held DRAFT Tasks remain untouched.
  if (legacy.state === 'DRAFT' && task.attempt > 0 && task.interactiveInvocation &&
      !task.executionId && task.interactiveInvocation.boundAt && !task.unblock &&
      (task.interactiveInvocation.status === 'awaiting_decision' ||
       (Boolean(task.interactiveInvocation.decidedAt) &&
        Date.parse(task.updatedAt) <= Date.parse(task.interactiveInvocation.decidedAt!)))) {
    legacy.state = 'AWAITING_DECISION';
  }
  if (legacy.state === 'BLOCKED' && task.kind !== 'planner' && task.agentName !== 'troubleshooter') {
    legacy.state = 'FAILED';
    task.failureReason ??= task.failureReason === 'worker_outcome_unknown' ? task.failureReason : 'legacy_ordinary_blocked';
    task.error ??= 'Legacy ordinary Task was BLOCKED; preserved as FAILED pending Troubleshooter diagnosis.';
  }
  return task;
}
export type RecoveryFailureRecord = { taskId: string; recoveryTaskId: string; reason: string; at: string };
export type JobPause = { generation: number; requestedAt: string };
export type ProjectionRecovery = { key: string; remoteSha: string; status: 'repairing' | 'retry' | 'projected' | 'escalated'; taskId: string; attempts: number; maxAttempts: number; error?: string; updatedAt: string };
export type Job = { githubProjection?: { status: 'pr_bound' | 'merged_without_pr' | 'no_diff'; sourceSha: string; observedAt: string }; projectionRecovery?: ProjectionRecovery; localMerge?: import('./local-git-merge.js').LocalMergeReceipt; recoveryFailures?: RecoveryFailureRecord[]; blockerRecoveryRequest?: BlockerRecoveryRequest; id: string; title: string; objective?: string; projectPath?: string; priority?: Priority; description?: string; tag?: JobTag; autoMerge?: boolean; reviewEnabled?: boolean; /** Historical data only: never written for new Jobs. */ executionMode?: 'shortcut'; /** Explicitly permits content-only shortcut terminal completion; all PR/review/merge gates remain forbidden. */ contentOnly?: boolean; /** First Shortcut launch timestamp; elapsed-time metric, never a hard cutoff. */ shortcutExecutionStartedAt?: string;
  /** Trusted first Graph start; the ordinary Reconciler uses the same Scheduler for every Job. */ graphStartContext?: {projectPath:string;workspaceRoot:string;sharedRoot?:string;globalRoot?:string;noGitHub:boolean}; /** Historical archived runner context, read-only. */ shortcutRunnerContext?: {projectPath:string;workspaceRoot:string;sharedRoot?:string;globalRoot?:string;noGitHub:boolean}; /** Historical metadata only, ignored by current execution. */ shortcutExecutionDeadlineAt?: string; prNumber: number; repository: string; state: JobLifecycleState; continuation: Continuation | null; review?: ReviewState; reviewRevisionRequests?: ReviewRevisionRequest[]; reviewRevisionRounds?: ReviewRevisionRound[]; headSha?: string; reviewerThreadId?: string; creatorThreadId?: string; implementationThreadId?: string; initialPlanning?: { status: 'pending' | 'complete'; decisionId: string }; blockerResolutionMode?: BlockerResolutionMode; blockerResolvedAt?: string; unblocks?: BlockerDependent[]; changeCycle?: JobChangeCycle; plans?: Plan[]; pause?: JobPause; createdAt: string; updatedAt: string; tasks: Task[] };
export type Continuation = { kind: 'codex-thread' | 'command' | 'webhook'; target: string; input?: string };
export type EventRecord = { version: 1; event_id: string; job_id: string; task_id: string; parent_task_id: string | null; type: string; status: string; timestamp: string; visibility: string; level: string; message: string; source?: Record<string, unknown>; data?: Record<string, unknown> };

export function assertJobLifecycleTransition(from: JobLifecycleState, to: JobLifecycleState): void { assertV2StateTransition(jobLifecycleV2.graph, from, to, 'job'); }
export function assertTaskTransition(from: TaskState, to: TaskState): void { assertV2StateTransition(taskLifecycleV2.graph, from, to, 'task'); }
