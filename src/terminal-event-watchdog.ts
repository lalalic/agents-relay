/**
 * Replace the overall worker deadline with a shorter post-exit deadline.
 * Execution outcomes remain owned by the authoritative task lifecycle graph.
 * Never extend the original overall timeout.
 */
export function rearmTerminalEventDeadline(
  timers: Map<string, NodeJS.Timeout>,
  taskId: string,
  overallRemainingMs: number,
  graceMs: number,
  expire: () => void,
): void {
  const existing = timers.get(taskId);
  if (existing) clearTimeout(existing);
  timers.set(taskId, setTimeout(expire, Math.max(1, Math.min(overallRemainingMs, graceMs))));
}
