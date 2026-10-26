/** Classify genuine worker-process rejection text. */
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

export type SafePreSubmissionFailure = Exclude<ChatGptPlatformFailureClassification,
  'adapter_failure' | 'transport_failure' | 'launch_failure' | 'start_ack_timeout' | 'outcome_unknown'>;

/** Constructed only from a platform response that explicitly says no submission occurred. */
export class PreSubmissionRejection extends Error {
  private constructor(readonly classification: SafePreSubmissionFailure, readonly platformEvidence: string) {
    super(platformEvidence);
    this.name = 'PreSubmissionRejection';
  }

  static fromPlatformResponse(response: unknown): PreSubmissionRejection | undefined {
    if (!response || typeof response !== 'object' || Array.isArray(response)) return undefined;
    const result = response as Record<string, unknown>;
    if (result.status !== 'rejected' || result.submitted !== false || typeof result.code !== 'string' || typeof result.message !== 'string') return undefined;
    const classifications: Record<string, SafePreSubmissionFailure> = {
      MODEL_UNAVAILABLE: 'model_unavailable',
      MODEL_NOT_FOUND: 'model_unavailable',
      MCP_LOGIN_REQUIRED: 'mcp_login_required',
      PROJECT_SETUP_UNAVAILABLE: 'project_setup_unavailable',
      BROWSER_WORKSPACE_UNAVAILABLE: 'browser_workspace_unavailable',
    };
    const classification = classifications[result.code];
    if (!classification) return undefined;
    const platformEvidence = JSON.stringify({ status: result.status, submitted: result.submitted, code: result.code, message: result.message });
    return new PreSubmissionRejection(classification, platformEvidence);
  }
}

/** Only positive pre-submission rejection evidence permits another route to launch. */
export function classifyChatGptPlatformFailure(
  error: unknown,
  phase: 'launch' | 'delivery' | 'start-ack',
): { classification: ChatGptPlatformFailureClassification; safeToReroute: boolean; evidence: string } {
  if (error instanceof PreSubmissionRejection) return {
    classification: error.classification,
    safeToReroute: true,
    evidence: error.platformEvidence,
  };
  const evidence = error instanceof Error ? error.message : String(error);
  if (phase === 'start-ack') return { classification: 'start_ack_timeout', safeToReroute: false, evidence };
  if (phase === 'launch') return { classification: 'launch_failure', safeToReroute: false, evidence };
  return { classification: 'outcome_unknown', safeToReroute: false, evidence };
}
