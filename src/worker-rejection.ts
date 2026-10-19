/** Classify genuine worker-process rejection text, regardless of E2E mode. */
export function classifyWorkerRejection(message: string): 'rate_limit_exceeded'|'model_not_found'|'provider_unavailable'|'worker_process_failed' {
  if (/rate[_ .-]?limit[_ .-]?exceeded|usage limit reached|quota[_ .-]?exceeded|insufficient[_ .-]?quota/i.test(message)) return 'rate_limit_exceeded';
  if (/model[_ .-]?not[_ .-]?found|model (?:is )?(?:unavailable|not found|unsupported)|unsupported model/i.test(message)) return 'model_not_found';
  if (/provider[_ .-]?unavailable|provider (?:is )?(?:unavailable|refused)|service unavailable/i.test(message)) return 'provider_unavailable';
  return 'worker_process_failed';
}
export const reroutableWorkerRejections = new Set(['rate_limit_exceeded','model_not_found','provider_unavailable']);

export type ChatGptPlatformFailureClassification =
  | 'adapter_failure' | 'transport_failure' | 'launch_failure' | 'start_ack_timeout'
  | 'browser_workspace_unavailable' | 'mcp_login_required' | 'project_setup_unavailable'
  | 'model_unavailable' | 'outcome_unknown';

/** Only positive pre-submission rejection evidence permits another route to launch. */
export function classifyChatGptPlatformFailure(
  message: string,
  phase: 'launch' | 'delivery' | 'start-ack',
): { classification: ChatGptPlatformFailureClassification; safeToReroute: boolean } | undefined {
  if (/model[_ .-]?(?:not[_ .-]?found|unavailable)|model [^\n:]{0,60}(?:not available|unsupported|unavailable)|unsupported model/i.test(message))
    return { classification: 'model_unavailable', safeToReroute: true };
  if (/login required|sign[ -]?in required|not authenticated|authentication required|session expired|MCP app.{0,40}disconnected|MCP.{0,30}connected=false/i.test(message))
    return { classification: 'mcp_login_required', safeToReroute: true };
  if (/project(?:\s+setup|\s+name field|\s+not found|\s+unavailable)|project_id.{0,30}(?:missing|unavailable)/i.test(message))
    return { classification: 'project_setup_unavailable', safeToReroute: true };
  if (/BROWSER_WORKSPACE_UNAVAILABLE|browser-workspace runtime dependency unavailable|browser-workspace session start returned no session_id|admin helper|browser-workspace exited/i.test(message))
    return { classification: 'browser_workspace_unavailable', safeToReroute: true };
  if (phase === 'start-ack') return { classification: 'start_ack_timeout', safeToReroute: false };
  if (/adapter|worker launch|requires routing metadata/i.test(message))
    return { classification: 'adapter_failure', safeToReroute: false };
  if (/socket|ECONN|network|transport|connection reset|timed out|timeout/i.test(message))
    return { classification: 'transport_failure', safeToReroute: false };
  if (phase === 'launch') return { classification: 'launch_failure', safeToReroute: false };
  return undefined;
}
