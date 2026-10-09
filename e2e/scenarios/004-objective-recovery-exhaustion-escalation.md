# E2E-004 — Recovery exhaustion / failed Troubleshooter

## Objective

Validate the bounded recovery-of-recovery policy without shared-runtime injection. The original implementation Task intentionally fails. Relay must automatically create exactly one Troubleshooter. That Troubleshooter intentionally publishes canonical `task.failed` instead of recovering the original Task. Relay must then record one durable `recovery.exhausted` fact and stop automatic recovery recursion.

## Deterministic protocol

The runner installs a workload-only worker gate and includes explicit failure instructions in the evidence consumed by the automatic Troubleshooter.

1. Original implementation attempt runs the Scenario 004 gate and publishes canonical `task.failed` with the exact test evidence.
2. Relay automatically creates one Troubleshooter for that original Task.
3. The Troubleshooter must inspect event history, recognize the Scenario 004 E2E marker, publish canonical `task.failed` with `E2E004_TROUBLESHOOTER_FAILURE`, and stop. It must not recover the original Task and must not invoke manual lifecycle actions.
4. Relay records exactly one durable `recovery.exhausted` fact linking the original Task and failed Troubleshooter.
5. No additional Troubleshooter, reviewer, review-fix, local merge, or Job completion may occur.

## PASS

- original implementation Task is `FAILED`
- exactly one Troubleshooter exists and is `FAILED`
- exactly one `recovery.exhausted` event/fact exists for that original/recovery pair
- Job lifecycle remains `ACTIVE`
- runtime status is `FAILED`
- no recursive Troubleshooter is created
- no review Task is created
- local merge is not successful
- no manual lifecycle intervention after bootstrap

## FAIL

- no Troubleshooter is created
- failed Troubleshooter causes another automatic Troubleshooter generation
- no durable recovery-exhaustion fact appears
- original Task is silently retried/replaced
- review or merge begins
- Job becomes `COMPLETED`
