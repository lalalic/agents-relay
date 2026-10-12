import type { Job, Task } from './types.js';
import { agentContractPrompt, executionContextPrompt, type ExecutionContext } from './execution-context.js';
import { agentGraphPrompt } from './agent-graph.js';
import { createReviewChairExecutionPlan } from './review-chair.js';
import { taskTagWorkerPrompt } from './task-tag.js';
import { executionEventSource } from './reconciler-runtime.js';

export async function managedWorkerInput(job: Job, task: Task, context?: ExecutionContext): Promise<string> {
  const isLocalJob = Boolean(job.localMerge?.sourceRef);
  const projectedReview = isLocalJob && task.agentName === 'reviewer' && job.prNumber > 0;
  if (!['codex', 'chatgpt'].includes(task.adapter) || !job.repository) return task.input;
  const selectedAgent = task.agentName && context ? await agentContractPrompt(context, task.agentName) : '';
  const selectedGraph = task.agentGraph && context ? await agentGraphPrompt(context, task.agentGraph) : '';
  const chairPlan = task.review?.role === 'chair' && context
    ? createReviewChairExecutionPlan(context.agents, task.review.target)
    : null;
  if (!task.output) throw new Error(`Task ${task.id} requires an explicit output contract`);
  if (!task.executionId) throw new Error(`Task ${task.id} requires an executionId before worker input is built`);
  const sourceId = executionEventSource(job.id, task.id, task.executionId);
  const prUrl = job.prNumber > 0 ? `https://github.com/${job.repository}/pull/${job.prNumber}` : null;
  const taskUrl = task.taskUrl ?? (isLocalJob ? `local:${job.id}/task/${task.id}` : `${prUrl}#issuecomment-${task.id}`);
  const output = task.output.kind === 'file'
    ? `file\nPath: ${task.output.path}`
    : (projectedReview ? `task/PR\nProjected PR: ${prUrl}\nTask: ${task.id}` : isLocalJob ? `task/PR\nTask: ${task.id}` : `task/PR\nPR: ${prUrl}\nTask: ${task.id}`);
  const interactiveContext = task.interactiveInvocation && task.interactiveInvocation.status !== 'awaiting_decision'
    ? '[Durable interactive review continuation]\n' +
      JSON.stringify({
        invocationId: task.interactiveInvocation.invocationId,
        revision: task.interactiveInvocation.revision,
        decision: task.interactiveInvocation.status,
        feedback: task.interactiveInvocation.feedback ?? null,
      }) + '\nContinue this same Task. For changes_requested, revise the artifact and request review of a NEW immutable revision; for approved, finalize only that approved revision. Never invent a human approval.\n'
    : '';
  const taskTag = taskTagWorkerPrompt(job); return `[Agents Relay managed task]
${projectedReview ? `Job: local ${job.id} (lifecycle authority)\nProjected GitHub PR: ${prUrl}` : isLocalJob ? `Job: local ${job.id}` : `Job URL: ${prUrl}`}
Job ID: ${job.id}
Task URL: ${taskUrl}
Task ID: ${task.id}
Project: ${task.projectName ?? context?.project.name ?? 'unspecified'}
${projectedReview
  ? `The local SQLite Job is the lifecycle authority. The projected GitHub PR exists only for artifact/head verification. Review the projected PR at ${prUrl} and verify its exact immutable head against the durable review task input below. Do not use GitHub comments or PR metadata as lifecycle authority.\n\n${task.input}`
  : isLocalJob
    ? `Treat the following durable task input as the authoritative work contract; do not query GitHub.\n\n${task.input}`
    : `Retrieve the durable job and task from GitHub before doing the work. Use whatever GitHub access this environment provides: the URLs, a GitHub integration/tool, or GitHub CLI/API. GitHub is the source of truth for task intent and declared output.`}
\n[Authoritative execution context]
Job objective: ${job.objective ?? '(none recorded)'}
Plan: ${task.planningDecisionId ? `${task.planningDecisionId} (round ${task.planningRound ?? 'unknown'})` : 'directly created Task'}
${interactiveContext}Task attempt/execution: ${task.attempt}/${task.maxAttempts} / ${task.executionId}
Dependencies: ${task.dependencies.length ? task.dependencies.join(', ') : 'none'}
${task.attempt > 1 || task.error ? `Retry summary: prior error=${task.error ?? 'none'}; prior generations=${(task.executionHistory ?? []).map(item => `${item.id}@${item.attempt}`).join(', ') || 'none'}` : 'Retry summary: first attempt'}
SQLite/RelayStore and the canonical Mermaid Graphs own lifecycle, merge, recovery, and completion decisions. Do not perform Relay-owned merge or completion actions from this worker.
${context ? executionContextPrompt(context) + '\n\n' : ''}${selectedAgent ? selectedAgent + '\n\n' : ''}${selectedGraph ? selectedGraph + '\n\n' : ''}${chairPlan ? `[Review Chair execution plan]\n${JSON.stringify(chairPlan, null, 2)}\n\nUse this runtime-discovered panel to create sibling durable specialist Tasks. Preserve each specialistTasks entry as review metadata, keep the target immutable, and synthesize structured results with synthesizeReview semantics before returning the unified revision plan.\n\n` : ''}Follow the resolved project instructions and Agents Relay/events-bus worker contracts.
[Output contract]
${output}
${taskTag}[Execution event contract — mandatory]
Use the canonical Neo events-bus with exactly Job ${job.id} and Task ${task.id}.
Your exact event source identity is: ${sourceId}
Every lifecycle event for this execution MUST set source.id to that exact string. Do not derive, rename, or replace it.
Follow the events-bus skill/protocol. For sandboxed Codex or hosted ChatGPT,
publish through the federated MCP tool events__publish; do not open NATS directly.
For a direct non-sandbox local worker, use NEO_EVENTS_EMIT when the caller provides it.
As your FIRST execution action, before reading files, editing code, running commands, or doing other work,
you MUST publish exactly one canonical task.started event for this exact Job/Task.

${task.adapter === 'chatgpt' ? `Because ChatGPT execution continues asynchronously after the submit process exits, you MUST keep reporting liveness while the task is active. Publish meaningful progress/milestone events when there is real progress to report. If no meaningful milestone has been published for 30 seconds during active work, publish a non-terminal task.heartbeat event with status running, visibility orchestrator, this exact source.id, and a concise description of the current operation. Continue heartbeats after each further 30 seconds of active silence until a terminal task event is published. Do not invent percentage progress.` : `You MAY publish progress events while working. For long silent active work, follow the events-bus heartbeat policy.`}
Before returning or allowing the worker process to exit, you MUST publish exactly one canonical terminal event:
- task.completed only after the declared output is durable;
- task.failed for implementation, tool, command, test, patch, commit, push, runtime, or other execution failure that prevents completion;
- task.blocked only when genuine human/external action is required;
- task.cancelled only when execution was cancelled.

If any execution step fails and you cannot continue, publish task.failed with the concrete reason BEFORE exiting.
Never exit after task.started without publishing exactly one terminal task event.
Do not publish duplicate terminal task events.
The worker owns task.started and task terminal events. Relay-owned task.process.launched, task.process.exited,
and task.process.async_exited are process lifecycle only and NEVER replace the worker task lifecycle.
The ChatGPT/Codex conversation or process exit is never the task result.

[Final event gate]
Before your final return, verify that a terminal event for this exact Job/Task was published.
If no terminal event has been published, publish task.failed before exiting.`;
}
