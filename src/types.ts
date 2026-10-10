import { assertV2StateTransition, jobLifecycleV2, taskLifecycleV2 } from './workflow/definitions-v2.js';
export type JobLifecycleState = 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type JobRuntimeStatus = 'IDLE' | 'WAITING' | 'QUEUED' | 'RUNNING' | 'BLOCKED' | 'FAILED' | 'REVIEWING' | 'MERGE_PENDING' | 'MERGED' | 'COMPLETED' | 'CANCELLED';
export type TaskState = 'DRAFT' | 'QUEUED' | 'RUNNING' | 'BLOCKED' | 'UNBLOCKED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type JobTag = { description: string; values: Record<string, string> };
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type AdapterName = 'codex' | 'chatgpt' | 'orchestrator';
export type ChatGptTabClosePolicy = 'after-start' | 'never' | 'after-terminal';
export type ExecutionMode = 'fixed' | 'autonomous';
export type MissedRunPolicy = 'run' | 'skip';
export type ScheduleConcurrencyPolicy = 'skip' | 'queue';
export type JobSchedule = {
  cron: string;
  timezone: string;
  nextRunAt: string;
  missedRunPolicy: MissedRunPolicy;
  concurrencyPolicy: ScheduleConcurrencyPolicy;
  lastScheduledSlot?: string | null;
  currentRunSlot?: string | null;
  lastRunAt?: string | null;
};
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
  adapter: Exclude<AdapterName, 'orchestrator'>;
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
export type TaskUnblockRecord = { at: string; source: 'cli' | 'blocker_job'; reason: string; baseline: BlockedBaseline; currentHeadSha?: string; facts?: string[]; blockerJobId?: string; resolution?: 'merge' | 'verified' };
export type JobChangeCycle = { triggeredAt: string; source: 'cli' | 'blocker_job'; reason: string; taskIds: string[]; baselineHeadShas: string[]; currentHeadSha?: string; facts: string[]; consumedByPlannerTaskId?: string }; // legacy read compatibility
export type PlanTrigger = { source: 'initial' | 'continuation' | 'manual' | 'schedule' | 'unblock'; taskIds?: string[]; reason?: string; facts?: string[]; blockedHeadShas?: string[]; currentHeadSha?: string; unblockSource?: 'cli' | 'blocker_job' };
export type Plan = { jobId: string; id: string; round: number; source: PlanningDecisionSource; previousPlanId: string | null; trigger: PlanTrigger; status: 'PLANNING' | 'SUCCEEDED' | 'FAILED'; guidance?: string; objectiveStatus?: 'in_progress' | 'satisfied'; plannerResult?: import('./planner.js').PlannerResult; assessment: string; generatedTaskIds: string[]; headSha?: string; error?: string; attempt?: number; maxAttempts?: number; leaseOwner?: string | null; leaseExpiresAt?: string | null; executionId?: string | null; retryFeedback?: string; timeoutMs?: number; manualPlanning?: boolean; createdAt: string; updatedAt: string; planUrl?: string };
export type BlockerDependentState = 'waiting' | 'resumed' | 'obsolete';
export type BlockerDependent = { repository: string; prNumber: number; jobId: string; taskId: string; blockedAttempt: number; registeredAt: string; state: BlockerDependentState; resolvedAt?: string; resolution?: 'merge' | 'verified'; note?: string };
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
export type ReviewState = { outcome: ReviewOutcome; headSha: string; taskId: string | null; evidence: Result | null; updatedAt: string };
export type ChatGptThreadDelivery = {
  kind: 'new-turn';
  threadId: string;
  threadSource: 'override' | 'reviewer' | 'creator';
  requestId: string;
  jobId: string;
  prNumber: number;
  reviewHeadSha: string;
  projectId?: string | null;
  deliveredAt?: string | null;
};
export type Task = {
  jobId?: string; id: string; taskUrl?: string; kind?: TaskKind; priority?: Priority; storySize?: StorySize; projectName?: string; agentName?: string; agentGraph?: string; parentTaskId: string | null; dependencies: string[]; capabilities: string[]; taskCapabilities?: string[]; workerCapabilities?: string[]; adapter: AdapterName;
  planningDecisionId?: string; planningSource?: PlanningDecisionSource; planningRound?: number; previousPlannerTaskId?: string | null; planTrigger?: PlanTrigger; tag?: string; plannerRetryFeedback?: string; plannerGuidance?: string; manualPlanning?: boolean;
  /** Internal E2E-only planner option, consumed before execution. */
  testInjection?: string | import('./e2e-injection.js').InjectionConfig;
  input: string; attachments?: string[]; output?: TaskOutput; review?: ReviewTaskMetadata; workerRequirements?: WorkerRequirements; workerSelection?: WorkerSelection; routing?: RoutingDecision; continuation?: Continuation | null; continuationDeliveredAt?: string | null; chatgptTabClosePolicy?: ChatGptTabClosePolicy; state: TaskState; attempt: number; maxAttempts: number;
  leaseOwner: string | null; leaseExpiresAt: string | null; executionId: string | null; executionHistory?: Array<{ id: string; attempt: number; startedAt: string }>; threadId: string | null;
  threadDeletedAt?: string | null; threadCleanupError?: string | null;
  reviewHeadSha?: string;
  routingExclusions?: Array<{ provider: string; model: string; profile?: string; reason: string; at: string }>;
  chatgptThreadDelivery?: ChatGptThreadDelivery;
  manualStateOverrides?: ManualTaskStateOverride[];
  failureReason?: string;
  blockedBy?: TaskBlockerReference;
  blockedBaseline?: BlockedBaseline;
  unblock?: TaskUnblockRecord;
  result: Result | null; plannerResult?: import('./planner.js').PlannerResult | null; error: string | null; timeoutMs: number; createdAt: string; updatedAt: string;
};
export type RecoveryFailureRecord = { taskId: string; recoveryTaskId: string; reason: string; at: string };
export type Job = { localMerge?: import('./local-git-merge.js').LocalMergeReceipt; recoveryFailures?: RecoveryFailureRecord[]; id: string; title: string; objective?: string; projectPath?: string; priority?: Priority; description?: string; executionMode: ExecutionMode; schedule?: JobSchedule; tag?: JobTag; autoMerge?: boolean; reviewEnabled?: boolean; prNumber: number; externalPrNumber?: number; repository: string; state: JobLifecycleState; continuation: Continuation | null; review?: ReviewState; headSha?: string; reviewerThreadId?: string; creatorThreadId?: string; initialPlanning?: { status: 'pending' | 'complete'; decisionId: string }; blockerResolutionMode?: BlockerResolutionMode; blockerResolvedAt?: string; unblocks?: BlockerDependent[]; changeCycle?: JobChangeCycle; plans?: Plan[]; createdAt: string; updatedAt: string; tasks: Task[] };
export type Continuation = { kind: 'codex-thread' | 'command' | 'webhook'; target: string; input?: string };
export type EventRecord = { version: 1; event_id: string; job_id: string; task_id: string; parent_task_id: string | null; type: string; status: string; timestamp: string; visibility: string; level: string; message: string; source?: Record<string, unknown>; data?: Record<string, unknown> };

export function assertJobLifecycleTransition(from: JobLifecycleState, to: JobLifecycleState): void { assertV2StateTransition(jobLifecycleV2.graph, from, to, 'job'); }
export function assertTaskTransition(from: TaskState, to: TaskState): void { assertV2StateTransition(taskLifecycleV2.graph, from, to, 'task'); }
