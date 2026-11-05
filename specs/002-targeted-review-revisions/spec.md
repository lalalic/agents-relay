# Targeted Final Review Revisions

## Goal
When an immutable-head Final Reviewer finds actionable defects, ask Relay to revise the responsible historical Task rather than dispatch one generic `review-fix-<sha>` Task. The original Task and its successful result remain immutable. Subsequent revision, dependency verification, and re-review have separate durable identities.

This feature is implemented by several Relay Tasks. This slice (Job 558 / Task 727) establishes Graph authority and the durable model, **not** the reviewer CLI, runtime continuation, full downstream scheduling, or end-to-end delivery.

## User scenarios

1. An active Final Reviewer names one or more responsible succeeded Tasks with stable finding IDs. Feedback is appended to each owner and a request is durably deduplicated across retries. There need not be an input/output filename.
2. A verdict of `changes-required` whose findings all have valid targeted requests selects targeted revision. It never also creates generic review-fix work.
3. If some findings lack an authorized owner, Relay preserves the verdict as `needs-ownership`. It does not guess a Task, merge, or invent success; an explicitly authorized re-plan can resolve ambiguous scope.
4. A fixed Task's dependent with `revalidate` policy verifies applicability against the newest upstream evidence; one with `rerun` policy repeats required checks. Legacy dependencies remain order-only.
5. A fresh exact-head Final Review is independently required after revisions. No approval can be reused for a different source head.

## Invariants

- V2 SQLite Job snapshot is the only operational truth. All mutation uses `RelayStore.mutateJob`'s `BEGIN IMMEDIATE` transaction. A transport receipt is not Task completion.
- Reviewer authorization requires an actively RUNNING Reviewer, matching execution ID, current immutable head, and same-Job SUCCEEDED original Task. A retried request ID must match the original payload exactly.
- A new Revision Task is a semantic child of the original, and has its own Task lifecycle/result. An original SUCCEEDED Task is never reopened or rewritten.
- All reviewer blocking findings must be covered by the targeted requests; partial coverage routes to `needs-ownership`. The verdict and review round are immutable evidence.
- Dependency edges determine execution order; `parentTaskId` carries ownership. New validity semantics are explicit on edges, never inferred from files.
- Worker and reviewer generations, heads, revision request IDs, and dependency revision vectors must fence stale/duplicate completions.
- Graph selects policies and actions; TypeScript actions only validate exact inputs, persist facts, and execute selected effects.

## Acceptance for this implementation slice

- Review Graph has mutually exclusive targeted and needs-ownership actions, with no generic fix action.
- Revision Graph authorizes current-head intake, queue gating, terminal facts, and stale-state handling.
- A typed backward-compatible SQLite snapshot model stores feedback, revision provenance, edge policies, and review-round linkage; initial/old Jobs require no migration rewrite.
- Atomic request intake records one original-Task comment per request, preserves prior result, and rejects stale or conflicting submissions.
- Isolated persistence/restart, Graph branch, concurrency/deduplication, dependency-vector, and review-verdict tests pass.
- Deferred work is explicitly described in [plan.md](plan.md); passing this slice does not imply the full Job objective is complete.

## Out of scope for this slice

The authenticated reviewer `task revise` CLI, worker thread/new-turn continuity, dependency DAG scheduling, stale running-task interruption, review-round orchestration, bounded no-progress recovery, Markcut UI adapter, and physical managed Job E2E are downstream tasks. Do not create a second procedural orchestrator to fill these gaps.
