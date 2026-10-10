# E2E-002 — Worker blocker recovered by Troubleshooter

## Objective

Prove that a worker blocker does not require human lifecycle intervention: Relay automatically creates a Troubleshooter, the Troubleshooter diagnoses and removes the blocker, the original worker Task resumes/retries successfully, and the Job finishes normally.

## Trigger

Inject one deterministic, recoverable worker blocker into the first implementation attempt. The trigger must be scoped to this E2E Job/Task and must not globally damage the worker runtime or other Jobs.

The blocker must be real enough that the original implementation Task reaches `FAILED` or `BLOCKED`; it must not simply be a diagnostic process-exit after success.

## Required recovery flow

```text
implementation attempt 1
  -> FAILED/BLOCKED with concrete blocker evidence
  -> troubleshooter.created
  -> Troubleshooter RUNNING
  -> blocker diagnosed and removed
  -> original implementation Task reactivated/retried
  -> implementation succeeds on a later attempt
  -> independent Review approves
  -> local Git merge succeeds
  -> Job COMPLETED
  -> if GitHub integration is enabled for this Job: PR CLOSED after main sync
```

## PASS

- the first implementation attempt genuinely fails/blocks
- Relay automatically creates exactly one relevant Troubleshooter recovery for that failed attempt
- Troubleshooter succeeds and records evidence of diagnosis/recovery
- the original implementation Task, not a replacement business Task, is retried/reactivated
- implementation later succeeds
- Job completes Review + local merge + durable `COMPLETED`
- no manual retry/reconcile/unblock/review/merge is used
- if GitHub integration is enabled for this Job, PR state is `MERGED`

## FAIL

- no real worker blocker occurs
- no Troubleshooter is created
- Troubleshooter fails to remove the blocker
- a human manually retries/unblocks/reconciles the Job
- a replacement implementation Task hides the failed original Task instead of recovering it
- the Job fails to reach `COMPLETED`
- enabled GitHub integration fails to converge to PR `CLOSED` after main sync

<!-- PLANNER-CONTRACT:START -->
## Mandatory Planner contract

Create the original implementation Task with the blocker check as its first action. Do not set `--test-injection`: the checked-in blocker fixture and automatic Troubleshooter protocol define this scenario.

The Planner must encode this in the **structured `next_tasks` response**. The worker must not create its own replacement Task or manufacture failure events. The E2E controller judges only runtime evidence.
<!-- PLANNER-CONTRACT:END -->
