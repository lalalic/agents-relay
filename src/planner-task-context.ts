import type { Task } from './types.js';

function boundedText(value: string | null | undefined, max = 4000): string | null | undefined {
  if (value === null || value === undefined || value.length <= max) return value;
  return value.slice(0, max) + `\n...[truncated ${value.length - max} chars]`;
}

export function plannerTaskContext(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    kind: task.kind ?? 'work',
    parent_task_id: task.parentTaskId,
    dependencies: task.dependencies,
    state: task.state,
    failure_reason: task.failureReason,
    input: task.kind === 'planner' ? undefined : boundedText(task.input),
    result_summary: boundedText(task.result?.summary),
    result_evidence: task.result?.data ? boundedText(JSON.stringify(task.result.data), 2000) : undefined,
    execution_history: task.executionHistory?.map(item => ({ id: item.id, attempt: item.attempt, started_at: item.startedAt })),
    platform_failure: task.platformFailure ? { classification: task.platformFailure.classification, evidence: boundedText(task.platformFailure.evidence), safe_to_reroute: task.platformFailure.safeToReroute } : undefined,
    comments: task.comments?.slice(-10).map(comment => ({ author: comment.author, text: boundedText(comment.text, 1000), created_at: comment.createdAt })),
    resolution_classification: task.resolutionClassification,
    error: boundedText(task.error, 2000),
    blocked_baseline: task.blockedBaseline,
    unblock: task.unblock,
  };
}
