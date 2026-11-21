# Autonomous Rust2 MVP continuation — 2026-11-21

User request: after current work, create new ChatGPT thread and run Relay MVP autonomously until all pass using real test→fix→retest. The user explicitly approves implementation changes for this iteration, overriding the canonical MVP skill's default testing-only mode for this request.

## Mandatory setup
- Run neo bootstrap ONCE in the new ChatGPT thread; follow AGENTS.md / XChat.
- Repo: /Users/chengli/Workspace/agents-relay , branch main. Preserve existing dirty Rust edits; do NOT create another worktree.
- Relay implementation fixes: Rust source/tests ONLY. Do NOT change stable Node.js Relay implementation. Docs, MVP checklists/harness allowed.
- Node relayd must stay OFF. The sole live service is native Rust PM2 agents-relay/daemon at 127.0.0.1:8787, canonical SQLite ~/.agents-relay/relay.sqlite. Never create competing production writer.
- WebHelm *Model Browser Worker* Gate C is DEFERRED per user. Dashboard MVP still uses WebHelm Chrome, and Mobile MVP uses physical iPhone with iPhoneHelm (NO simulator).
- Never fake lifecycle events, write SQLite to force success, count HTTP200/CLI exit0 as completed Task, or retry uncertain Browser sends.

## First finish four real Project Runner D MVPs
1. Calculator happy path: real fresh seed ae2f833, no failed Tasks, real index.html, browser QA, Final Review, Job COMPLETED.
2. Calculator failure path: genuine failed Builder → genuine Troubleshooter → corrected implementation, QA, Final Review, Job COMPLETED with failure lineage.
3. Project Runner DAG with .shortcut scripts: actual A→B→C + review + Job COMPLETED.
4. Project Runner DAG without shortcuts: actual native non-browser Model Worker + outputs + review + Job COMPLETED.
All require separate real Job IDs, Graph Task/Review/event receipts, actual artifact and Git HEAD readback. Record in docs/RUST2_FULL_E2E_CHECKLIST.md.

## Then run canonical Relay MVP: 10/10
- Read mvp/SKILL.md, mvp/README.md, mvp/cli-mvp-e2e.mjs, mvp/checklists/{dashboard-webhelm,neo-mobile-iphonehelm}.md and both mvp/agents/*.agent.md.
- 3 CLI smoke + 3 Dashboard (WebHelm) + 4 Neo Mobile (physical iPhoneHelm). Save results in mvp/runs/<timestamp>/results.json and summary.md.
- Test→fix Rust→retest repeatedly until ALL 10 PASS. User explicitly authorized autonomous repair. No opt-in extended 12 CLI tests unless useful to diagnose failures.

## Live facts as of handoff (reverify)
- Native Rust PM2 online at 8787, runtime=native-rust/live-write, 472 Jobs, Node relayd stopped.
- Job 681 Calculator ACTIVE, Coordinator 2069 RUNNING, Builder 2070 FAILED, Troubleshooter 2071 QUEUED (not successful).
- Job 682 Script A→B→C: Coordinator 2072, A 2073, B 2075, C 2076 all SUCCEEDED; reviewer 2077 FAILED (unsupported native Codex), Troubleshooter 2078 QUEUED, whole Job ACTIVE. Real Script Task events are available via Rust Mobile Activity API.
- Prepared clean calculator happy-path fixture: /Users/chengli/Workspace/neo/calculator-happy-rust2-mvp-20261121 ; seeded from ae2f833, NO index.html, Project Runner dry-run PASS, not yet started.
- Existing calculator fixture /Users/chengli/Workspace/neo/calculator-rust2-e2e-20261121 ; script DAG /Users/chengli/Workspace/neo/rust2-script-d-e2e-20261121.
- An independent model DAG fixture /Users/chengli/Workspace/neo/rust2-model-d-e2e-20261121 was being prepared and might not exist; check first.
- Latest committed Rust Graph event publication to NATS: 555cd93; MVP kit commit bc9a6ce may now be latest HEAD. Do not reset/lose newer commits.

## Canonical DIRTY Rust work — PRESERVE
- rust/src/native_codex_execution.rs (new): native Codex exec JSONL with owned PID/lease and exact Graph terminal fencing. Native test fake Codex exit0 must NOT fake Task success.
- rust/tests/native_codex_worker.rs (new): 2/2 targeted tests PASS.
- rust/src/relayd_sqlite_write.rs: native Codex Worker allowlist and claim/route/recovery; durable external Script task outbox replay to authenticated NATS and fast scheduler wake.
- rust/src/relayd.rs: live outbox flush in daemon tick.
- rust/src/bin/agents-relayd-rust.rs: fail-closed explicit Model Worker executable/Repo allowlist CLI or PM2 env: AGENTS_RELAY_LIVE_CODEX_EXECUTABLE and AGENTS_RELAY_LIVE_CODEX_REPOSITORIES.
- rust/src/lib.rs: module registration; rust/tests/native_sqlite_write_host.rs: real NATS publication/dedup regression; docs/RUST2_FULL_E2E_CHECKLIST.md: four MVP criteria and evidence.
- DO NOT commit source as production-ready until real test outcomes confirmed. Do not overwrite existing dirty changes.

## In-flight regression
- Neo shell job d1dc57907d8589c3; log /tmp/r2-codex-mvp-regression.log. At handoff: native Codex 2/2 PASS, SQLite 18/18 PASS, NATS 6/6 PASS; remaining daemon tests, library 101 and binary build still running. Poll exact job, not another concurrent Cargo build.
- Prior logs /tmp/r2-codex-fake-owned.log and /tmp/r2-script-outbox-test.log, plus /tmp/rust2-D-*.

## Immediate next action
1. Poll regression, fix Rust-only failures, ensure new native Model route is real and lease/terminal safe.
2. Rebuild, preserve backup, restart ONLY native Rust PM2 with narrow test repos Codex allowlist. Do not touch unrelated project jobs.
3. Officially retry reviewer 2077 and proceed Job 682; then run happy Calculator, Troubleshooter Calculator and no-Shortcut DAG.
4. Once four D MVPs pass, run 10-check quick Relay MVP autonomously as user instructed, fix Rust-only, rerun and save receipts.
5. Update checklist; commit/push/live/clean only after actual independent acceptance. If blocked, report exact remaining gates and preserve work.
