# Offline Shortcut Runner DAG acceptance matrix

Run from the **sole development worktree**:

```sh
npm run test:shortcut:dags
```

This is a strict **release gate**. A non-zero exit means at least one spec requirement is **not yet satisfied**; never turn red cases into skipped or expected-failure assertions to claim green. This suite is intentionally independent of `npm run test:full` until T004 reaches its implementation gate. Runs use temporary SQLite stores and in-process/code-module fixtures. No actual provider requests, Vlog media, publishing, human approval, global Relay queue or background daemon.

| DAG | Graph | Requirement | Pass evidence |
| --- | --- | --- | --- |
| D01 | `source → {left,right} → join` | FR-002/005/006/011 | Both branches concurrently run, join sees exactly two predecessor outputs, one durable Task completion |
| D02 | `source(code) → model(Worker) → finish(code)` | FR-002/004/006/007 | Source code checkpoint persists before model dispatch; pending model must not erase it; **additional fake-Adapter completed-node E2E required before T004** |
| D03 | `{code,model(Worker)} → join` | FR-002/004/006 | Independent code branch progresses when model route is waiting, join remains gated |
| D04 | `{waiter,independent} → join` | FR-005/008/011 | `WAITING_EVENT`, independent completion, exact SQLite receipt, restart, one join, no independent replay |
| D05 | `source → invalid → finish` | FR-007/012 | Invalid result fails; no successor effects; no silent Worker fallback |

`cases.json` maps each case to the source FRs and a small real Mermaid Graph. Source files are committed; test-generated stores/logs are disposed after each run. Current tests distinguish **code execution**, **Worker selection**, and **model completion** rather than claiming the same thing from a process exit. Existing `agent-shortcut.test.js` and `no-start-fallback.test.js` cover low-level fake Adapter and recovery generation fencing.

## Known gaps and remaining gates

On 2026-11-04, the first strict suite yielded **3/5 PASS** in about 1.4 seconds. D02/D03 failed because a single missing module caused *whole-DAG Worker fallback* before any available code modules executed. These remain **T004 RED**. Fix the node boundary using existing Relay Worker routing, per-node checkpoint/receipt and one Graph/SQLite authority, **without a second scheduler**. Once these pass, add a fake Worker **completion + recovery** end-to-end test ensuring a real model-node output feeds `finish`, including a failure-triggered Troubleshooter owned by the same foreground runner.


The elapsed deadline requirement FR-009 / T014 remains in the separate core Shortcut tests, not this DAG matrix.
