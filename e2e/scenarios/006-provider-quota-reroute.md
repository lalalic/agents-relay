# E2E-006 — Provider quota exhaustion and reroute

## Objective

Trigger a genuine structured quota/rate-limit failure for the selected provider without globally damaging other providers.

## PASS

- structured provider failure is preserved
- usage/routing facts refresh
- failed route is excluded or deprioritized according to policy
- original Task is recovered/rerouted to a viable provider
- no manual provider selection or replacement business Task
- Job completes normally after recovery

## Controller preflight / injection contract

Before creating a round, the controller requires `E2E_PROVIDER_QUOTA_INJECT_COMMAND` containing `{job}` or the exact Job ID. The command runs only when the implementation Task has an authoritative RUNNING execution. It must provoke a real, scoped provider transport quota rejection, not merely create a receipt or manufacture a worker error. A successful command records only an injection *attempt*; PASS still requires `task.failed` with `reason=rate_limit_exceeded`, `task.rerouting` with `previousFailure=rate_limit_exceeded`, same-Task retry, Job COMPLETED, and GitHub MERGED. Without a configured mechanism, preflight fails before Job creation.
