/** Internal E2E worker-rejection fixture. Not a public CLI or production feature. */
import type {Execution} from './adapters.js';
export const supportedE2eInjections = ['quota_exceeded','model_not_found','provider_unavailable','github_projection_failure'] as const;
export type E2eInjection = typeof supportedE2eInjections[number];
export function allowedE2eInjection(repo: string, option: string | undefined, env = process.env): E2eInjection | undefined {
  if (!env.E2E_REPO || repo !== env.E2E_REPO || !option) return undefined;
  return supportedE2eInjections.includes(option as E2eInjection) ? option as E2eInjection : undefined;
}
export function injectedWorkerExecution(type: E2eInjection): Execution {
  const message = type === 'quota_exceeded' ? 'rate_limit_exceeded: usage limit reached' :
    type === 'model_not_found' ? 'model_not_found: model is unavailable' : 'provider_unavailable: provider refused the request';
  const error = new Error(message);
  const promise = Promise.reject(error);
  promise.catch(() => {});
  return {id:'e2e-injected', launched:Promise.resolve(), promise, cancel:()=>{},
    processExit:{exitCode:1,signal:null,stderr:message,terminationReason:null}};
}

/** E2E projection injection: consume a Task declaration atomically in SQLite before faulting. */
export async function consumeProjectionInjection(
  relay: import('./relay-store.js').RelayStore, repository: string, jobId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!env.E2E_REPO || repository !== env.E2E_REPO || !relay.mutateJob) return false;
  let consumed = false;
  await relay.mutateJob(jobId, job => {
    if (job.repository !== repository) return job;
    const task = job.tasks.find(t => t.testInjection === 'github_projection_failure');
    if (!task) return job;
    delete task.testInjection;
    task.updatedAt = new Date(Math.max(Date.now(),Date.parse(task.updatedAt)+1)).toISOString();
    consumed = true;
    return job;
  });
  if (consumed) {
    const stored = await relay.loadJob(jobId);
    if (stored?.tasks.some(t => t.testInjection === 'github_projection_failure'))
      throw Error(`E2E injection consumption not committed: ${jobId}`);
  }
  return consumed;
}

export async function injectProjectionFailure(relay: import('./relay-store.js').RelayStore, repository: string, jobId: string): Promise<void> {
  if (await consumeProjectionInjection(relay,repository,jobId))
    throw new Error(`E2E transient GitHub projection transport failure: ${jobId}`);
}
