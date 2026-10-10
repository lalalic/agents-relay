# E2E-006 — Worker execution rejection and autonomous recovery

## Objective

Verify that Agents Relay handles a **real Worker execution rejection**, classifies its cause, and autonomously recovers the **same original Task** using the correct strategy. Quota exhaustion is one possible cause, **not a mandatory cause**.

Representative rejection categories include:

- Provider quota or rate limit (`rate_limit_exceeded`, 429, usage exhaustion).
- Model unavailable, unsupported, retired or not found.
- Provider unavailable, temporarily failing or refusing requests (such as 503 or equivalent).
- Worker runtime rejects the selected route due to unavailable model/provider, unsupported capability or account eligibility.
- Other genuine, structured execution rejection with a defined retry, route exclusion or escalation policy.

An unsupported model can validate this scenario **only if the failure reaches the actual selected Worker/provider boundary** and Relay can recover to an eligible route. A Router expected-choice assertion or fabricated failure message alone does not count.

## Setup and injection

The controller selects **one** concrete rejection class for each round and records it beforehand, including the selected initial route, trigger mechanism, expected failure classification and expected recovery. Prefer isolated per-Job/per-execution routing constraints or fault injection; do not damage global provider quotas, disable unrelated routes or modify shared Router FreeText Rules for other Jobs. A real exhausted provider can also be used if independently verified. The initial selection must be verified, not merely requested in text.

## PASS — all are required

1. Real first-attempt rejection observed from the selected Worker/provider boundary, with source evidence, error classification and matching original Task + execution identity.
2. Relay processes the failure through its normal Graph/runtime path, preserving the structured rejection reason (not treating a synthetic controller receipt as provider proof).
3. Relay applies the **appropriate recovery for the observed class**: refresh usage when quota-related, exclude/deprioritize invalid/unavailable route when relevant, select another viable route or an explicitly safe retry according to policy. No hard-coded provider choice.
4. The **exact same original Task ID** is reactivated and succeeds with a newer attempt/execution generation. No replacement business Task and no manual Task lifecycle actions.
5. Review, local merge, authoritative Job `COMPLETED`, and optional GitHub PR `MERGED` all succeed.
6. Watcher records the initial route, rejection receipt/error, retry/reroute or recovery evidence, original Task execution history, and final successful route. ChatGPT evaluates these against the round's chosen rejection class before PASS.

## Invalid outcomes

- Planner selects a viable route and the original Task simply succeeds on attempt one.
- The controller only writes a receipt or asks the Worker to *claim* quota/model/provider rejection.
- Only Router expected choice is checked, without actual worker rejection.
- A rejection is observed but the original Task never recovers and the Job does not complete.
- Reviewer blocks due to missing recovery proof; this is evidence of an invalid round, not a PASS.
