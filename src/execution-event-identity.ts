import type { EventRecord } from './types.js';
export function executionEventSource(jobId: string, taskId: string, executionId: string): string { return `job/${jobId}/task/${taskId}/execution/${executionId}`; }
export function eventSourceId(event: EventRecord): string | undefined { return typeof event.source?.id === 'string' ? event.source.id : undefined; }
export function executionIdFromSource(sourceId: string | undefined, jobId: string, taskId: string): string | undefined {
  const prefix = `job/${jobId}/task/${taskId}/execution/`;
  return sourceId?.startsWith(prefix) ? sourceId.slice(prefix.length) || undefined : undefined;
}
const terminalExecutionClaims = new Set<string>();
export function claimTerminalExecution(sourceId: string): void {
  terminalExecutionClaims.add(sourceId);
  const cleanup = setTimeout(() => terminalExecutionClaims.delete(sourceId), 60000);
  cleanup.unref();
}
export function terminalExecutionClaimed(jobId: string, taskId: string, executionId: string): boolean {
  return terminalExecutionClaims.has(executionEventSource(jobId, taskId, executionId));
}
