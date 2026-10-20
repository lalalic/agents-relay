# Job 481 integration implementation and coverage review (2026-10-20)

Repository: lalalic/agents-relay; integration branch: fix/review-integration-20261019.

## Graph inventory and L1

There are 17 Mermaid files: 16 executable Graph DSL policies, all referenced by production loaders, plus presentation-only `workflow/main.mmd`. None qualifies for deletion. `npm run test:verification:l1` runs `graph-inventory.test.mjs` and covers every declared input path and Boolean guard branch/edge across the 16 executable Graphs using the production GraphRuntime. Its synthetic guard combinations respect the `task-reconcile` invariant that dependenciesUnsatisfied and runnable cannot both be true. The inventory gate fails on any orphan, unparsed, unbound or unvisited executable edge. L1 graph-edge coverage is *not* equivalent to L3 production path coverage.

## Planner failure → exact recovery → Objective COMPLETED (L3)

The canonical `workflow/planner-orchestration.mmd` now selects `planner.createRecovery` when a non-manual, non-unblock Plan round is terminal FAILED. Code only performs that selected action, materializing one durable Troubleshooter Task with `recoveryPlanId` (not a pretend planner Task). While that recovery is unverified, the old FAILED Plan is retained and no new round is created. Only a correlated succeeded Troubleshooter Task with nonempty `data.evidence` and `data.verified=true` permits a **new Plan** via the same Graph's `planner.createRound`. The old Plan never changes its terminal status.

`l3-planner-terminal-combined.mjs` + `l3-planner-round.test.mjs` exercise production Reconciler/Graph/SQLite, terminal `planner.failed`, Plan-specific Troubleshooter recovery, new Plan, Worker failure/recovery, Reviewer changes-required/fix/new SHA, Reviewer failure/recovery, Merge fail/retry, and SQLite Objective COMPLETED. A negative test rejects unverified recovery. Another test proves failed Plan → human escalation pending → notifier receipt → human unblock → new Plan recovery without fabricating Task-level Planner state. Model/Git effects remain deterministic isolated L3 stubs; status must not imply real provider or Git delivery.

The fixed required 11-path Job481 acceptance matrix now yields `11 PASS / 0 FAIL / 0 NOT_RUN`, with source-specific isolated proof. `npm run test:verification:matrix` regenerates `/tmp/agents-relay-job481-evidence/report.{json,md}`. Those 11 paths are **not every combinatorial production Graph path**; coverage levels remain distinguished.

## Notification

`src/escalation-notifier.ts` is an actual Relay Reconciler notification adapter, enabled only by `AGENTS_RELAY_ESCALATION_NOTIFY_URL` pointing at HTTPS or localhost HTTP. `AGENTS_RELAY_ESCALATION_NOTIFY_TOKEN` optionally authorizes the downstream service. It sends exact escalation identity, required action, context and idempotency key. The downstream service must respond with HTTP success AND JSON `{delivered:true, channel, deliveryId, deliveredAt}` for SQLite notification state to become delivered. Failure, missing configuration, timeouts and HTTP success without a receipt retain pending state, store an actionable error, and retry (when configured) after durable backoff; duplicates retain the same idempotency key. Isolated localhost HTTP and crash/restart tests pass. No real external human notification destination has been configured or verified, so actual human delivery remains NOT_RUN.

## Real L2

Four genuine installed Codex CLI plus local role instructions produced canonical started and completed emissions through a private MCP event sink and passed production Relay ingress/isolated SQLite (Implementation, Planner, Reviewer, Troubleshooter). Three extra real negative cases passed: Implementation failure, missing input and Reviewer changes-required. Actual positive and negative runs are recorded under `/tmp/relay-l2-*.json`, including `/tmp/relay-l2-implementation-failure-20261020.json`, `/tmp/relay-l2-implementation-missing-input-20261020.json`, and `/tmp/relay-l2-reviewer-changes-required-20261020.json`. This invokes installed Codex CLI, not the full production CodexAdapter launch path. ChatGPT model sandbox and remaining role × failure combinations are NOT_RUN.

## Real browser Dashboard

A local isolated read-only Dashboard was served on 127.0.0.1:18983 for Browser Workspace checks; no production Job data used. Browser E2E discovered Mermaid 11 SVG with undeclared `xlink` prefix and tooltip-bearing `click` instructions that prevented navigation. Fixed by normalizing the SVG parser namespace and stripping only Mermaid click directives before rendering, then binding validated local graph href targets as controlled navigation. All 17 Graphs render, main has 11 nodes with 9 valid links, and drilldown, Back/Forward, inspector panel, maximize/zoom/fit and 6 adversarial SVG XSS cases passed **38/38**. Evidence: `/tmp/agents-relay-job481-graph-browser-evidence/report.json` plus screenshots. Browser session and isolated local server are closed. Test: `test/workflow-dashboard-graph-coverage-e2e.py`. No live Dashboard deployment performed.

## Review boundaries

- SQLite is the single lifecycle authority; Graph owns policy; actions are the selected effects.
- New Plan recovery Task inherits standard generation/lease/routing restrictions and original Plan history.
- No main merge, remote push, npm publish, live deployment, Job/Task/PR creation, production bus manipulation, or primary repository cleanup occurred.
- Native production CodexAdapter + ChatGPT provider, unconfigured external notifier, all live runtime Graph effects, and exhaustive L3 path coverage remain unverified. Never mark them PASS based on L1 synthetic edge coverage or isolated L3 mocks.
- Independent immutable-SHA source review is requested before any merge/live authorization.
