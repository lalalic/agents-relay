# Implementation Plan: Neo Project Agent Shortcut Execution

**Spec**: [spec.md](spec.md)
**Scope**: One canonical Shortcut Runner feature and one development branch. The integrated no-start Worker recovery is part of the same acceptance and release.

## Architecture Lens

- **Workflow decision**: `workflow/task-lifecycle.mmd` owns whether a normal ChatGPT/Z generation that failed without an accepted `task.started` is requeued, and whether a Direct Shortcut Task launches or fails.
- **Actions and mechanics**: `src/workflow/runtime.ts` records the no-start recovery snapshot; `src/reconciler-runtime.ts` gathers exact-generation facts; `src/chatgpt-platform-fallback.ts` chooses an eligible configured Codex default through the existing router; `src/reconciler-review.ts` dispatches that durable selection.
- **Durable authority**: Relay SQLite Job/Task state and execution history. EventBus messages are wake-ups and observations, never authoritative output or human approval.
- **Execution ownership**: A normal Worker failure can retry once within normal Worker mode. Shortcut DAG code nodes execute directly, while uncovered model-backed nodes use existing Relay Worker fallback and lifecycle.
- **No duplicate authority**: No second Job store, parallel DAG parser, custom scheduler or duplicate routing policy in CLI/daemon.
- **Risk decision**: Absence of `task.started` is not evidence of zero remote side effects. The no-start fallback is explicitly operator-selected policy and must retain failure identity and cancel owned work, with residual duplicate-action risk documented.

## Normal Worker No-Start Recovery (already integrated)

1. A ChatGPT or Z Worker fails before Relay accepts the **correlated** `task.started` event. Supported observed failures: launch, delivery/start-ack, failed process exit, terminal `task.failed` and expired start deadline.
2. Check current Task is still QUEUED with the same execution ID, is not a reviewer/Planner/Troubleshooter, has remaining attempt budget and no previous no-start fallback, is not a Direct Shortcut Job, and has no incompatible runtime/worker requirements.
3. Resolve Codex from actual installed Adapter registration and the **top-level Codex `config.toml` default**, not a hard-coded model/catalog fallback. Apply provider/resource policy, exclusions and strict capabilities.
4. Dispatch one graph event, `worker.no_start_failed`. If eligible, graph action `mutation.prepareNoStartFallback` durably records original route, failure generation, attempt and reason, clears its lease/route and requeues the **same** Task.
5. Cancel and clear the old owned execution. A new reconcile selects Codex default and launches the next attempt; an old execution's events cannot be accepted as current. Do not create a Troubleshooter on this branch.
6. If any guard fails or no eligible configured Codex default is available, follow existing failure/recovery logic; never attempt another no-start fallback.

**Existing platform-confirmed `submitted:false` safe reroute** is a separate, unchanged existing path. The new rule is a deliberate extension when Relay has not accepted `task.started`; it does **not** claim that delivery was impossible.

## Shortcut Runner (remaining work)

- One existing `neo project run` binding, synchronous foreground CLI, live per-node events, bounded DAG concurrency, explicit code shortcut or existing Relay Worker fallback, durable event receipts and 20-minute unchanged deadline.
- Preserve the existing Graph/SQLite authority. Reuse Worker scheduling for fallback nodes rather than implementing a second direct Codex executor.
- A missing code shortcut for a model-backed node may use Worker fallback; an invalid result must fail rather than falsely complete.
- A real Vlog full-DAG run with evidence, evals and independent review is the final release gate for the sole Shortcut Runner branch. No separate Worker hotfix deployment is planned.

## Verification

- Normal Worker recovery: ChatGPT and Z launch/start-ack/process/terminal failures; missing start deadline; Codex configured default selection; strict constraints and no-default negatives; at-most-once; stale execution; SQLite restart; no Troubleshooter.
- Regressions: original positive non-submission fallback, started Task failures, scheduler and route audit behavior, Graph/SQLite consistency.
- Run `npm run build`, focused `node --import ./test/test-store-env.mjs --test ...`, and available full local suites. Report provider/browser live tests as NOT_RUN unless performed.

No external media upload, paid provider inference, publication, human approval impersonation, automatic Git content merge or production service changes are authorized by these acceptance tests.
