export type JobState = 'OPEN' | 'RUNNING' | 'WAITING' | 'BLOCKED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type TaskState = 'QUEUED' | 'READY' | 'RUNNING' | 'WAITING' | 'BLOCKED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type AdapterName = 'codex' | 'chatgpt' | 'orchestrator';
export type ExecutionMode = 'fixed' | 'autonomous';
export type TaskKind = 'work' | 'planner';
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
export type Result = { summary: string; artifacts?: string[]; data?: Record<string, unknown> };
export type TaskOutput = { kind: 'task_pr' } | { kind: 'file'; path: string };
export type Task = {
  jobId?: string; id: string; kind?: TaskKind; priority?: Priority; projectName?: string; agentName?: string; parentTaskId: string | null; dependencies: string[]; capabilities: string[]; adapter: AdapterName;
  input: string; output?: TaskOutput; routing?: RoutingDecision; continuation?: Continuation | null; continuationDeliveredAt?: string | null; state: TaskState; attempt: number; maxAttempts: number;
  leaseOwner: string | null; leaseExpiresAt: string | null; executionId: string | null; threadId: string | null;
  threadDeletedAt?: string | null; threadCleanupError?: string | null;
  result: Result | null; plannerResult?: import('./planner.js').PlannerResult | null; error: string | null; timeoutMs: number; createdAt: string; updatedAt: string;
};
export type Job = { id: string; title: string; objective?: string; priority?: Priority; description?: string; executionMode: ExecutionMode; prNumber: number; repository: string; state: JobState; continuation: Continuation | null; createdAt: string; updatedAt: string; tasks: Task[] };
export type Continuation = { kind: 'codex-thread' | 'command' | 'webhook'; target: string; input?: string };
export type EventRecord = { version: 1; event_id: string; job_id: string; task_id: string; parent_task_id: string | null; type: string; status: string; timestamp: string; visibility: string; level: string; message: string; source?: Record<string, unknown>; data?: Record<string, unknown> };

const jobTransitions: Record<JobState, JobState[]> = { OPEN: ['RUNNING', 'WAITING', 'BLOCKED', 'COMPLETED', 'CANCELLED'], RUNNING: ['OPEN', 'WAITING', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED'], WAITING: ['RUNNING', 'BLOCKED', 'COMPLETED', 'CANCELLED'], BLOCKED: ['RUNNING', 'CANCELLED'], COMPLETED: ['RUNNING', 'CANCELLED'], FAILED: ['RUNNING', 'CANCELLED'], CANCELLED: ['RUNNING'] };
const taskTransitions: Record<TaskState, TaskState[]> = { QUEUED: ['READY', 'BLOCKED', 'CANCELLED'], READY: ['RUNNING', 'BLOCKED', 'FAILED', 'CANCELLED'], RUNNING: ['WAITING', 'BLOCKED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'READY'], WAITING: ['READY', 'BLOCKED', 'CANCELLED'], BLOCKED: ['READY', 'CANCELLED'], SUCCEEDED: [], FAILED: ['READY', 'CANCELLED'], CANCELLED: [] };
export function assertJobTransition(from: JobState, to: JobState): void { if (from !== to && !jobTransitions[from].includes(to)) throw new Error(`Invalid job transition ${from} -> ${to}`); }
export function assertTaskTransition(from: TaskState, to: TaskState): void { if (from !== to && !taskTransitions[from].includes(to)) throw new Error(`Invalid task transition ${from} -> ${to}`); }
