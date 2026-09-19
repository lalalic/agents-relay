import { AgentRegistration, Job, Task } from './types.js';
export const JOB_MARKER = 'agents-relay:job:v1';
export const TASK_MARKER = 'agents-relay:task:v1';
export const AGENT_MARKER = 'agents-relay:agent:v1';
export function marker(label: string, value: unknown): string { return `<!-- ${label} ${JSON.stringify(value)} -->`; }
export function parseMarker<T>(body: string, label: string): T | null { const match = body.match(new RegExp(`<!--\\s*${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s+([\\s\\S]*?)\\s*-->`)); if (!match) return null; try { return JSON.parse(match[1]) as T; } catch { return null; } }
export function renderJobComment(job: Job): string { return `${marker(JOB_MARKER, { ...job, tasks: undefined })}\n# Agents Relay job: ${job.title}\nState: ${job.state}\nPR: #${job.prNumber}`; }
export function renderTaskComment(task: Task): string { return `${marker(TASK_MARKER, task)}\n## Task ${task.id}\nState: ${task.state}\n${task.result?.summary ?? task.input}`; }
export function parseJob(body: string): Job | null { return parseMarker<Job>(body, JOB_MARKER); }
export function parseTask(body: string): Task | null { return parseMarker<Task>(body, TASK_MARKER); }
export function renderAgentComment(agent: AgentRegistration): string { return `${marker(AGENT_MARKER, agent)}\n## Registered agent ${agent.name}\nRole: ${agent.role}\nAvailability: ${agent.availability}`; }
export function parseAgent(body: string): AgentRegistration | null { return parseMarker<AgentRegistration>(body, AGENT_MARKER); }
