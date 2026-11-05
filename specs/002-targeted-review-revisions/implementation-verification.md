# Consolidated Task 728 implementation verification

This receipt supplements, rather than rewrites, the Task 727 foundation verification.
The independent `job-acceptance-reviewer` remains the authority for final Job #558
acceptance, delivery, and actual current-HEAD approval.

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
- Five changes-required review rounds exhaust to durable owner-resolution
  disposition and an idempotent evidence comment, not silent infinite retries.

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
- **PENDING:** Independent final Job objective acceptance review and delivery.
  These gates belong to Relay and must not be certified by the Implementation worker.

An isolated CLI or browser submission acknowledgement is not a worker terminal
event and does not prove approval or delivery.
