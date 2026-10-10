# E2E-006 — Worker execution rejection and autonomous recovery

## Objective

Verify that Agents Relay handles a **Worker execution rejection**, classifies its cause, and autonomously recovers the **same original Task** using the correct strategy. Quota exhaustion is one possible cause, **not a mandatory cause**.

Representative rejection categories include:

- Provider quota or rate limit (`rate_limit_exceeded`, 429, usage exhaustion).
- Model unavailable, unsupported, retired or not found.
- Provider unavailable, temporarily failing or refusing requests (such as 503 or equivalent).
- Worker runtime rejects the selected route due to unavailable model/provider, unsupported capability or account eligibility.
- Other genuine, structured execution rejection with a defined retry, route exclusion or escalation policy.

For a controlled E2E injection, the Codex Adapter rejection must traverse the actual runtime settlement, watchdog, error classifier and Graph recovery pipeline. Clearly distinguish an injected failure from a real provider response. A Router expected-choice assertion or worker-authored fake `task.failed` alone does not count.

## E2E Job instruction

The Job Objective MUST tell the Planner to create **one implementation Task** with JSON field `"--test-injection":{"method":"worker.codex.launch","action":"return","execution":"skip","mock":"worker_quota"}` (or `model_not_found` / `provider_unavailable`) in `next_tasks`. Also specify `"workerRequirements":{"runtime":"codex","capabilities":["model","local_repo"]}`. Relay's internal injection module checks `E2E_REPO` against the Job repository, atomically consumes the Task option in SQLite **before execution**, and makes the Codex Adapter return a controlled nonzero worker execution result. On the next attempt, the option is absent and normal Codex execution resumes. No external injector, injected receipt, or Watcher knowledge of the option.

The controller must not alter globally shared Router FreeText Rules or other jobs. This is a **controlled Worker rejection**, not evidence of an actual provider outage.

## PASS — all are required

1. First-attempt Worker rejection observed through the regular Adapter execution failure path, with source evidence, error classification and matching original Task + execution identity.
2. Relay processes the failure through its normal Graph/runtime path, preserving the structured rejection reason (not treating a Worker-written `task.failed` as runtime rejection proof).
3. Relay applies the **appropriate recovery for the observed class**: refresh usage when quota-related, exclude/deprioritize invalid/unavailable route when relevant, select another viable route or an explicitly safe retry according to policy. No hard-coded provider choice.
4. The **exact same original Task ID** is reactivated and succeeds with a newer attempt/execution generation. No replacement business Task and no manual Task lifecycle actions.
5. Review, local merge, authoritative Job `COMPLETED`, and optional GitHub PR `MERGED` all succeed.
6. Watcher records the initial route, rejection receipt/error, retry/reroute or recovery evidence, original Task execution history, and final successful route. ChatGPT evaluates these against the round's chosen rejection class before PASS.

## Invalid outcomes

- Planner selects a viable route and the original Task simply succeeds on attempt one.
- The Worker merely *claims* quota/model/provider rejection in a Task event without an actual Adapter execution failure.
- Only Router expected choice is checked, without actual worker rejection.
- A rejection is observed but the original Task never recovers and the Job does not complete.
- Reviewer blocks due to missing recovery proof; this is evidence of an invalid round, not a PASS.
