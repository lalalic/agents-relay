export type JobState = 'OPEN' | 'RUNNING' | 'WAITING' | 'BLOCKED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type TaskState = 'QUEUED' | 'READY' | 'RUNNING' | 'WAITING' | 'BLOCKED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
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
export type RoutingDecision = { provider: string; model: string; profile?: string; reasoning?: string; cwd?: string; projectId?: string; decidedBy: string; decidedAt: string };
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
export type WorkerSelection = {
  workerId: string;
  adapter: Exclude<AdapterName, 'orchestrator'>;
  capabilities: string[];
  selectedBy: string;
  selectedAt: string;
  resourceHealthy?: boolean;
  resourceProvider?: string;
  resourceUsedPercent?: number;
};
export type Result = { summary: string; artifacts?: string[]; data?: Record<string, unknown> };
export type TaskOutput = { kind: 'task_pr' } | { kind: 'file'; path: string };
export type ReviewOutcome = 'pending' | 'started' | 'approved' | 'changes_required' | 'blocked' | 'stale';
export type ReviewState = { outcome: ReviewOutcome; headSha: string; taskId: string | null; evidence: Result | null; updatedAt: string };
export type Task = {
  jobId?: string; id: string; taskUrl?: string; kind?: TaskKind; priority?: Priority; storySize?: StorySize; projectName?: string; agentName?: string; parentTaskId: string | null; dependencies: string[]; capabilities: string[]; adapter: AdapterName;
  planningDecisionId?: string; planningSource?: PlanningDecisionSource; planningRound?: number;
  input: string; attachments?: string[]; output?: TaskOutput; workerRequirements?: WorkerRequirements; workerSelection?: WorkerSelection; routing?: RoutingDecision; continuation?: Continuation | null; continuationDeliveredAt?: string | null; chatgptTabClosePolicy?: ChatGptTabClosePolicy; state: TaskState; attempt: number; maxAttempts: number;
  leaseOwner: string | null; leaseExpiresAt: string | null; executionId: string | null; threadId: string | null;
  threadDeletedAt?: string | null; threadCleanupError?: string | null;
  reviewHeadSha?: string;
  failureReason?: string;
  result: Result | null; plannerResult?: import('./planner.js').PlannerResult | null; error: string | null; timeoutMs: number; createdAt: string; updatedAt: string;
};
export type Job = { id: string; title: string; objective?: string; priority?: Priority; description?: string; executionMode: ExecutionMode; schedule?: JobSchedule; autoMerge?: boolean; reviewEnabled?: boolean; prNumber: number; repository: string; state: JobState; continuation: Continuation | null; review?: ReviewState; headSha?: string; initialPlanning?: { status: 'pending' | 'complete'; decisionId: string }; createdAt: string; updatedAt: string; tasks: Task[] };
export type Continuation = { kind: 'codex-thread' | 'command' | 'webhook'; target: string; input?: string };
export type EventRecord = { version: 1; event_id: string; job_id: string; task_id: string; parent_task_id: string | null; type: string; status: string; timestamp: string; visibility: string; level: string; message: string; source?: Record<string, unknown>; data?: Record<string, unknown> };

const jobTransitions: Record<JobState, JobState[]> = { OPEN: ['RUNNING', 'WAITING', 'BLOCKED', 'COMPLETED', 'CANCELLED'], RUNNING: ['OPEN', 'WAITING', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED'], WAITING: ['RUNNING', 'BLOCKED', 'COMPLETED', 'CANCELLED'], BLOCKED: ['RUNNING', 'COMPLETED', 'CANCELLED'], COMPLETED: ['RUNNING', 'CANCELLED'], FAILED: ['RUNNING', 'COMPLETED', 'CANCELLED'], CANCELLED: ['RUNNING', 'COMPLETED'] };
const taskTransitions: Record<TaskState, TaskState[]> = { QUEUED: ['READY', 'BLOCKED', 'CANCELLED'], READY: ['RUNNING', 'BLOCKED', 'FAILED', 'CANCELLED'], RUNNING: ['WAITING', 'BLOCKED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'READY'], WAITING: ['READY', 'BLOCKED', 'CANCELLED'], BLOCKED: ['READY', 'CANCELLED'], SUCCEEDED: [], FAILED: ['READY', 'RUNNING', 'CANCELLED'], CANCELLED: [] };
export function assertJobTransition(from: JobState, to: JobState): void { if (from !== to && !jobTransitions[from].includes(to)) throw new Error(`Invalid job transition ${from} -> ${to}`); }
export function assertTaskTransition(from: TaskState, to: TaskState): void { if (from !== to && !taskTransitions[from].includes(to)) throw new Error(`Invalid task transition ${from} -> ${to}`); }
