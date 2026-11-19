# Rust2 PORTING API surface audit

> Generated with `node scripts/rust2-api-parity-audit.mjs --write`. Static candidate checks only: **do not upgrade a ledger row to PASS using this report alone**.

## Interpretation

This audit reads actual TypeScript exports, including exported class methods, and identifies plausible Rust declaration names. Missing names need investigation: Rust may implement them via a differently named method or adapter, so a missing direct match is **not** proof that an API is absent. Matched names are also not proof of matching signatures, effects or semantics.

The exported class properties and interface/type aliases need additional structural or semantic review even when a name looks similar. This is not signature checking.

A listed direct differential import only means a head-to-head test imports the compiled Node module; it does **not** show that every symbol or edge case is covered. A Rust module reference does **not** establish actual production wiring.

## Snapshot

| Metric | Count |
|---|---:|
| sourceCount | 80 |
| pendingSourceModules | 0 |
| pendingRuntimeExportSymbols | 0 |
| runtimeExportSymbols | 536 |
| directNameMatches | 523 |
| unmappedRuntimeSymbols | 0 |
| runtimeConstructorReviews | 13 |
| typeOrShapeReviewSymbols | 233 |
| filesWithUnmappedRuntime | 0 |
| filesWithoutDirectDiffImport | 43 |
| filesWithoutOtherRustReferences | 23 |

Source tree: `c846739e5f60`; Rust source tree: `155c0256d028`. Rust module rows in scope: 80. Full symbol details: [RUST2_API_PARITY_MATRIX.json](RUST2_API_PARITY_MATRIX.json).

## Pending source modules (not included in PORTING name-match counts)


## Per-file candidate surface (all 80 PORTING files)

| Node source | Runtime exports | Named Rust candidates | Unmapped runtime names | Direct diff imports | Other Rust refs |
|---|---:|---:|---:|---:|---:|
| `src/adapters.ts` | 12 | 12 | 0 | 2 | 5 |
| `src/blocker-recovery.ts` | 1 | 1 | 0 | 0 | 0 |
| `src/blockers.ts` | 2 | 2 | 0 | 0 | 3 |
| `src/browser-worker-routing.ts` | 1 | 1 | 0 | 0 | 0 |
| `src/browser-worker-runtime.ts` | 2 | 2 | 0 | 0 | 2 |
| `src/chatgpt-platform-fallback.ts` | 5 | 5 | 0 | 0 | 1 |
| `src/cli-artifact.ts` | 2 | 2 | 0 | 4 | 1 |
| `src/cli-coordinator.ts` | 1 | 1 | 0 | 1 | 1 |
| `src/cli-escalation.ts` | 4 | 4 | 0 | 1 | 1 |
| `src/cli-foreground.ts` | 2 | 2 | 0 | 0 | 0 |
| `src/cli-job-create.ts` | 1 | 1 | 0 | 0 | 1 |
| `src/cli-prompt.ts` | 5 | 5 | 0 | 0 | 0 |
| `src/cli-review.ts` | 3 | 3 | 0 | 1 | 2 |
| `src/cli-support.ts` | 38 | 37 | 0 | 4 | 6 |
| `src/cli-unblock.ts` | 2 | 2 | 0 | 1 | 1 |
| `src/cli-worker-task.ts` | 3 | 3 | 0 | 0 | 1 |
| `src/cli.ts` | 6 | 6 | 0 | 3 | 4 |
| `src/dag-task-runtime.ts` | 5 | 5 | 0 | 0 | 2 |
| `src/dashboard-actions.ts` | 3 | 3 | 0 | 0 | 2 |
| `src/dashboard.ts` | 1 | 1 | 0 | 0 | 3 |
| `src/decision-audit.ts` | 13 | 13 | 0 | 1 | 1 |
| `src/dependency-revision-execution.ts` | 3 | 3 | 0 | 0 | 1 |
| `src/escalation-notifier.ts` | 2 | 2 | 0 | 0 | 0 |
| `src/events.ts` | 13 | 13 | 0 | 3 | 38 |
| `src/execution-context.ts` | 6 | 6 | 0 | 1 | 0 |
| `src/execution-process-tracker.ts` | 2 | 2 | 0 | 0 | 0 |
| `src/execution-recovery.ts` | 2 | 2 | 0 | 0 | 1 |
| `src/execution-routing.ts` | 6 | 6 | 0 | 1 | 2 |
| `src/feedback.ts` | 23 | 23 | 0 | 2 | 0 |
| `src/force-restate-validation.ts` | 6 | 6 | 0 | 0 | 1 |
| `src/force-restate.ts` | 1 | 1 | 0 | 0 | 0 |
| `src/github-auth.ts` | 2 | 2 | 0 | 0 | 1 |
| `src/github-client.ts` | 10 | 10 | 0 | 0 | 0 |
| `src/interactive-invocation.ts` | 12 | 11 | 0 | 1 | 5 |
| `src/interactive-request.ts` | 5 | 5 | 0 | 1 | 3 |
| `src/interactive-resume.ts` | 2 | 2 | 0 | 0 | 0 |
| `src/job-actions.ts` | 4 | 4 | 0 | 0 | 3 |
| `src/job-pause.ts` | 2 | 2 | 0 | 0 | 0 |
| `src/job-worktree-cleanup.ts` | 1 | 1 | 0 | 0 | 1 |
| `src/legacy-orchestrator-repair.ts` | 1 | 1 | 0 | 0 | 0 |
| `src/local-job-registry.ts` | 2 | 2 | 0 | 0 | 1 |
| `src/local-managed-store.ts` | 1 | 1 | 0 | 0 | 0 |
| `src/managed-worker-input.ts` | 1 | 1 | 0 | 0 | 1 |
| `src/manual-plan.ts` | 1 | 1 | 0 | 0 | 2 |
| `src/model-redecision.ts` | 2 | 2 | 0 | 1 | 1 |
| `src/model-routing.ts` | 4 | 4 | 0 | 1 | 4 |
| `src/outcome-review.ts` | 5 | 5 | 0 | 2 | 2 |
| `src/planner-child-recovery.ts` | 1 | 1 | 0 | 0 | 0 |
| `src/planner-runtime.ts` | 7 | 7 | 0 | 4 | 5 |
| `src/planner.ts` | 22 | 20 | 0 | 2 | 9 |
| `src/projected-store.ts` | 34 | 34 | 0 | 2 | 1 |
| `src/reconciler-context.ts` | 3 | 3 | 0 | 0 | 0 |
| `src/reconciler-runtime.ts` | 10 | 10 | 0 | 2 | 5 |
| `src/relay-store-discovery.ts` | 3 | 3 | 0 | 0 | 6 |
| `src/relay-store.ts` | 46 | 45 | 0 | 8 | 26 |
| `src/relayd-dashboard-actions.ts` | 1 | 1 | 0 | 1 | 1 |
| `src/relayd-main.ts` | 0 | 0 | 0 | 0 | 0 |
| `src/relayd-utilities.ts` | 10 | 10 | 0 | 1 | 2 |
| `src/relayd.ts` | 1 | 1 | 0 | 0 | 5 |
| `src/route-outcome-recording.ts` | 5 | 5 | 0 | 1 | 2 |
| `src/router-evals.ts` | 2 | 2 | 0 | 0 | 0 |
| `src/script-task-adapter.ts` | 3 | 3 | 0 | 0 | 1 |
| `src/service-external-actions.ts` | 2 | 2 | 0 | 0 | 0 |
| `src/single-job-task-control.ts` | 1 | 1 | 0 | 0 | 0 |
| `src/store-github.ts` | 21 | 21 | 0 | 1 | 6 |
| `src/store.ts` | 22 | 22 | 0 | 8 | 4 |
| `src/task-actions.ts` | 18 | 18 | 0 | 1 | 8 |
| `src/task-recovery.ts` | 4 | 4 | 0 | 0 | 2 |
| `src/task-update.ts` | 2 | 2 | 0 | 1 | 1 |
| `src/troubleshooter-fallback.ts` | 2 | 2 | 0 | 1 | 1 |
| `src/troubleshooter.ts` | 6 | 6 | 0 | 0 | 2 |
| `src/types.ts` | 7 | 7 | 0 | 1 | 6 |
| `src/unblock.ts` | 4 | 4 | 0 | 1 | 4 |
| `src/usage.ts` | 26 | 18 | 0 | 3 | 5 |
| `src/worker-routing.ts` | 8 | 8 | 0 | 1 | 4 |
| `src/workflow-effect-failures.ts` | 2 | 2 | 0 | 0 | 0 |
| `src/workflow/durable-transition.ts` | 4 | 4 | 0 | 1 | 0 |
| `src/workspace.ts` | 21 | 21 | 0 | 1 | 4 |
| `src/z-adapter.ts` | 5 | 5 | 0 | 0 | 0 |
| `src/z-oauth.ts` | 2 | 2 | 0 | 0 | 1 |

## Priority review: unmapped exported runtime symbols


## Required next verification

For each file: inventory every runtime export and applicable type contract; map to the actual Rust signature/dispatch implementation; compare behavior on the same positive, negative, boundary and randomized fixtures; compare durable SQLite, files, Graph decisions, HTTP, events and restart/idempotency effects as applicable; test a real Rust entry point/caller. Only then consider ledger PASS.
