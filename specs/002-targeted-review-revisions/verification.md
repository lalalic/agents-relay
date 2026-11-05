# Task 727 verification and review receipt

This receipt is limited to **Graph and durable-model foundation**. The Job's end-to-end objective remains owned by the subsequent consolidated Implementation Task and independent Job acceptance review.

## Verified

| Gate | Evidence | Result |
| --- | --- | --- |
| Build | `npm run build` | PASS |
| L1 branch inventory / runtime binding | `npm run test:verification:l1` | PASS (52/52) |
| Revision intake, atomicity, generations, malicious inbound projection and dependency vector | `test/revision-model.test.js` | PASS (6/6) |
| Existing Reviewer/Graph regression integration | `test/core.test.js`, `test/review-workflow-v2.test.js` | PASS |
| Production unit regression | `npm run test:full` first stage | PASS |
| SQLite/event/Graph replay and recovery | `npm run test:verification:l3` | PASS; one pre-existing test is skipped |
| Source size and whitespace | `test/source-size.test.js`; `git diff --check` | PASS |

The L3 replay explicitly mocks **revision child materialization**, using the real intake reducer and canonical authorization Graph. It verifies downstream existing Reviewer/merge machinery only after this mocked boundary. This is **not evidence** that the future authenticated CLI or dependency scheduler is implemented.

## Self-review cycle

1. **Architecture and policy:** Reviewed existing Review Graph, Task Graph, SQLite mutation, review SHA fence, and contract. Replaced generic fix creation with exclusive targeted vs needs-ownership actions. Verified a malformed/partial-owner finding cannot silently select targeted work.
2. **Authority and restart:** Reviewed legacy GitHub projection and concurrent intake. Corrected a finding where a newer inbound projection could inject new review-request/approval-round objects. Preserved only local authoritative SQLite history; verified duplicate requests, restart, rollback, and hostile projection.
3. **Dependency and verification:** Corrected revision vector selection to use stable created-at provenance rather than Job Task-array order; added fan-in and restart checks. Updated historical L3 fixtures to use an explicit simulated revision action rather than asserting production auto-fix. L1 and full regression were re-run to a clean result.

## NOT_RUN / remaining responsibility

- **L2:** Physical original worker thread/session reuse and role/provider acceptance.
- **L4:** Full prompt/new-turn adapter contract and live provider feedback.
- **Managed Job E2E:** Real Reviewer CLI → original-task revision → semantic downstream revalidation → fresh Final Review → approved current-head delivery.
- **Runtime:** This Task introduces request model + review branch, **not** operational revision CLI, scheduler, dependency reconciliation graph, worker continuation, or no-progress terminal gates.

These are not independent defects in Task 727's bounded deliverable; they are required follow-on acceptance criteria of Job 558.
