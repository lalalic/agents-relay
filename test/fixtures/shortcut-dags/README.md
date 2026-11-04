# Offline Shortcut Runner DAG acceptance matrix

Run from the **sole development worktree**:

```sh
npm run test:shortcut:dags
```

This is a strict **release gate**. A non-zero exit means at least one spec requirement is **not yet satisfied**; never turn red cases into skipped or expected-failure assertions to claim green. This suite is intentionally independent of `npm run test:full` until T004 reaches its implementation gate. Runs use temporary SQLite stores and in-process/code-module fixtures. No actual provider requests, Vlog media, publishing, human approval, global Relay queue or background daemon.

| DAG | Graph | Requirement | Pass evidence |
| --- | --- | --- | --- |
| D01 | `source → {left,right} → join` | FR-002/005/006/011 | Both branches concurrently run, join sees exactly two predecessor outputs, one durable Task completion |
| D02 | `source(code) → model(Worker) → finish(code)` | FR-002/004/006/007 | Source code checkpoint persists before model dispatch; pending model must not erase it; Fake Adapter drives `task.started`/`task.completed` and proves structured model output reaches code successor |
| D03 | `{code,model(Worker)} → join` | FR-002/004/006 | Independent code branch progresses concurrently with a fake model Worker, join remains gated |
| D04 | `{waiter,independent} → join` | FR-005/008/011 | `WAITING_EVENT`, independent completion, exact SQLite receipt, restart, one join, no independent replay |
| D05 | `source → invalid → finish` | FR-007/012 | Invalid result fails; no successor effects; no silent Worker fallback |

D01–D05 also run automatically in standard `npm run test:fast` and `npm run test:full` to prevent silent regression; F01–F10 run in the full suite through `test/agent-shortcut.test.js`.

`cases.json` maps each case to source FRs and real Mermaid Graphs. The command includes `test/agent-shortcut.test.js` to test the **same D02/D03 graphs** with an in-process fake Relay Adapter and durable correlated Task lifecycle. Test-generated stores/logs are disposed after each run; code execution, Worker selection, Worker completion, and downstream outputs are individually asserted. The tests do not use real providers.

## Fault injection and release gates

The permanent suite retains **five DAGs (D01–D05), no D06**. D02/D03 have a strengthened real-Task test in `test/agent-shortcut.test.js`:

- **F01:** the Worker publishes `task.completed` but writes an invalid JSON output. The Graph must fail closed; no downstream action is permitted.
- **F02:** the Worker publishes `task.failed`; a foreground-owned Troubleshooter launches, and no automatic Worker replay occurs without an authorized recovery transition.
- **F03:** the first Worker attempt fails; an active Troubleshooter uses the canonical `task.recover` Graph action, the **same** Worker Task retries, and the code successor executes exactly once only after valid output.
- **F04:** the Worker returns exact `{type:"file",path}` artifact records. The adapter converts only those records, and the Graph validates real files and hashes before releasing the successor.
- **F05:** unsupported artifact record types are rejected even when the Worker emits `task.completed`.
- **F06:** the model Worker and initial Code node completed, but a downstream Code node failed. Canonical `task.retry` resumes the **same Job/Task** without replaying either completed node and without resetting the original deadline.
- **F07:** a Graph-authorized parent retry must clear the previous attempt’s terminal failure from the new checkpoint while retaining completed nodes, execution history, and immutable deadline.
- **F08:** legacy Worker file records `{kind:"file",path}` are normalized only with exact keys; realpath containment and SHA-256 remain mandatory before a downstream node can run.
- **F09:** the Worker sees the canonical Run path and may verify approved source manifests and earlier stage files without treating unrelated nodes as declared DAG predecessor outputs.
- **F10:** an untrusted declared canonical Run path that differs from the bound parent Task output directory is refused before a Worker Task is created.

Keep all failure injections green. `npm run test:shortcut:dags` runs the complete fixture/CLI/Worker regression suite. Earlier 2026-11-04 3/5 status is historical; pass claims must always be based on the actual latest command exit code.

The standalone deadline requirement FR-009 / T014 is exercised in core shortcut tests, not a DAG named D06. Full T014 requires cancellation/restart evidence. Real Vlog full-DAG evidence is a separate T015 gate; a synthetic suite cannot replace it. No auto-publish, voice transfer, spending or human approval is permitted by these tests.
