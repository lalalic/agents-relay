/** Internal E2E worker-rejection fixture. Not a public CLI or production feature. */
import type {Execution} from './adapters.js';
export const supportedE2eInjections = ['quota_exceeded','model_not_found','provider_unavailable'] as const;
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
