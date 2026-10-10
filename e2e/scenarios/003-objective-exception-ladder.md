# E2E-003 — Objective-driven exception ladder

## Objective

Exercise the largest safe set of Graph/lifecycle exception paths without damaging shared runtime: intentional first implementation failure, automatic Troubleshooter recovery of the exact original Task, two independent review rejections on successive immutable heads, two Graph-created fix generations, eventual approval, local merge, durable completion, and GitHub convergence.

## Deterministic protocol

The runner installs workload-only `.e2e/` markers and scripts on the fresh source branch.

1. Implementation attempt 1 runs `node scripts/e2e-003-check-worker-gate.mjs` before product work. Exit 42 requires canonical `task.failed`; the worker must not clear the marker.
2. The automatic Troubleshooter diagnoses the marker from event history/failure evidence, runs `node scripts/e2e-003-clear-worker-gate.mjs`, and recovers the exact original implementation Task through `task recover`.
3. Implementation attempt 2 verifies the gate is clear, performs the requested fixture/test change, runs tests, and succeeds.
4. Every final reviewer runs `node scripts/e2e-003-review-gate.mjs`:
   - stage 1: emit `review.changes_required` requiring `fixtures/e2e-003-review-fix-1.json`.
   - stage 2: emit `review.changes_required` requiring `fixtures/e2e-003-review-fix-2.json`.
   - stage 3: if the requested implementation and both review fixtures/tests are valid, emit `review.approved`.
5. Each review finding is fixed only by the Graph-created review fix Task. No manual review/retry/reconcile is allowed.

## Required flow

```text
original implementation attempt 1 -> FAILED
  -> Troubleshooter created -> SUCCEEDED
  -> exact original implementation attempt 2 -> SUCCEEDED
  -> Review #1 -> CHANGES_REQUIRED
  -> Graph review-fix #1 -> SUCCEEDED / new head
  -> Review #2 -> CHANGES_REQUIRED
  -> Graph review-fix #2 -> SUCCEEDED / new head
  -> Review #3 -> APPROVED
  -> local merge -> Job COMPLETED -> projected PR MERGED
```

## PASS

- genuine first-attempt `task.failed` evidence exists
- exactly one relevant Troubleshooter recovers that attempt
- the exact original implementation Task succeeds on attempt >= 2
- at least two distinct `review.changes_required` events occur on successive immutable heads
- two Graph-created `review-fix-*` Tasks succeed
- a later independent review approves the then-current head
- local merge succeeds and Job reaches durable `COMPLETED`
- GitHub PR reaches `MERGED` when integration is enabled
- no manual lifecycle intervention after bootstrap

## FAIL

- the worker skips the required first failure
- the implementation worker clears its own blocker
- recovery uses a replacement business Task instead of the exact original Task
- fewer than two reviewer rejection/fix generations occur
- reviewer approves before the stage-3 gate
- any intentional test failure is mistaken for a Relay defect by the controller
- Job stalls, falsely completes, or requires manual lifecycle intervention

<!-- PLANNER-CONTRACT:START -->
## Mandatory Planner contract

Create the original implementation Task with the worker gate as its first action. Keep the staged review gate protocol on review tasks. Do not set `--test-injection`: this scenario uses the scripted failure/review ladder.

The Planner must encode this in the **structured `next_tasks` response**. The worker must not create its own replacement Task or manufacture failure events. The E2E controller judges only runtime evidence.
<!-- PLANNER-CONTRACT:END -->
