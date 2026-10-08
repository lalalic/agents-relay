const executionBoundaryLocks = new Map<string, Promise<void>>();

/**
 * Serialize the durable execution-generation boundary across reconciler
 * instances in one relay process. Launch, routing, and terminal persistence
 * must not observe and write the same queued generation concurrently.
 */
export async function withExecutionBoundary<T>(jobId: string, taskId: string, work: () => Promise<T>): Promise<T> {
  const key = `${jobId}/${taskId}`;
  const previous = executionBoundaryLocks.get(key);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  executionBoundaryLocks.set(key, current);
  if (previous) await previous;
  try {
    return await work();
  } finally {
    release();
    if (executionBoundaryLocks.get(key) === current) executionBoundaryLocks.delete(key);
  }
}
