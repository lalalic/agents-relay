import type { DependencyValidity } from './types.js';

export function validateDependencyValidity(
  dependencies: readonly string[],
  value: unknown,
  field = 'dependencyValidity',
): Record<string, DependencyValidity> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const allowed = new Set(dependencies);
  const result: Record<string, DependencyValidity> = {};
  for (const [taskId, policy] of Object.entries(value)) {
    if (!allowed.has(taskId)) throw new Error(`${field} key ${taskId} must identify a declared dependency`);
    if (policy !== 'order-only' && policy !== 'revalidate' && policy !== 'rerun') {
      throw new Error(`${field}[${taskId}] must be order-only, revalidate, or rerun`);
    }
    result[taskId] = policy;
  }
  return result;
}
