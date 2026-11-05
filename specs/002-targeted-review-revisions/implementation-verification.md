# Consolidated Task 728 implementation verification

This receipt supplements, rather than rewrites, the Task 727 foundation verification.
The original Job #558 and PR #293 were explicitly cancelled/closed at user direction.
These historical receipts remain relevant evidence; delivery now belongs to the separately reviewed direct release, not the cancelled Job lifecycle.

## Implemented boundaries

- `task revise` accepts identified findings for the exact active Reviewer execution
  and immutable local Git head. The canonical Revision Graph selects the durable
  atomic SQLite mutation; repeated identical request IDs reuse a semantic child.
  Original successful Task output and review-feedback comments remain immutable.
- The Review Graph exclusively chooses targeted work or explicit ownership
  resolution; there is no competing generic review-fix branch.
- The Task Graph owns worker completion, retry, cancellation and generation.
  Revision request recovery is Graph-authorized only after the same child is
  legitimately requeued; no uncertain execution is considered successful.
- Dependency-revision Graph selects explicit revalidation or mandatory rerun by
  stable upstream evidence vectors. Pending fan-in is not skipped; superseded
  results cannot approve an old vector.
- Final Job Review rechecks whole-Job criteria on an immutable target, uses a
  dedicated `job-acceptance-reviewer` role, preserves historical `reviewer`
  records, and never merges from a stale SHA.
- Planner validates one effective Agent role per newly created Plan round;
  missing/blank names normalize to implementation; legacy/new Final Reviewer
  names are gate-owned rather than planner-created.
- Configurable review-round and repeated-finding no-progress limits are
  selected through the Review Graph and produce durable owner-resolution
  evidence, never silent infinite retries.
  Operators may set `AGENTS_RELAY_REVIEW_MAX_ROUNDS` (default 5) and
  `AGENTS_RELAY_REVIEW_NO_PROGRESS_LIMIT` (default 1); invalid values fail closed.

## Verification evidence

| Check | Result |
| --- | --- |
| Build, source size, whitespace | PASS |
| Full unit / integration regression | PASS, 1,130/1,130 tests on the final implementation tree |
| L1 Graph inventory, prompt contract, planner gates | PASS, 53 tests |
| L2 isolated transport, reviewer normalization | PASS, 11 tests; one live scenario skipped |
| L3 SQLite/Graph/CLI/replay/restart | PASS, 70 tests; one pre-existing skip |
| L4 prompt contracts | PASS, 21 tests |
| Targeted CLI through a real isolated single-Job service and disposable Git checkout | PASS: authorized intake, repeat-ID deduplication, stale execution/head rejection, preserved original Task result |
| Managed Graph review → fix → same-SHA re-review → approval | PASS in isolated test using injected worker events |
| L3 review → fix → new-SHA re-review → Troubleshooter → approval → retry merge | PASS in isolated SQLite replay with mock worker launch/Git merge boundaries |

The final implementation tree passed \`npm run test:full\` (1,130 unit/integration
and 70 L3 tests), \`npm run test:verification:l1\` (53 tests), and
\`npm run test:verification:l4:contracts\` (21 tests). One L3
live-provider scenario remains skipped, not silently accepted.

## Honest limits

- **NOT_RUN:** Physical ChatGPT/Codex provider session affinity, cross-adapter
  failover, and real WebHelm FIFO delivery under a live reviewer revision.
  Isolated contract/adapter tests are not equivalent to a provider receipt.
- **NOT_RUN:** Genuine multi-provider managed Job review/fix/re-review with
  unmocked external provider actions and final real Git delivery. Mock merge
  success is not production acceptance.
- **CANCELLED:** Original Job #558/PR #293 were cancelled without merge by
  explicit user request; a separate direct release must provide its own reviewed
  diff, clean merge, package publication receipt, and live service verification.

An isolated CLI or browser submission acknowledgement is not a worker terminal
event and does not prove approval or delivery.

## Post-publication live acceptance handoff

These live checks are **NOT_RUN / PENDING_POST_PUBLISH**. The historic
Plan 11 is retained as evidence, but Job #558 and PR #293 were cancelled
without merge and cannot be reused as a release or completion receipt. The
source tree's package.json may retain an old development version; the
release workflow selects the actual published npm version. The verification
target is the **exact new merged main SHA** and a separately verified npm
publication/deployment receipt containing it. The previously running
`agents-relay@2.0.209` cannot be assumed to include the new implementation.

**Owner:** The Job orchestrator owns scheduling and recording the follow-up
after verified publication. If it cannot run the checks in the supported live
environment, it must request user-run acceptance and preserve this status as
pending; it must not report a pass or silently close the handoff.

**Trigger and prerequisites:** Start only after the new direct-release PR is independently reviewed and
merged and the corresponding package publication receipt is verified.
Before executing, verify that the live Relay runtime is healthy and that its
reported build provenance includes that exact merged commit. Record the actual runtime version and its package/source provenance and
confirm they contain the merged change before proceeding. Use the supported
live environment and caller-owned WebHelm session; do not recreate cancelled
Task 787 or claim its evidence.

**Scenarios to run:**

1. Exercise one genuine managed multi-provider Job through Review → targeted
   Fix → Re-review → approved delivery, using real provider actions and the
   authorized Relay delivery path. Capture the immutable review SHA, targeted
   revision lineage, correlated terminal events, approved SHA, and delivery
   receipt.
2. Exercise ChatGPT, Codex, and WebHelm worker FIFO/session-affinity behavior
   with the same review→fix→re-review flow. Verify each continuation uses the
   intended original thread/session when compatible, and that uncertain
   submissions are reconciled without duplicate sends or premature slot
   release.

The follow-up receipt must record publication identity and time, package
version, deployed runtime version and build commit, scenario Job/Task identities,
observed thread/session and FIFO evidence, delivery receipt, per-scenario
PASS/FAIL/NOT_RUN, and any unresolved limits. Keep both scenarios pending until
that evidence is available. These live checks are post-publication acceptance;
they are not represented by the isolated test results above or as evidence that
has already passed.
