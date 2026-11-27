# Native Rust2 L3 — five-case CLI / Agent Review E2E

This is an **extended L3 verification suite**, independent of the default 10-check quick MVP and the separate CLI Full 12 suite. It executes native Rust2 binaries against independently initialized, disposable Git repositories, isolated SQLite stores and a real isolated Rust daemon. It must never be substituted with the stable Node relayd or a synthetic Model/Worker completion event.

## Cases and actual acceptance boundary

| ID | Scenario | Required independent evidence |
| --- | --- | --- |
| C01 | A Script → B **real Model** → C Script; no Agent Review | Public CLI proves distinct Agent Tasks, Model executor and real provider receipt, each predecessor before successor, artifacts, `COMPLETED` |
| C02 | A/B/C Script Agents each request Review → Approve | Genuine Script subprocess, exact bound `AWAITING_DECISION`, test-owned external Host decision persisted through canonical Graph/SQLite, resume the **same** Task, C gated until B approval, 3 artifacts, terminal Job |
| C03 | B Script → Request Changes → **Model correction** → re-review → Approve | Same Task ID and fresh execution generation, correction artifact and feedback, no repeat of A, C gated until review approval |
| C04 | B real Model → Request Changes → real Model correction → re-review → Approve | Exact same Model Task ID, distinct generations, real provider evidence, C gated |
| C05 | Mixed A Script, B Model: both Request Changes → correction → re-review → Approve | Same immutable Task IDs, two complete review generations, true Model correction, downstream gates and terminal state |

**A synthetic Model is not a PASS.** The `l3_review_host_fixture` binary is only a test-owned *Review Host*, not a live human or production Review Preview. It sends the exact execution-bound test approval through the production Rust HostInvocation Graph/SQLite authorization and resumes the original durable Task. A PASS on C02 therefore proves the native lifecycle with a fixture approval, but is **not** physical UI / live human approval certification.

## Run

From `agents-relay` root:

```sh
cd rust
cargo build --locked -j 2 --bin agents-relayd-rust --bin agents-relay-rust
cargo build --locked -j 2 --example l3_review_host_fixture
AGENTS_RELAY_SCRIPT_NODE="$(command -v node)" cargo test --locked -j 2 \
  --test native_l3_review_wait --test native_script_graph_sqlite \
  --test native_interactive_ports_closure
cd ..
node mvp/rust-l3-e2e.mjs             # all five; nonzero until every case PASS
node mvp/rust-l3-e2e.mjs --case C02  # targeted case, also uses an isolated store
```

The runner uses the native **public CLI**, a real isolated Rust2 daemon and real Script Worker processes. `Job` and `Task` status is read via CLI; no Node Relay internals are imported and the driver never reads/writes SQLite. The test-only Review Host binary accesses its own disposable SQLite using canonical native Graph/HostInvocation ports. Every case owns and stops its daemon. A new `results.json` plus `transcript.json` is written to the printed temporary evidence directory; store a copy under ignored `mvp/runs/` for review.

## Supplemental genuine live C03 E2E (2026-11-22)

A test-only Job710 in an already-authorized native Codex local Git repository genuinely exercised physical iPhone Review v1 Request Changes, real Codex Model correction, second compiled Markcut Preview, physical phone Approve, original Task2207 release and downstream Script C. See `git show c46a90e:docs/RUST2_FULL_E2E_CHECKLIST.md` and saved local ignored evidence mvp/runs/20261122T0908-rust-l3-c03-live/. The post-approval Script fixture initially failed and needed an explicit same-Task retry after fixing the fixture. Thus it proves a functional live review cycle but NOT a strict clean isolated five-case harness PASS. Formal isolated Model-dependent scenarios remain BLOCKED pending genuinely authenticated isolated Codex provider; never substitute live-only receipts for independent isolation.

## Current execution limitations

- `--isolated-write-store-dir` does **not** authorize `adapter=codex`; native Codex currently requires `--live-store-dir`, a trusted Events Bus and repository allowlist. A WebHelm canary config cannot secretly stand in for this distinct Model adapter.
- The runner intentionally declines `--canary-webhelm-*` and `--event-history-api` options; it must not connect to the operator's live EventBus or fake a Model response. Until an explicitly scoped, genuinely authenticated isolated Codex provider is implemented, C01/C03/C04/C05 are **BLOCKED**, even when their observed upstream Script/Review paths passed.
- A `Request Changes` event can legitimately trigger a **Model** correction on a previously Script-owned Task. A missing Codex provider may leave the test Job with a `FAILED` Task after a valid request; classify the provider prerequisite as suite `BLOCKED` while preserving the exact observed Job/Task state in evidence.
- `PASS` is reserved for observed terminal completion and the case-specific durable evidence. A zero-failure summary with BLOCKED cases is **not** a five-case pass. Do not alter the live owner, live Jobs or credentials to force a test green.

## First acceptance: 2026-11-22

Isolated native Rust2 binaries on source branch HEAD `85e9811` plus uncommitted review-fix patch, before commit:

- C01 **BLOCKED**: A Script SUCCEEDED, B Model QUEUED without provider; C not released
- C02 **PASS**: A/B/C real Script Worker subprocesses, three test-owned Review Host approvals on existing durable Task IDs, `COMPLETED`
- C03 **BLOCKED**: Script B correctly requested changes, then real Codex correction was rejected because isolated provider was not configured
- C04 **BLOCKED**: real Model B not configured; C gated
- C05 **BLOCKED**: Script A requested changes, Model correction refused without authorized isolated Codex

Current-source native focused regressions: **48/48 PASS** (3 Interactive Host, 1 review.wait, 5 Script Graph/SQLite, 18 SQLite write-host, 5 CLI Review, 4 generation fencing, 12 Review Store). Native CLI quick smoke **3/3 PASS**. In C02 the test-owned Review Host also submitted a deliberately stale execution ID at each of its three approval boundaries: **3/3 rejected** without prematurely releasing downstream Tasks. Full-five overall: **1 PASS / 0 FAIL / 4 BLOCKED**, not 5/5.

One earlier parallel run observed a transient Darwin `Resource temporarily unavailable (os error 35)` from `review.interactive.begin`; a separate C03 replay reproduced the normal provider BLOCKED outcome. The test-owned Script fixture now performs up to three **execution-fenced** retries only for EAGAIN, before the test Review Host can make any decision. No production POST retry policy was changed; the transient remains an observation to investigate separately if it recurs.

Next gate: implement a secure isolated real Codex provider with explicit allowlist, caller-owned authenticated NATS and verification of real provider events. Then rerun all five and separately check mobile/host Review UI when appropriate.
