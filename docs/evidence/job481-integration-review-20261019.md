> Historical report at 6d9b9e4. Current integration evidence superseding this snapshot: [job481-final-integration-20261020.md](job481-final-integration-20261020.md).

# Job 481 integration branch verification

Branch: `fix/review-integration-20261019` (not merged, not live, not published). Latest changes through commit `79ea2ad`.

## Authoritative objective and scope

Source: the existing Job 481 record, read through `node dist/cli.js job show --repo lalalic/agents-relay --id 481`. The objective requires real L1 contract enforcement, opt-in real L2 provider roles and failure cases, and production L3 Plan/Task/Review/Troubleshooter/Merge/Objective recovery with independent evidence. The following is evidence for the *integration branch*, **not approval for Job 481 merge**.

## L1

`npm run test:verification:l1` executes canonical contract, agent/role assertions, CLI/evidence gates and static Graph/Dashboard checks. Source metadata and Mermaid Graph are canonical; `workflow/main.mmd` is presentation-only.

## L2

Genuine installed Codex CLI + real role Markdown prompts, private MCP `relay_l2.publish`, raw event capture, and production ingress/SQLite replay executed for Implementation, Reviewer, Troubleshooter and Planner positive cases. Each recorded exactly one `task.started` and one `task.completed`, with exact correlated source identity and required role payload; Reviewer has an immutable SHA and `approved` verdict. Production SQLite reviewer outcome is `approved`. Initial read-only Codex attempt failed because MCP needed approval; the run using `--approve-for-me` succeeded. Private raw reports:

- `/tmp/relay-l2-live-implementation-third.json`
- `/tmp/relay-l2-reviewer.json`
- `/tmp/relay-l2-troubleshooter.json`
- `/tmp/relay-l2-planner.json`

`npm run test:verification:l2` tests the isolated sink and genuine production ingress, including wrong immutable Reviewer SHA rejection. This **does not** attest full Relay CodexAdapter launch or ChatGPT provider. Real negative role scenarios (provider failure, changes-required, escalation, missing input) are NOT_RUN.

## L3

The full Job 481 11-branch gate has **9 PASS / 0 FAIL / 2 NOT_RUN** from `npm run test:verification:matrix`. The two NOT_RUN remain terminal Planner failure -> Troubleshooter -> new successful Plan and the exact combined path requiring terminal `planner.failed`. See generated `/tmp/agents-relay-job481-evidence/report.json` and `report.md` for specific per-path authority and mock limits.

The additional *positive* Plan-round integration test (not substituting for the two strict NOT_RUN paths) uses a genuine SQLite Plan, production Reconciler and Graph, fails the first Planner provider invocation, retries and commits child Tasks. It then goes through Worker failure/Troubleshooter, Reviewer changes-required/fix/new SHA, Reviewer failure/Troubleshooter, Review approved, Git merge failure and retry, and verifies Job `COMPLETED` from SQLite. External provider and Git side effects are isolated deterministic mocks. A successful Plan round without its child completion never makes the objective COMPLETED.

Production atomic SQLite Transition + Outbox, crash after commit before event publish, publish-before-ack/restart, event-key consumer dedup and unknown launch effects have separate positive and negative tests.

## Remaining blockers

1. Terminal Planner `FAILED` -> genuine recovery authority and subsequent Plan success through Troubleshooter, including the full exact objective failure path. Automatic Planner `retry` is tested but is not the same semantics.
2. Production notifier for `escalation.requested` user-visible channel and durable delivery receipt. The L3 mock notifier is deterministic only. Never auto-mark delivered on an Event Bus publish acknowledgment.
3. Full true Relay CodexAdapter model role combinations and negative role/missing input/escalation outcomes, and isolated ChatGPT provider where supported.
4. Dashboard real-browser drilldown/max/zoom/XSS E2E is not established by the static Graph tests.
5. Independent final immutable-SHA review not yet performed. Do not merge, publish or turn on production Jobs from this report.

No real Job 481 task, production NATS, Git remote main branch, or other users' active worktrees were mutated.
