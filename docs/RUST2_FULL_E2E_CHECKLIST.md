# Rust2 Relay — full E2E acceptance checklist

**Purpose:** certify actual native Rust2 from Job creation to terminal Graph/SQLite, Script and browser Model Workers, Events Bus, Dashboard, Neo Mobile on a **real iPhone**, and eventually three-node live deployment. This file defines **future acceptance gates**; it does not claim that tests were run.

**Canonical requirements:** [AGENTS.md](../AGENTS.md), [DESIGN-PRINCIPLES.md](../DESIGN-PRINCIPLES.md), [Rust2 handoff](RUST2_NEXT_AGENT_HANDOFF_20261119.md), [migration ledger](RUST2_HEAD_TO_HEAD_CHECKLIST.md), [browser pool](BROWSER_WORKER_POOL.md).

**Current baseline (2026-11-21):** 222 PASS / 2 PORTING / 0 PENDING / 7 EXCLUDED. Remaining modules: src/reconciler-runtime.ts and src/relayd.ts. Prior real ChatGPT WebHelm canary **failed** to return a durable thread ID; real Worker start/terminal was not verified. The existing Rust daemon announces an **isolated preview only** and does not support production Workers/live state. Therefore a production cutover is **blocked** independently of passing isolated tests.

## Rules and evidence

- Use one pinned Git SHA, isolated per-run SQLite and temporary canonical Git project roots until the explicitly authorized live cutover. **Node stays sole production owner** throughout all preview/canary gates.
- For each box record PASS / FAIL / BLOCKED / NOT_RUN, date, commit SHA, exact command + exit, event/job/task/execution IDs, before/after Graph/SQLite facts, logs, and UI evidence in a redacted test-owned run directory (for example /tmp/rust2-e2e-RUN_ID/). A mock, delivery receipt, HTTP 200, spinner or manually inserted event **cannot** prove real Task completion.
- Do not modify production Relay SQLite, the three pre-existing untracked root relay.sqlite* files, live Node configuration, another WebHelm Session, or another node's services during isolation. Stop only test-owned daemons, browser Sessions and processes.
- Immediate NO-GO on dual production writers, duplicate browser sends, missing correlated terminal, forged cross-repo state, lease corruption, lost Events Bus delivery or unverifiable rollback.
- Require independent review of Graph-owned policy vs effects. SQLite is authoritative for lifecycle, not GitHub, EventBus messages or browser output.

## Gate A — baseline / code / regression

- [ ] A1. Pin rust2 build SHA; refresh main/origin main; confirm no unmerged Node changes; verify dirty worktrees, current live Node owner and installed native service path.
- [ ] A2. Record read-only live inventory: canonical SQLite path, Job/Task/Review/lease counts, Node health, worker slots, broker endpoints and provider readiness. Take no action on active production Jobs.
- [ ] A3. Run npm run build; cargo build --manifest-path rust/Cargo.toml --bins; record compiler versions, binary hashes and exit codes.
- [ ] A4. Run node scripts/rust2-checklist-verify.mjs and node scripts/rust2-api-parity-audit.mjs --check --json. Every claimed PASS export must map to native Rust; no pending main changes.
- [ ] A5. Run npm run test:full and cargo test --manifest-path rust/Cargo.toml --all-targets, **only with a fresh AGENTS_RELAY_STORE_DIR and explicit AGENTS_RELAY_SCRIPT_NODE**, after checking test side effects. Report all skips/fails, not just a summary.
- [ ] A6. Run npm run test:verification:l1, npm run test:verification:l2, npm run test:verification:l3 and npm run test:l3:dag; verify Graph branch decisions, real CLI bindings, canonical 3-Agent DAG, review and ownership.
- [ ] A7. Run native daemon, CLI, Dashboard, browser worker pool, NATS/Events Bus, Graph/SQLite and process lifecycle suites plus Node/Rust head-to-head tests at this exact SHA.

## Gate B — live read-only shadow (Node remains owner)

- [ ] B1. Launch Rust only through --shadow-live-store-dir on a separate port; verify shadow-live-read-only mode and productionReady=false.
- [ ] B2. Compare complete Job inventory and scoped snapshot fields to live Node/SQLite, including large Jobs and Task/Review/publication details. Previous 60/60 sampled field checks are **not** exhaustive full-record parity.
- [ ] B3. Verify native Dashboard static HTTP/PWA, Job list/pagination, exact Job, SSE and /api/mobile/* read endpoints, including concurrent large responses.
- [ ] B4. Prove all attempted shadow mutations fail closed; unchanged live SQLite, outbox, leases and worker count before/after.
- [ ] B5. Stop/restart only owned shadow; no broker subscription, Worker invocation, side effects, lingering port or Node ownership change.

## Gate B-Dashboard — actual Dashboard read-only verification (**must PASS before Gate C**)

This is a **separate user-visible gate**, beyond Gate B's SQLite/HTTP shadow comparison. Perform it using a real browser against Rust's read-only shadow while Node remains the sole live owner. Never enable writes or attach Model/Events Bus to the shadow.

- [ ] BD1. Open the actual Rust2 Dashboard on an isolated port in a real desktop browser and mobile-sized browser viewport (at least 375 px), including the intended authenticated same-origin/proxy URL. Confirm assets, navigation, relative URLs and authentication behavior; save screenshots.
- [ ] BD2. Compare visible Jobs, scoped repository identity, pagination, Task details, activity timeline, JEL/Graph and available Review previews to the live Node Dashboard and canonical SQLite. Verify a large Job, running/failed/terminal Jobs and empty/no-review cases without exposing unrelated projects.
- [ ] BD3. Verify HTTP GET/read-only API parity plus SSE/live-refresh behavior: stream remains connected, changes are observed only when committed by the **Node owner**, and no synthetic worker/terminal events are produced.
- [ ] BD4. Prove all write controls are unavailable or rejected (create, cancel, retry, approve/reject review, edits); exercise denied HTTP mutations and show before/after live Job/Task/lease/outbox state is unchanged by Rust shadow.
- [ ] BD5. Verify 401/403, invalid Job ID, cross-repository identity, missing Review and large-response framing cases; no private data leaks or truncated responses. Capture browser network evidence and HTTP status codes, not screenshots alone.
- [ ] BD6. Repeat after shadow restart; verify no lingering process/port/worker/broker sessions. Attach one independent Dashboard read-only PASS/FAIL report before permitting Gate C.

## Gate C — real WebHelm + Model + Events Bus in isolated writable Rust (**currently blocked**)

- [ ] C1. Prepare unique disposable Git/SQLite, Job ID absent from live, test-only WebHelm Rust2Canary workspace/session, separate port, verified broker namespace and authorized event ingestion.
- [ ] C2. Run python3 rust/tests/real_webhelm_canary_e2e.py --execute in explicit opt-in mode. Capture actual browser Thread URL/ID, output, graph/outbox evidence and exit. Never turn a failed provider attempt into a fake success.
- [ ] C3. Resolve the known ChatGPT durable Thread-ID failure after Send; prove exactly one real submission. If WebHelm actions change, run all three real platform MVPs: new thread, direct new turn, and two queued turns in same thread.
- [ ] C4. Observe **genuine correlated** task.started then task.completed (and independently task.failed for a negative test) with exact Job/Task/execution/generation/source from Events Bus into Graph-approved SQLite rows and durable outbox, not just an action receipt.
- [ ] C5. Verify recovery in the original Thread, deduped event replay, uncertain-submit quarantine and no automatic resend or false heartbeat progress.
- [ ] C6. Exercise actual Z.ai provider as well **if production routing supports Z.ai**; verify provider-specific durable Thread identity and exact terminal. If native adapter not available, mark BLOCKED and record gap.
- [ ] C7. Close only owned WebHelm session/pool slot, terminate test-owned Rust daemon, prove original live Node Job/SQLite untouched.

## Gate D — native end-to-end Job lifecycle in isolated store

For every case save real CLI/API input, Graph transition sequence, authoritative Job/Task/Review state, Script/Model execution evidence, and final readback.

- [ ] D1. Native CLI job create --initial-plan → Planner → executable Plan → real Worker → Final Review → COMPLETED. Separately prove create-only zero-Task Job stays idle.
- [ ] D2. CLI, HTTP, Dashboard and incoming broker signals produce the **same canonical Graph transitions**; no covert Node fallback or duplicate workflow policy.
- [ ] D3. Script Worker creates a verifiable isolated file artifact, commits its result and terminates owned process group.
- [ ] D4. Real Model Worker reads pinned Agent/Skill/task context and produces observable output with real correlated terminal events.
- [ ] D5. Three Agent Tasks A → B → C run in strict dependency order under one Coordinator, plus parallel branch/capacity starvation/resume.
- [ ] D6. Review modes: no review; all approvals; request changes with revision shortcut; request changes without shortcut. Confirm re-review, Final Review and proper child lineage.
- [ ] D7. Test failure → bounded retry → success; exhausted failure; cancel running Script/Model Task; correct leases/session cleanup, no false success.
- [ ] D8. Local Git is source of truth for Final Review/merge; Job completes without GitHub. Optional origin push only **after** verified completion; remote failures never reopen the Job.

## Gate D-ProjectRunner — real Project Runner calculator Job (**must PASS after D, before E**)

Use the **existing calculator acceptance project** at `/Users/chengli/Workspace/html-calculator-rust-relay` and its source-of-truth `job-objective.md` / `AGENTS.md`. The current repository already contains a calculator produced by an earlier Rust Worker run; its `qa/verification.md` records `jobId=91`, Model Task `101` and Script QA Task `102` as successful **but the Job remained ACTIVE pending Final Review**. This is prior partial evidence, **not** a Project Runner PASS.

- [ ] DPR1. Create a **new disposable local Git clone/worktree** from the project's clean **seed commit `ae2f833`** (which has no `index.html`), with an independent Rust2 Job store, unique Job ID and dedicated worker namespace. Do not overwrite the existing calculator implementation or claim previous Job `91`.
- [ ] DPR2. Invoke the **actual installed Project Runner entry point** to create/start a real Rust-owned Relay Job whose `projectRoot` is that seed clone and whose objective is the calculator project's `job-objective.md`. Record the exact entry point/CLI command, resulting Job ID, Coordinator/Planner/Worker Task IDs and original Git HEAD. Do not manually seed fabricated success rows or bypass the Project Runner using ad hoc direct Worker calls.
- [ ] DPR3. Verify the Project Runner drives the canonical workflow: create → Coordinator/Planner → review/approved Plan → implementation Worker → independent QA/Final Reviewer → terminal Job; no TypeScript Scheduler or duplicate ownership.
- [ ] DPR4. Require the assigned Worker to **generate `index.html` during this new Job** (not pre-existing): one offline, dependency-free, accessible responsive calculator with decimal handling, keyboard/pointer, error reset, focus and no tracking. Capture file diff, Worker provenance and immutable resulting Git commit.
- [ ] DPR5. Run actual browser QA on desktop and 320/375/430 px viewports: `0.1 + 0.2 = 0.3`, `9 ÷ 3 = 3`, `8 × 7 = 56`, division by zero error/reset, `123 → 12` Backspace, clear, `7+2 Enter → 9`, Escape, negative/chained arithmetic, accessible labels and no horizontal overflow. Record screenshots, interactions and exact pass/fail.
- [ ] DPR6. Independent Final Reviewer verifies code, true Git HEAD, actual browser evidence and objective. If review requests changes, require a **real revision Job/Task and re-review**, not a manual approval or an artificially completed Task.
- [ ] DPR7. Read back **Job COMPLETED** (not merely Worker/QA Tasks SUCCEEDED), every Task's terminal state, correlated Events Bus source, Graph/SQLite generation/lease/outbox, Job duration and a clean local Git history. The previous `jobId=91` ACTIVE result must never count as this gate's completion.
- [ ] DPR8. Stop only test-owned runner/worker/browser processes, validate isolated SQLite and Git artifacts persist as evidence, and confirm the original calculator repository, production Node Relay and unrelated Jobs were untouched. Failure to reach independently reviewed **Job** terminal is **BLOCKED/FAIL**, not PASS.

## Gate E — transport, restart, ownership and adversarial safety

- [ ] E1. Persist unique correlated started/progress/completed/failed and outbox receipts; reject duplicate, out-of-order and forged model-worker events.
- [ ] E2. Kill/restart test-owned Rust during queued, running, review-wait and terminal reconciliation. Verify generation fencing, durable leases, exact-once effects and convergence.
- [ ] E3. Bounce a **test-owned** authenticated Events Bus broker; verify durable replay, recovery and no invented started/terminal; validate **intended production transport/security**, not solely loopback-token fixture.
- [ ] E4. Model provider reject before submit may retry safely; uncertainty after send must quarantine without duplicate or released slot.
- [ ] E5. Run multiple Jobs/Workers with capacity, FIFO, backpressure and timeout; never starve or exceed leases.
- [ ] E6. Reject cross-repo Job-ID collision, stale execution/generation, invalid task event, oversized mobile cancellation, unauthorized write and stale review decision.
- [ ] E7. Confirm no orphan child processes, leaked WebHelm tabs, unowned broker subscriptions, corrupt SQLite/WAL or duplicate side effects.

## Gate F — actual Neo UI and three nodes

- [ ] F1. Neo Master authenticated same-origin Dashboard/PWA: Jobs, activities, status, JEL, SSE and Refresh reconcile with persisted SQLite.
- [ ] F2. **Real iPhone only, no simulator**, using neo-use: Neo Mobile Jobs pagination/search, Task detail, activities and terminal refresh with unique scoped IDs.
- [ ] F3. Generate an actual test Review; on real iPhone inspect preview, approve and request changes; verify exact current execution/invocation and stale-decision rejection.
- [ ] F4. From real iPhone cancel one **isolated test Job**; verify unique repo/ID guard, Graph cancellation and authoritative CANCELLED readback.
- [ ] F5. Check mobile event notifications and message updates; no duplicate or premature terminal UI from intermediate events.
- [ ] F6. Run isolated real Worker registration, routing, start/terminal, node heartbeat and reconnection checks on Neo Master → home98 → Worknode, one node at a time.
- [ ] F7. Disconnect a test secondary node mid-Task; verify safe lease fencing/recovery and no duplicate browser submission, then reconnect and clean up.

## Gate G — production readiness, controlled live cutover, rollback (**currently blocked**)

**G1 is a prerequisite.** Native agents-relayd-rust currently exposes isolated preview modes only; none of the preceding test modes authorizes production use. Gates A, B, B-Dashboard, C, D, D-ProjectRunner, E and F must all be PASS before proceeding.

- [ ] G1. Implement/review safe production single-owner writable Rust startup, credentials, launchd service path, broker durability/security and health/productionReady reporting; no repurposed isolated-canary flags.
- [ ] G2. Prove a consistent SQLite/WAL/outbox/lease backup can be restored on a disposable host; document exact safe rollback and Node/Rust ownership fencing.
- [ ] G3. Safely park/drain active Node leases/sessions and prevent its automatic restart; verify **exactly one** production writer/claimer before Rust touches canonical store.
- [ ] G4. Start Rust2 as only production owner on Neo Master. Reconcile pre/post state and worker ownership with the baseline; immediately rollback on mismatch.
- [ ] G5. Run a harmless, expressly authorized real production Job through Planner/Coordinator/Worker → verified Events Bus → Graph/SQLite terminal → Dashboard + real iPhone.
- [ ] G6. Restart Rust owner and reconnect broker in a controlled window; verify no duplicate submissions, orphan sessions, lost events or unrecovered leases. Measure against the recorded Node baseline.
- [ ] G7. Exercise rollback first on test/staging and verify Node resumes as unique owner with correct durable facts, active work and endpoints; only attempt production rollback when authorized/necessary.
- [ ] G8. After live Neo Master acceptance, upgrade home98 and Worknode **one at a time**, checking smoke, model/Script Tasks, broker and rollback. Remove Node implementation only after sustained verified operation.

## Gate sign-off

| Gate | Current status | Evidence/run ID | Reviewer |
| --- | --- | --- | --- |
| A — baseline/regression | NOT_RUN | | |
| B — read-only shadow | NOT_RUN (previous partial sample exists) | | |
| B-Dashboard — actual read-only browser verification | NOT_RUN; **required before C** | | |
| C — actual browser provider/Events Bus | **BLOCKED**: durable Thread ID | | |
| D — full native Job lifecycle | NOT_RUN | | |
| D-ProjectRunner — calculator Job + independent Final Review | NOT_RUN; **required after D** | | |
| E — durability/negative tests | NOT_RUN | | |
| F — real iPhone/three nodes | NOT_RUN | | |
| G — production cutover/rollback | **BLOCKED**: native production startup | | |

**Definition of DONE:** all **nine** gates (A, B, B-Dashboard, C, D, D-ProjectRunner, E, F and G) PASS at a reviewed and identified build SHA; real external provider + correlated terminal; a **new calculator Project Runner Job independently reviewed and COMPLETED**; real iPhone UI; exclusive production ownership; proven rollback; original Node state preserved. Only then reconsider upgrading src/reconciler-runtime.ts and src/relayd.ts from PORTING to PASS and declare PORTING=0.
