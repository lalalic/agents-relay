import { isFinalReviewAgent } from './final-review-role.js';
import { buildAgentPrompt, buildRelayWorkPrompt, renderAgentPrompt, type PromptAdapter } from './agent-prompt-builder.js';
import type { Job, Task } from './types.js';
import { resolveAgentContract, type ExecutionContext } from './execution-context.js';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (mode === 'production') {
    const requiredRuntime = task.workerRequirements?.runtime ?? selected.agent.runtime;
    if (requiredRuntime && requiredRuntime !== adapter)
      throw new Error(`Agent ${agentName} requires ${requiredRuntime} runtime; ${adapter} cannot launch this Task`);
  }
  const agent = selected.definition;
  const role = isFinalReviewAgent(agentName) ? 'reviewer' : agentName === 'planner' || agentName === 'troubleshooter' ? agentName : 'worker';
  if (mode === 'evaluation') {
    const safeAgent = agent.replace(/^.*(?:task\.started|task\.completed|task\.failed|events__publish|NEO_EVENTS_EMIT).*\n?/gm, '');
    return renderAgentPrompt(buildAgentPrompt({ role, system: [safeAgent, '[Read-only evaluation safety boundary]\nDo not use tools, files, events or external services. Evaluate the role instructions as criteria only.'].filter(Boolean).join('\n\n'), user: `[Isolated prompt evaluation mode]\nTask: ${task.id}\n${task.input}` }), adapter);
  }
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  if (!context.project.neoRoot) throw new Error('Neo events-bus root is unavailable for Relay worker');
  return buildRelayWorkPrompt({
    agentName,
    agentContent:agent,
    adapter,
    contracts: [
      join(context.project.neoRoot, 'skills/events-bus/references/protocol.md'),
      join(packageRoot, 'skills/agents-relay/contracts/task-job-contract.md'),
      join(packageRoot, 'skills/agents-relay/contracts/event-contract.md'),
      ...(role === 'worker' && !task.review && task.agentName !== 'review-chair'
        ? [join(packageRoot, 'skills/agents-relay/contracts/worker-self-review.md')] : []),
    ],
    // Codex loads project AGENTS from cwd. Web workers do not: give them only
    // the current project policy; parent Neo rules are linked from that file.
    contexts:adapter === 'codex' ? [] : context.instructions.filter(item =>
      item.source === 'project' && item.path.endsWith('/AGENTS.md')),
    projectPath:context.project.path,
    skillPath:join(packageRoot, 'skills/agents-relay/SKILL.md'),
    jobId:job.id,
    taskId:task.id,
    executionId:task.executionId,
  });
}
