# Tasks: Neo Project Agent Shortcut Execution

**Source**: [spec.md](spec.md) and [plan.md](plan.md).
Check marks indicate **verified implementation scope**, not a full feature release.

## Existing foundation (2026-11-03; limited, local fixture scope)

- [x] T001 Inventory Relay parser, Graph/SQLite, CLI and Vlog contracts.
- [x] T002 Implement code-shortcut DAG fixture runner, checkpointed waits and validated receipts for the existing opt-in Job.
- [x] T003 Implement Vlog Visioner module fixtures and basic CLI compatibility tests.
- [ ] T004 Prove that the full Shortcut Graph runs code shortcuts directly and model-backed nodes via existing Worker fallback, without a duplicate DAG scheduler or Job authority.
  - **Verified 2026-11-04:** five permanent DAGs D01–D05 (D06 removed), F01–F10 failure injection, and fake Relay Worker lifecycle/recovery: `test:shortcut:dags` **47/47 PASS**. `test:fast` **134/134 PASS**; `test:full` **1106/1106 PASS**, L3 **70 PASS, 1 SKIP, 0 FAIL**. Real private Vlog passed Visioner (code), Director and Editor (Workers); Producer failed on mistaken omission of canonical Run evidence. F09/F10 and `0b31892` correct that input contract, but real Producer after the fix remains NOT_RUN. T004 remains open for full real evidence and independent review.

## No-Start Worker Fallback (integrated on this branch)

- [x] T005 Reconcile the Spec with the newer Direct Runner contract and explicitly distinguish normal-Worker fallback.
- [x] T006 Add graph-owned `worker.no_start_failed` and once-only durable recovery action.
- [x] T007 Resolve only an eligible Codex configured default through existing routing constraints; no hard-coded default.
- [x] T008 Wire ChatGPT/Z pre-start launch, start-ack, process, terminal and timeout failures to the same exact-generation recovery path.
- [x] T009 Add fake Adapter, Graph, adverse-case, route and SQLite restart/late-event tests.
- [ ] T010 Complete full repository regression suite and independent review for the integrated Worker fallback and Shortcut changes; fix any failures. **Full suite passed 2026-11-04 (1106/1106 + L3 70 PASS, 1 SKIP); independent review remains open.**
- [x] T011 Integrate the Worker fallback changes into the sole Shortcut Runner development branch (merge `3398a9a`); production activation is deferred to T016.

## Shortcut Runner Remaining Scope (same branch)

- [x] T012 Synchronous `neo project run` integration with live per-node output, private per-Run log, verified durable terminal outcome, truthful exit codes, safe replay and no-write dry-run. Verified in Neo tests; real Vlog E2E is T015.
- [ ] T014 Durable 20-minute first-execution deadline, bounded concurrency and owned-process cleanup with restart tests.
- [ ] T015 Full real Vlog Agent Graph E2E with immutable evidence, project evals and independent review. **Partial live evidence:** `neo/vlog/runs/2026-11-04-shortcut-mixed-dag-vlog-e2e-v2/` completed Visioner/Director/Editor but Producer failed; Run/child recovery cancelled safely. No finished video, Final QA, or owner preview approval; revised Producer input contract has synthetic evidence only.
- [ ] T016 Once T004, T010, T012, T014 and T015 pass, merge the complete Shortcut Runner to main, activate, verify live and clean the worktree.

## Dependencies

All changes now reside on `feature/shortcut-direct-execution-20261104`.
T011 is complete and is not a second deployment. The proposed new direct
Codex executor was removed: existing Worker fallback handles model-backed nodes.
T004, T010, T012, T014 and T015 must pass before one unified T016 release.
Worker fallback quality tests alone do not prove full Vlog E2E.
