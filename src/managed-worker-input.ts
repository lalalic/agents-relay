import { buildAgentPrompt, buildRelayWorkPrompt, renderAgentPrompt, type PromptAdapter } from './agent-prompt-builder.js';
import type { Job, Task } from './types.js';
import { resolveAgentContract, type ExecutionContext } from './execution-context.js';

import { executionEventSource } from './reconciler-runtime.js';

/**
 * Shared entry point for every managed Agent. Runtime Task intent lives in SQLite;
 * the adapter receives execution identity and an immutable Agent reference only.
 * No GitHub/PR discovery or dynamic skill/agent inventory enters the prompt.
 */
export async function managedWorkerInput(job: Job, task: Task, context?: ExecutionContext, mode: 'production' | 'evaluation' = 'production'): Promise<string> {
  if (!['codex', 'chatgpt', 'z'].includes(task.adapter) || !job.repository) return task.input;
  const adapter = task.adapter as PromptAdapter;
  if (!task.output) throw new Error(`Task ${task.id} requires an explicit output contract`);
  if (!task.executionId) throw new Error(`Task ${task.id} requires an executionId before worker input is built`);
  if (!context) throw new Error(`Task ${task.id} requires resolved execution context`);
  const agentName = task.agentName ?? 'implementation';
  const selected = await resolveAgentContract(context,agentName);
  const agent = selected.definition;
  const role = agentName === 'planner' || agentName === 'reviewer' || agentName === 'troubleshooter' ? agentName : 'worker';
  if (mode === 'evaluation') {
    const safeAgent = agent.replace(/^.*(?:task\.started|task\.completed|task\.failed|events__publish|NEO_EVENTS_EMIT).*\n?/gm, '');
    return renderAgentPrompt(buildAgentPrompt({ role, system: [safeAgent, '[Read-only evaluation safety boundary]\nDo not use tools, files, events or external services. Evaluate the role instructions as criteria only.'].filter(Boolean).join('\n\n'), user: `[Isolated prompt evaluation mode]\nTask: ${task.id}\n${task.input}` }), adapter);
  }
  return buildRelayWorkPrompt({
    agentName,
    agentContent:agent,
    adapter,
    contracts: [
      '/Users/chengli/Workspace/neo/skills/events-bus/references/protocol.md',
      '/Users/chengli/Workspace/agents-relay/skills/agents-relay/contracts/task-job-contract.md',
      '/Users/chengli/Workspace/agents-relay/skills/agents-relay/contracts/event-contract.md',
    ],
    contexts:context.instructions,
    skillPath:'/Users/chengli/Workspace/agents-relay/skills/agents-relay/SKILL.md',
    jobId:job.id,
    taskId:task.id,
    executionId:task.executionId,
  });
}
