/** Classify genuine worker-process rejection text, regardless of E2E mode. */
export function classifyWorkerRejection(message: string): 'rate_limit_exceeded'|'model_not_found'|'provider_unavailable'|'worker_process_failed' {
  if (/rate[_ .-]?limit[_ .-]?exceeded|usage limit reached|quota[_ .-]?exceeded|insufficient[_ .-]?quota/i.test(message)) return 'rate_limit_exceeded';
  if (/model[_ .-]?not[_ .-]?found|model (?:is )?(?:unavailable|not found|unsupported)|unsupported model/i.test(message)) return 'model_not_found';
  if (/provider[_ .-]?unavailable|provider (?:is )?(?:unavailable|refused)|service unavailable/i.test(message)) return 'provider_unavailable';
  return 'worker_process_failed';
}
export const reroutableWorkerRejections = new Set(['rate_limit_exceeded','model_not_found','provider_unavailable']);
