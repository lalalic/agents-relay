# Durable model and semantic dependency contract

Records use the existing authoritative `job_snapshot.json` stored in the single SQLite Job database; no second mutable repository or separate review-side database is introduced. New fields are **optional** and backward compatible.

| Record | Location | Identity / semantics |
| --- | --- | --- |
| `ReviewRevisionRequest` | `Job.reviewRevisionRequests[]` | `requestId` is Job-scoped and stable; immutable (`reviewTaskId`, `reviewExecutionId`, `reviewHeadSha`, `originalTaskId`, `findings[]`, `createdAt`); monotone `status`, optional `revisionTaskId` and vector |
| `review.feedback` | `Task.comments[]` of original owner | Stable `review-revision/<requestId>` idempotency key; append-only; previous Task state and result remain immutable |
| `TaskRevision` | new child `Task.revision` | Separate Task with `kind`, `originalTaskId`, request IDs, bound review owner/head and optional dependency vector; `parentTaskId=originalTaskId` |
| `ReviewRevisionRound` | `Job.reviewRevisionRounds[]` | Immutable Reviewer execution/head/verdict and the request IDs it evaluated; optional next-review linkage |
| `ReviewRevisionDisposition` | `Job.review.revisionDisposition` | `targeted` or `needs-ownership` as selected by Review Graph |
| `DependencyValidity` | `Task.dependencyValidity[upstreamTaskId]` | `order-only` (default), `revalidate` (verify applicability against newest evidence), `rerun` (rerun required integration/test/security/release work) |
| `DependencyRevisionVector` | `Task.revision.dependencyVector` | Sorted map of validity-relevant upstream Task IDs to latest successful Task-ID/attempt evidence generation; order-only edges omitted |

The request status values are `requested`, `queued`, `running`, `verified`, `failed` and `stale`; the canonical revision Graph must authorize each transition. A request is not marked verified because its corresponding process exited, its event was transported, or its file changed. Underlying Task lifecycle remains unchanged.

### Fan-in example

Suppose D depends on A, B, C: A is `revalidate`, B is `rerun`, C is `order-only`. If original A and B are successful at attempt 1, D's validity vector is:

```json
{"A":"A:1","B":"B:1"}
```

After A's successful child revision `A-r1`, the vector becomes `{"A":"A-r1:1","B":"B:1"}`; changing C alone does not invalidate D. If B also completes a mandatory rerun, use its new successful evidence generation. A concurrent failed/pending revision of B must prevent D dispatch until resolved even if its old successful evidence remains readable. Downstream scheduling must group dependency revisions into one stable vector before dispatch and fail closed on a stale completion vector.

### Required data validation

- Request IDs are nonempty, at most 160 characters, and cannot be reused for changed feedback.
- Each finding has a nonempty unique ID and nonempty summary (up to 4,000 characters); the Reviewer verdict's blocking findings must all be covered by accepted feedback.
- The original owner must be SUCCEEDED, not Planner or Reviewer, and not a revision child. New revision children are separate historical results.
- The Reviewer must still be RUNNING on the exact execution and bound to the exact immutable current head at intake. No review-round inference from Task title alone.
- A dependent's `dependencyValidity` key must be a declared `dependencies[]` Task; invalid policy strings or missing Task IDs fail closed.
- Stale/older GitHub projections cannot remove locally accepted review request or round records.
