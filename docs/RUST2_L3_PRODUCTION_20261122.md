# Rust Relay L3 production acceptance — 2026-11-22

## Environment and policy

This is a **LIVE production-environment** validation, NOT an isolated daemon or fixture Model-provider run. Only PM2 agents-relay/daemon, native Rust agents-relayd-rust on port 8787, owns production Graph/SQLite. Do not start a Node.js relayd. Model Workers were actual Codex in workspace-write sandbox and were restricted to previously allowlisted, **test-only** local Git repository rust2-model-d-e2e-mvp5-20261121. Human decisions were issued on the paired physical iPhone 17 via iPhoneHelm, using Neo Mobile Review against genuine Neo Markcut Preview requests. No simulator, mocked Model, fake EventBus terminal, or manually inserted decision was used.

## Results — actual production L3 functionality

| Case | Job | Real actors | Durable result | Acceptance qualification |
|---|---:|---|---|---|
| C03 | 710 | Script A → phone Request Changes → authentic Codex Model correction on same Task B → second phone Approve → Script B → Script C | Coordinator 2205, A 2206, B 2207, C 2209 SUCCEEDED | FUNCTIONAL PASS after fixing test-only Script post-approval assumption and explicitly retrying Task 2207; not first-attempt clean |
| C04 | 711 | Script A → real Codex Model B initial Preview → phone Request Changes → Codex revised Preview → phone Approve → genuine Model terminal → Script C | Coordinator 2210, A 2211, Model B 2212, C 2215 SUCCEEDED | FUNCTIONAL PASS after real Neo CLI EAGAIN caused a Preview delivery failure; rebound on fresh execution and approved; not first-attempt clean |
| C05 | 712 | Script A Review → phone Request Changes → real Codex correction of A → phone Approve → independent real Codex Model B Review → independent phone Approve → genuine Model terminal → Script C | Coordinator 2213, A 2214, Model B 2216, C 2217 SUCCEEDED | FUNCTIONAL PASS after an undelivered premature Model A Review was failed and a test-only Script recovery restored a previously genuine Codex correction; Model B fixed an events-bus executable PATH issue before successful terminal. Not first-attempt clean |

**All three real production feature paths passed with recovered failures.** Do NOT replace that precise wording with a clean, no-manual-retry 3/3 pass. The official isolated rust-l3-e2e.mjs suite remains historically blocked on an unrelated isolated Codex provider precondition, but was **not used to verify these production scenarios** as explicitly requested.

Every Job reached **ACTIVE / MERGE_PENDING** with all DAG tasks and Coordinator SUCCEEDED; this was deliberately configured using no-auto-merge. After capturing immutable snapshots and event histories, only these disposable Jobs were CANCELLED for cleanup; already successful Task histories were preserved. The production daemon, Node.js shutdown, unrelated Jobs and original Git projects were not changed.

## Evidence — captured before test Job cancellation

- C03: mvp/runs/20261122T0908-rust-l3-c03-live/ — Job710, real Task2207 receipts (changes_requested and approved), genuine Model correction, Script A/B/C and Coordinator results.
- C04: mvp/runs/20261122T0936-rust-c04-production/ — Job711 and 36 Model B events, both physical phone decisions, initial and corrected Markcut, approved Model B output and downstream Script C.
- C05: mvp/runs/20261122T0945-rust-c05-production/ — Job712, 12 A events, 20 Model B events, real A Review changes and approval, independent B approval, real Model terminal, Script C and explicit manual recovery receipt.

The artifact directories are local ignored test evidence; this document is versioned so the result and limitations are durable. All tests used a previously authorized test Git repo; the fixture modifications were local commits only and do not change Node relayd or production Rust source.

## Follow-ups (separate production-hardening acceptance)

1. Run C03–C05 again with **zero manual fixture or Preview-delivery recovery** to prove repeatable unattended execution. Codex agent instructions must wait for true Preview delivery, not merely call Review wait.
2. Repair transient Neo-to-Relay CLI EAGAIN binding and events-bus CLI PATH resolution with source-level regression tests, then rerun real phone Review cases.
3. Validate independent Final Reviewer, rollback, multi-node ownership/fencing and other production gates before setting productionReady=true. An L3 feature-path pass is not all-gates production signoff.
