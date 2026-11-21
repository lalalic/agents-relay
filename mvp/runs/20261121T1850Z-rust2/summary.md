# Rust2 Relay MVP — physical E2E evidence (2026-11-21)

Execution: canonical `main` checkout; live production native Rust daemon PM2 on port 8787; no Node relayd; no simulator or fabricated SQLite transition. Results here are NOT full four-D MVP passes.

## Relay quick MVP

| Check | Status | Genuine evidence |
| --- | --- | --- |
| CLI 01 create-only Job | PASS | `cli-report.json`; isolated executable CLI session |
| CLI 05 Script A→B→C | PASS | `cli-report.json`; isolated Job 2 and real worker artifacts, dependency/order readback |
| CLI 08 terminal Job readback | PASS | `cli-report.json`; real CLI state `COMPLETED` after isolated Rust daemon restart |
| Dashboard D01 Jobs | PASS | Real WebHelm Chrome Session `7edb8889949ca2ee`, `http://127.0.0.1:8787/`, selected real Job 682 via CSS selector; actual ACTIVE Job shown |
| Dashboard D02 Task detail + events | PASS | Same WebHelm Session: clicked Task 2073; observed state `SUCCEEDED`, worker started, task.completed, `Script Worker completed` |
| Dashboard D03 JEL chart | PASS | Same WebHelm Session: clicked `a[href="#graph-dialog"]`; accessible SVG graphics-document with inspected Task 2072, 2073, 2075, 2076, 2083 nodes, zoom controls; closed chart and released Session |
| Mobile M01 list Jobs | BLOCKED | `iphone-device-preflight.txt`: paired physical iPhone 17 is `unavailable`; no device session opened |
| Mobile M02 list Activities | BLOCKED | Same device unavailable; cannot verify UI |
| Mobile M03 SSE updates | BLOCKED | Same device unavailable; no synthetic SSE claimed |
| Mobile M04 Chat `hello` bubble | BLOCKED | Same device unavailable; no synthetic Chat response claimed |

**Quick MVP result: 6 PASS / 0 FAIL / 4 BLOCKED. Not 10/10.**

## Four real Gate D MVPs

| Case | Genuine current outcome | Job |
| --- | --- | --- |
| D-MVP-1 Calculator happy | FAIL — initial Builder generated and committed real `index.html`, but emitted invalid lowercase `status` and no `output` object; native Graph correctly marked Task FAILED. Fresh clean-seed fixture `calculator-happy-rust2-mvp2-20261121` prepared with strict result contract but not executed. | 683 ACTIVE, Builder 2080 retry QUEUED |
| D-MVP-2 Calculator failure→Troubleshooter | PARTIAL — real Builder failure and genuine recovery Task; no repaired terminal. | 681 ACTIVE, Builder 2070 FAILED, Troubleshooter 2071 QUEUED |
| D-MVP-3 DAG with Shortcuts | PARTIAL — genuine A/B/C SUCCEEDED, independent Final Review required real corrections, generated implementation Task; no terminal Job. | 682 ACTIVE, implementation 2083 retry QUEUED |
| D-MVP-4 DAG without Shortcuts | PARTIAL — real Model A produced stage artifact and correctly-shaped DAG receipt; actual Codex rate-limit failure triggered Graph reroute and second run; full A→B→C and Final Review remain unverified. | 684 ACTIVE, Model A 2082 RUNNING attempt 2 |

Authoritative status snapshots: `job-681-cli.json` to `job-684-cli.json`. These are **CLI readbacks**, not direct SQLite edits. Provider `glm-5.3-flash` returned `rate limit exceeded`, reset scheduled for 2026-11-22 07:32:55; Router selected another provider for some retries. No provider usage-limit bypass or false PASS.

## Rust native work and regression

- Native non-browser Codex Worker lease/process ownership with explicit repository allowlist, actual Events Bus terminal verification, SQLite outbox, and no Codex exit = success false positive.
- Rust-owned Codex prompt now resolves canonical Agent, Task, and Events contract before provider dispatch; regression checks exact Event source binding, `task.started`, `task.progress`, `task.completed`, and false-positive rejection.
- Original regression: Codex 2/2; SQLite 18/18; NATS 6/6; native daemon 23/23; library 101/101; daemon build successful (150 tests).
- New prompt regression: Codex 3/3; SQLite 18/18; NATS 6/6; library 101/101; daemon build successful. See `native-codex-regression.log`. Separate native daemon **23/23 PASS** and latest quick CLI **3/3 PASS** on the final rebuilt Rust binary (see `native-daemon-23pass.log` and `cli-report.json`).
- PM2 process was restarted earlier with the first native Codex port and bounded repository allowlist. The **subsequently patched managed-prompt binary is compiled but not live-restarted** because existing real model Workers have active leases: do not kill unrelated or in-flight processes to force deployment.

## Reproduction / policy

- CLI test: `node mvp/cli-mvp-e2e.mjs --keep`
- Live state readback: `rust/target/debug/agents-relay-rust job show --repo <repo> --id <job> --port 8787`
- Dashboard: WebHelm Session start → navigate `http://127.0.0.1:8787/` → select Job 682 → Task 2073 → JEL → close/stop only owned Session.
- Physical phone gate: `xcrun devicectl list devices`; never substitute iOS simulator, historical screenshots, or unauthenticated bridge.

No source-only changes to the stable Node Relay daemon were made; no terminal state was written manually; unrelated Jobs, runtime, and Sessions were preserved.
