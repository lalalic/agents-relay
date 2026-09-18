export type JobState = 'OPEN' | 'RUNNING' | 'WAITING' | 'BLOCKED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type TaskState = 'QUEUED' | 'READY' | 'RUNNING' | 'WAITING' | 'BLOCKED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type AdapterName = 'shell' | 'codex';
export type RoutingDecision = { provider: string; model: string; reasoning?: string; decidedBy: string; decidedAt: string };
export type Result = { summary: string; artifacts?: string[]; data?: Record<string, unknown> };
export type Task = {
  id: string; parentTaskId: string | null; dependencies: string[]; capabilities: string[]; adapter: AdapterName;
  input: string; routing?: RoutingDecision; state: TaskState; attempt: number; maxAttempts: number;
  leaseOwner: string | null; leaseExpiresAt: string | null; executionId: string | null; threadId: string | null;
  result: Result | null; error: string | null; timeoutMs: number; createdAt: string; updatedAt: string;
};
export type Job = { id: string; title: string; prNumber: number; repository: string; state: JobState; continuation: Continuation | null; createdAt: string; updatedAt: string; tasks: Task[] };
export type Continuation = { kind: 'codex-thread' | 'command' | 'webhook'; target: string; input?: string };
export type EventRecord = { version: 1; event_id: string; job_id: string; task_id: string; parent_task_id: string | null; type: string; status: string; timestamp: string; visibility: string; level: string; message: string; data?: Record<string, unknown> };

const jobTransitions: Record<JobState, JobState[]> = { OPEN: ['RUNNING', 'WAITING', 'BLOCKED', 'CANCELLED'], RUNNING: ['WAITING', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED'], WAITING: ['RUNNING', 'BLOCKED', 'CANCELLED'], BLOCKED: ['RUNNING', 'CANCELLED'], COMPLETED: [], FAILED: ['RUNNING', 'CANCELLED'], CANCELLED: [] };
const taskTransitions: Record<TaskState, TaskState[]> = { QUEUED: ['READY', 'BLOCKED', 'CANCELLED'], READY: ['RUNNING', 'BLOCKED', 'CANCELLED'], RUNNING: ['WAITING', 'BLOCKED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'READY'], WAITING: ['READY', 'BLOCKED', 'CANCELLED'], BLOCKED: ['READY', 'CANCELLED'], SUCCEEDED: [], FAILED: ['READY', 'CANCELLED'], CANCELLED: [] };
export function assertJobTransition(from: JobState, to: JobState): void { if (from !== to && !jobTransitions[from].includes(to)) throw new Error(`Invalid job transition ${from} -> ${to}`); }
export function assertTaskTransition(from: TaskState, to: TaskState): void { if (from !== to && !taskTransitions[from].includes(to)) throw new Error(`Invalid task transition ${from} -> ${to}`); }
