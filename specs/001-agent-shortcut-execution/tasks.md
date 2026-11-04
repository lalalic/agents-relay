# Tasks: Neo Project Agent Shortcut Execution

**Source**: [spec.md](spec.md) and [plan.md](plan.md).
Check marks indicate **verified implementation scope**, not a full feature release.

## Existing foundation (2026-11-03; limited, local fixture scope)

- [x] T001 Inventory Relay parser, Graph/SQLite, CLI and Vlog contracts.
- [x] T002 Implement code-shortcut DAG fixture runner, checkpointed waits and validated receipts for the existing opt-in Job.
- [x] T003 Implement Vlog Visioner module fixtures and basic CLI compatibility tests.
- [ ] T004 Prove that the *full* Direct Shortcut Graph executes without ordinary Worker scheduling; old code can still fall back.

## No-Start Worker Fallback (current hotfix)

- [x] T005 Reconcile the Spec with the newer Direct Runner contract and explicitly distinguish normal-Worker fallback.
- [x] T006 Add graph-owned `worker.no_start_failed` and once-only durable recovery action.
- [x] T007 Resolve only an eligible Codex configured default through existing routing constraints; no hard-coded default.
- [x] T008 Wire ChatGPT/Z pre-start launch, start-ack, process, terminal and timeout failures to the same exact-generation recovery path.
- [x] T009 Add fake Adapter, Graph, adverse-case, route and SQLite restart/late-event tests.
- [ ] T010 Complete full repository regression suite and independent review for this hotfix.
- [ ] T011 Merge and activate the reviewed hotfix only after T010 and documented release safety checks.

## Direct Runner Remaining Scope (separate release gate)

- [ ] T012 Synchronous `neo project run` integration with live per-node output and truthful exit codes.
- [ ] T013 Relay direct Codex default-model executor for nodes without code shortcuts; no scheduler, Planner or normal Worker dispatch.
- [ ] T014 Durable 20-minute first-execution deadline, bounded concurrency and owned-process cleanup with restart tests.
- [ ] T015 Full real Vlog Agent Graph E2E with immutable evidence, project evals and independent review.
- [ ] T016 Merge Direct Runner only after its independent T012–T015 release gates pass.

## Dependencies

T005–T009 form the independent normal-Worker fallback hotfix. T010 and T011
are the remaining delivery gates for that hotfix. T012–T016 are independent
Direct Runner acceptance requirements: passing normal Worker fallback tests
does not imply the Direct Runner or full Vlog E2E has passed.
