import { AgentRegistration, Job, Plan, Task } from './types.js';
export const JOB_MARKER = 'agents-relay:job:v1';
export const TASK_MARKER = 'agents-relay:task:v1';
export const PLAN_MARKER = 'agents-relay:plan:v1';
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
const JOB_OBJECTIVE_END = '<!-- agents-relay:objective:end -->';
const TASK_INPUT_END = '<!-- agents-relay:task-input:end -->';

function contentBeforeDelimiter(body: string, heading: string, end: string): string | undefined {
  const startAt = body.indexOf(heading);
  if (startAt < 0) return undefined;
  const contentStart = startAt + heading.length;
  const endAt = body.indexOf(`\n${end}`, contentStart);
  if (endAt < 0) return undefined;
  return body.slice(contentStart, endAt);
}

function jobMetadata(job: Job): Omit<Job, 'objective' | 'description' | 'tasks' | 'plans'> {
  const { objective: _objective, description: _description, tasks: _tasks, plans: _plans, ...metadata } = job;
  return metadata;
}

export function renderJobBody(job: Job): string {
  const objective = job.objective?.trim() || '_No objective recorded._';
  return `${marker(JOB_MARKER, jobMetadata(job))}
${objective}`;
}

export function renderJobComment(job: Job): string {
  const objective = job.objective?.trim() || '_No objective recorded._';
  return `${marker(JOB_MARKER, jobMetadata(job))}
# Agents Relay job: ${job.title}

- **State:** ${job.state}
- **PR:** #${job.prNumber}

## Objective

${objective}
${JOB_OBJECTIVE_END}`;
}
export function renderTaskComment(task: Task): string {
  const result = task.result?.summary?.trim() ? `\n\n### Result\n\n${task.result.summary.trim()}` : '';
  const graph = task.agentGraph?.trim() ? `\n\n### Agent graph\n\n\`\`\`mermaid\n${task.agentGraph.trim()}\n\`\`\`` : '';
  const { input: _input, ...metadata } = task;
  return `${marker(TASK_MARKER, metadata)}
## Task: ${task.id}

- **State:** ${task.state}
- **Priority:** ${task.priority ?? 'P2'}
${graph}

### Work

${task.input}
${TASK_INPUT_END}${result}`;
}
function markdownSection(body: string, heading: string): string | undefined {
  const start = body.indexOf(heading);
  if (start < 0) return undefined;
  return body.slice(start + heading.length).trim();
}
export function parseJob(body: string): Job | null {
  const job = parseMarker<Job>(body, JOB_MARKER);
  if (!job) return null;
  const markerEnd = body.indexOf('-->');
  const bodyObjective = markerEnd >= 0 ? body.slice(markerEnd + 3).trim() || undefined : undefined;
  const objective = job.objective ?? job.description ?? contentBeforeDelimiter(body, '\n## Objective\n\n', JOB_OBJECTIVE_END) ?? markdownSection(body, '\n## Objective\n') ?? bodyObjective;
  const parsed = { ...job, objective };
  if (parsed.executionMode === undefined) return { ...parsed, executionMode: 'fixed' };
  if (parsed.executionMode !== 'fixed' && parsed.executionMode !== 'autonomous') return null;
  return parsed;
}
export function parseTask(body: string): Task | null {
  const task = parseMarker<Task>(body, TASK_MARKER);
  if (!task) return null;
  let input: string | undefined = task.input ?? contentBeforeDelimiter(body, '\n### Work\n\n', TASK_INPUT_END);
  if (input === undefined) {
    const work = markdownSection(body, '\n### Work\n');
    const suffix = task.result?.summary?.trim() ? `\n\n### Result\n\n${task.result.summary.trim()}`.trim() : undefined;
    input = work && suffix && work.endsWith(suffix) ? work.slice(0, -suffix.length).trimEnd() : work;
  }
  if (input === undefined) return null;
  return { ...task, input, kind: task.kind === 'planner' ? 'planner' : 'work' };
}

export function renderPlanComment(plan: Plan): string {
  const { planUrl: _planUrl, ...metadata } = plan;
  const triggerLines = [
    `- **State:** ${plan.status}`,
    `- **Source:** ${plan.trigger.source}`,
    plan.trigger.taskIds?.length ? `- **Triggered tasks:** ${plan.trigger.taskIds.join(', ')}` : '',
    plan.trigger.reason ? `- **Reason:** ${plan.trigger.reason}` : '',
    plan.trigger.blockedHeadShas?.length ? `- **Blocked head(s):** ${plan.trigger.blockedHeadShas.join(', ')}` : '',
    plan.trigger.currentHeadSha ? `- **Current head:** ${plan.trigger.currentHeadSha}` : '',
  ].filter(Boolean).join('\n');
  const generated = plan.generatedTaskIds.length ? plan.generatedTaskIds.map(id => `- ${id}`).join('\n') : '- _No tasks generated._';
  const facts = plan.trigger.facts?.length ? `\n\n### Change facts\n\n${plan.trigger.facts.map(fact => `- ${fact}`).join('\n')}` : '';
  return `${marker(PLAN_MARKER, metadata)}\n## Plan ${plan.round}: ${plan.id}\n\n${triggerLines}${facts}\n\n### Assessment\n\n${plan.assessment}\n\n### Generated tasks\n\n${generated}`;
}
export function parsePlan(body: string): Plan | null {
  const plan = parseMarker<Plan>(body, PLAN_MARKER);
  if (!plan || typeof plan.jobId !== 'string' || typeof plan.id !== 'string' || !Number.isInteger(plan.round)) return null;
  return plan;
}

export function renderAgentComment(agent: AgentRegistration): string { return `${marker(AGENT_MARKER, agent)}\n## Registered agent ${agent.name}\nRole: ${agent.role}\nAvailability: ${agent.availability}`; }
export function parseAgent(body: string): AgentRegistration | null { return parseMarker<AgentRegistration>(body, AGENT_MARKER); }
