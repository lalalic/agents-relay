import { AgentRegistration, Job, Task } from './types.js';
export const JOB_MARKER = 'agents-relay:job:v1';
export const TASK_MARKER = 'agents-relay:task:v1';
export const AGENT_MARKER = 'agents-relay:agent:v1';
export function marker(label: string, value: unknown): string { return `<!-- ${label} ${JSON.stringify(value).replace(/>/g, '\\u003e')} -->`; }
export function parseMarker<T>(body: string, label: string): T | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startMatch = body.match(new RegExp(`<!--\\s*${escaped}\\s+`));
  if (!startMatch || startMatch.index === undefined) return null;
  const payloadStart = startMatch.index + startMatch[0].length;
  let end = body.indexOf('-->', payloadStart);
  while (end !== -1) {
    const candidate = body.slice(payloadStart, end).trim();
    try { return JSON.parse(candidate) as T; } catch { end = body.indexOf('-->', end + 3); }
  }
  return null;
}
export function renderJobComment(job: Job): string {
  const objective = job.objective?.trim() || '_No objective recorded._';
  return `${marker(JOB_MARKER, { ...job, tasks: undefined })}
# Agents Relay job: ${job.title}

- **State:** ${job.state}
- **PR:** #${job.prNumber}

## Objective

${objective}`;
}
export function renderTaskComment(task: Task): string {
  const result = task.result?.summary?.trim() ? `

### Result

${task.result.summary.trim()}` : '';
  return `${marker(TASK_MARKER, task)}
## Task: ${task.id}

- **State:** ${task.state}
- **Priority:** ${task.priority ?? 'P2'}

### Work

${task.input}${result}`;
}
export function parseJob(body: string): Job | null {
  const job = parseMarker<Job>(body, JOB_MARKER);
  if (!job) return null;
  if (job.executionMode === undefined) return { ...job, executionMode: 'fixed' };
  if (job.executionMode !== 'fixed' && job.executionMode !== 'autonomous') return null;
  return job;
}
export function parseTask(body: string): Task | null {
  const task = parseMarker<Task>(body, TASK_MARKER);
  if (!task) return null;
  return { ...task, kind: task.kind === 'planner' ? 'planner' : 'work' };
}
export function renderAgentComment(agent: AgentRegistration): string { return `${marker(AGENT_MARKER, agent)}\n## Registered agent ${agent.name}\nRole: ${agent.role}\nAvailability: ${agent.availability}`; }
export function parseAgent(body: string): AgentRegistration | null { return parseMarker<AgentRegistration>(body, AGENT_MARKER); }
