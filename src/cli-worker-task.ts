import type { Job, Task, AdapterName, RoutingDecision } from './types.js';
import { taskOverallTimeoutMs } from './types.js';
import { arg, hasArg, textOption, integerArg, chatGptTabClosePolicy, storySize, priority, continuation } from './cli-support.js';
import { parseAgentGraph } from './agent-graph.js';
import { createTaskEntity } from './workflow/entity-creation.js';
export async function workerTaskFromArgs(job: Job, args: string[], now: string): Promise<Task> {
  const model = arg(args, '--model');
  const adapterValue = arg(args, '--adapter');
  const adapter = (adapterValue || 'codex') as AdapterName;
  const outputKind = arg(args, '--output');
  const outputPath = arg(args, '--output-path');
  const input = await textOption(args, '--input', '--input-file');
  const agentGraph = hasArg(args, '--agent-graph') || hasArg(args, '--agent-graph-file') ? await textOption(args, '--agent-graph', '--agent-graph-file') : undefined;
  if (agentGraph) parseAgentGraph(agentGraph);
  if (!input.trim()) throw new Error('task create requires --input-file PATH|- or --input MARKDOWN');
  if (!['codex', 'chatgpt'].includes(adapter)) throw new Error('task create --adapter must be codex or chatgpt; orchestrator is reserved for legacy recovery only');
  if (outputKind !== 'task-pr' && outputKind !== 'file') throw new Error('task create requires --output task-pr|file'); if (outputKind === 'file' && !outputPath) throw new Error('--output file requires --output-path');
  if (['--provider','--profile','--reasoning','--cwd','--chatgpt-project'].some(flag => hasArg(args, flag)) && !model) throw new Error('task create explicit routing requires --model');
  const routing: RoutingDecision | undefined = !model ? undefined : { provider: arg(args, '--provider', 'openai'), model, profile: arg(args, '--profile') || undefined, reasoning: arg(args, '--reasoning') || undefined, cwd: arg(args, '--cwd') || undefined, projectId: arg(args, '--chatgpt-project') || undefined, decidedBy: 'cli', decidedAt: now };
  const workerRequirements = routing ? undefined : { capabilities: [], runtime: adapterValue ? adapter : undefined };
  const closePolicy = hasArg(args, '--chatgpt-tab-close-policy') ? chatGptTabClosePolicy(args) : undefined;
  const size = storySize(args);
  const dependencies = arg(args, '--deps').split(',').filter(Boolean);
  const timeoutMs = hasArg(args, '--timeout') ? integerArg(args, '--timeout', taskOverallTimeoutMs(size, routing?.reasoning)) : routing ? taskOverallTimeoutMs(size, routing.reasoning) : 0;
  return createTaskEntity(job, {
    jobId: job.id,
    id: arg(args, '--task-id', 'initial'),
    priority: priority(args, job.priority ?? 'P2'),
    storySize: size,
    projectName: arg(args, '--project') || undefined,
    agentName: arg(args, '--agent') || undefined,
    agentGraph,
    parentTaskId: arg(args, '--parent') || null,
    dependencies,
    capabilities: arg(args, '--capabilities').split(',').filter(Boolean),
    workerRequirements,
    adapter,
    chatgptTabClosePolicy: closePolicy,
    input: input || 'true',
    attachments: arg(args, '--attachments').split(',').filter(Boolean),
    output: outputKind === 'file' ? { kind: 'file', path: outputPath } : { kind: 'task_pr' },
    routing,
    continuation: continuation(args),
    continuationDeliveredAt: null,
    attempt: 0,
    maxAttempts: Number(arg(args, '--max-attempts', '3')),
    leaseOwner: null,
    leaseExpiresAt: null,
    executionId: null,
    threadId: null,
    result: null,
    error: null,
    timeoutMs,
    createdAt: now,
    updatedAt: now
  }, { defer: hasArg(args, '--draft') });
}
