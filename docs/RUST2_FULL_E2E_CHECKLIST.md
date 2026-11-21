# Rust2 Relay — full E2E acceptance checklist

**Purpose:** certify actual native Rust2 from Job creation to terminal Graph/SQLite, Script and browser Model Workers, Events Bus, Dashboard, Neo Mobile on a **real iPhone**, and eventually three-node live deployment. This file defines **future acceptance gates**; it does not claim that tests were run.

**Canonical requirements:** [AGENTS.md](../AGENTS.md), [DESIGN-PRINCIPLES.md](../DESIGN-PRINCIPLES.md), [Rust2 handoff](RUST2_NEXT_AGENT_HANDOFF_20261119.md), [migration ledger](RUST2_HEAD_TO_HEAD_CHECKLIST.md), [browser pool](BROWSER_WORKER_POOL.md).

**Verified status (2026-11-21, live main):** migration ledger **222 PASS / 2 PORTING / 0 PENDING / 7 EXCLUDED** (src/reconciler-runtime.ts, src/relayd.ts). Native Rust has replaced Node relayd under PM2 on port 8787, with 471 durable SQLite Jobs and a healthy exclusive owner; **productionReady=false** because real Model Worker terminal provenance, full Project Runner, rollback and multi-node gates remain unverified. Live cutover is an accomplished substep **not a Gate G PASS**. The real WebHelm ChatGPT canary previously failed to verify a durable Thread ID after Send; do not retry uncertain submission. See dated execution status below.

## Rules and evidence

- Use one pinned Git SHA, isolated per-run SQLite and temporary canonical Git project roots until the explicitly authorized live cutover. **Node was sole production owner for the historical shadow/canary runs; Rust is now sole live owner**. Subsequent isolation runs must not make Node a competing owner.
- For each box record PASS / FAIL / BLOCKED / NOT_RUN, date, commit SHA, exact command + exit, event/job/task/execution IDs, before/after Graph/SQLite facts, logs, and UI evidence in a redacted test-owned run directory (for example /tmp/rust2-e2e-RUN_ID/). A mock, delivery receipt, HTTP 200, spinner or manually inserted event **cannot** prove real Task completion.
- Do not modify production Relay SQLite except via the authorized, single live Rust Graph service; preserve the three pre-existing untracked root relay.sqlite* files, all unrelated WebHelm sessions, and other nodes' services during isolation. Stop only test-owned daemons, browser Sessions and processes.
- Immediate NO-GO on dual production writers, duplicate browser sends, missing correlated terminal, forged cross-repo state, lease corruption, lost Events Bus delivery or unverifiable rollback.
- Require independent review of Graph-owned policy vs effects. SQLite is authoritative for lifecycle, not GitHub, EventBus messages or browser output.

## Gate A — cutover baseline and critical regressions (**PASS — scoped acceptance**)

A is the pre-cutover **build, compatibility and critical regression gate**, not the container for every L1/L2/L3, all-targets, stress, mobile and real-provider E2E. Those exhaustive suites stay mandatory under D/E/F and final G, where a failure still prevents overall certification.

- [x] A1. Pin local `main` Rust2 source SHA and verify Node/Rust changes, dirty files, PM2 owner and native service executable. Historical Node changes were incorporated before live cutover; Rust is now sole configured PM2 owner.
- [x] A2. Inspect canonical SQLite (469 historical Jobs at cutover), active work/lease inventory, provider and broker endpoints; capture consistent WAL-compatible backup before replacing Node.
- [x] A3. Build the Node baseline and native Rust executable; verify native Rust startup from restored production SQLite and actual PM2 status. `npm run build` and native `cargo build` previously succeeded.
- [x] A4. Run migration ledger and API mapping audit: **222 PASS / 2 PORTING / 0 PENDING / 7 EXCLUDED**, 0 unmapped runtime exports; `PORTING` is tracked as part of full E2E, not a build blocker.
- [x] A5. Pass the critical regression suites **at the tested implementation**: Rust library **101/101**, native daemon **23/23**, native SQLite writer **16/16**, one-time migration **5/5**, and focused CLI/Browser Pool regressions. Record the tested SHA(s), and revalidate affected areas after later code changes.
- [x] A6. Verify native CLI/Graph/SQLite and browser-runtime Node/Rust differential contracts in the existing tests, with no production Node fallback.
- [x] A7. Record the extended suites as follow-on **mandatory** tests rather than prerequisites for basic baseline acceptance: complete `cargo test --all-targets`, `npm run test:full`, L1/L2/L3 and DAG scenarios must still pass under D/E before full certification; some earlier broad runs failed and are **not counted as PASS**.

**Gate A result: PASS for cutover baseline**, not a claim that the entire Rust implementation or all regression suites pass. Reviewed 2026-11-21, source evidence through local commit `23a36de`. Current checklist-only revision does not alter executable code.

## Gate B — production-store read-only parity and write isolation (**PASS — historical shadow gate**)

B is the completed **Node-vs-Rust shadow cutover parity check**, not an all-field audit of every historical Job (that expansion was not needed to decide safe read-only equivalence). Node is now stopped and the shadow was removed at the user's direction; do **not** restart shadow to re-prove this historical gate.

- [x] B1. Run Rust shadow against the exact canonical production SQLite on separate port `8788`; verify `shadow-live-read-only`, `productionReady=false`, Node remains sole writer during comparison.
- [x] B2. Match all **469 discovered Job identities/count**, and compare **60/60** representative Node/Rust Job fields including large records (plus a later independent **40/40** sample). This is **sampled field parity**, not 469/469 deep-object equivalence.
- [x] B3. Verify native Dashboard page/static HTTP, Job lookup/list and large JSON responses against Node at separate ports. Browser, auth, full SSE, pagination, Review and mobile endpoint UX receive their **own B-Dashboard/F gates**.
- [x] B4. Test shadow mutation denial (HTTP `POST` returns `405` after Rust-only guard fix), and verify live SQLite/history/leases unchanged through shadow tests.
- [x] B5. Stop the isolated shadow; confirm Node remained live through historical comparison and the shadow never launched a Worker or Events Bus writer.

**Gate B result: PASS for read-only cutover parity**, based on completed 2026-11-21 shadow evidence. Remaining exhaustive API/UX cases are explicitly still required under B-Dashboard/F and final G; no inference that the real Worker path works.

## Gate B-Dashboard — actual Dashboard read-only verification (**independent of Gate D**)

This is a **separate user-visible gate**, beyond Gate B's SQLite/HTTP shadow comparison. The read-only shadow was exercised historically with Node as owner; a production Rust Dashboard browser check has also been performed. Those are distinct evidence sets and neither silently upgrades the full historical gate to PASS.

- [ ] BD1. Open the actual Rust2 Dashboard on an isolated port in a real desktop browser and mobile-sized browser viewport (at least 375 px), including the intended authenticated same-origin/proxy URL. Confirm assets, navigation, relative URLs and authentication behavior; save screenshots.
- [ ] BD2. Compare visible Jobs, scoped repository identity, pagination, Task details, activity timeline, JEL/Graph and available Review previews to the live Node Dashboard and canonical SQLite. Verify a large Job, running/failed/terminal Jobs and empty/no-review cases without exposing unrelated projects.
- [ ] BD3. Verify HTTP GET/read-only API parity plus SSE/live-refresh behavior: stream remains connected, changes are observed only when committed by the **Node owner**, and no synthetic worker/terminal events are produced.
- [ ] BD4. Prove all write controls are unavailable or rejected (create, cancel, retry, approve/reject review, edits); exercise denied HTTP mutations and show before/after live Job/Task/lease/outbox state is unchanged by Rust shadow.
- [ ] BD5. Verify 401/403, invalid Job ID, cross-repository identity, missing Review and large-response framing cases; no private data leaks or truncated responses. Capture browser network evidence and HTTP status codes, not screenshots alone.
- [ ] BD6. Repeat after shadow restart; verify no lingering process/port/worker/broker sessions. Attach one independent Dashboard read-only PASS/FAIL report before permitting Gate C.

### BD — Neo Mobile Tasks / Activities actual endpoint comparison, 2026-11-21

- **Endpoint routing PASS**: Neo Mobile Swift uses authenticated \`/relay/api/mobile/jobs\`, \`/relay/api/mobile/job-tasks?id=...&repo=...\`, and \`/relay/api/mobile/job-activity?id=...&repo=...\`. Rust implements these exact routes; the HTTP and UI are distinct gates.
- **Historical EventBus read PASS**: Rust \`/api/mobile/job-activity\` returned **HTTP 200 and 23 allowed Events for Job 679**, **11 for Job 627**, **32 for Job 629**. Job/repository scope matched. Raw \`/api/events\` history is nonempty for these Node-era Jobs.
- **New Rust Job event publication FAIL (pre-fix)**: Rust Job **681** has real SQLite/Graph state, but its Mobile Activity returned **HTTP 200 with \`events:[]\`**; independent EventBus history likewise had **0 events**. This is not a global mobile parser or Dashboard route failure. Rust \`WorkspaceControlBackend::publish\` emitted only in-process SSE, not NATS. Do not fabricate historical Worker execution events.
- **Rust-only correction under verification**: bind a real NATS publisher to the configured loopback transport and forward only **post-Graph-CAS versioned lifecycle events**, keeping ephemeral \`relay.wake\` out of the EventBus. Isolated real NATS test \`live_committed_graph_event_reaches_actual_nats_activity_transport\` **PASS**. Live Mobile readback still pending.
- Keep BD2/BD3 and the independent mobile-device display gate open until a **new Rust-created Job** has real correlated \`job.*\` and \`task.*\` Events that Neo Mobile renders. No Neo Mobile or stable Node code changes are needed for this producer defect.

## Gate C — real WebHelm Browser Worker + Events Bus (**DEFERRED by user; resume after D**)

**Priority decision (2026-11-21):** This gate is deliberately DEFERRED, not a prerequisite to executing D. Do not repair WebHelm Thread ID/New Thread actions or retry uncertain browser submissions during D. It remains required for later WebHelm-specific acceptance, but must not block native Coordinator, Script Worker, Git/Review and non-browser Model Worker tests. DEFERRED does not mean PASS.

- [ ] C1. Prepare unique disposable Git/SQLite, Job ID absent from live, test-only WebHelm Rust2Canary workspace/session, separate port, verified broker namespace and authorized event ingestion.
- [ ] C2. Run python3 rust/tests/real_webhelm_canary_e2e.py --execute in explicit opt-in mode. Capture actual browser Thread URL/ID, output, graph/outbox evidence and exit. Never turn a failed provider attempt into a fake success.
- [ ] C3. Resolve the known ChatGPT durable Thread-ID failure after Send; prove exactly one real submission. If WebHelm actions change, run all three real platform MVPs: new thread, direct new turn, and two queued turns in same thread.
- [ ] C4. Observe **genuine correlated** task.started then task.completed (and independently task.failed for a negative test) with exact Job/Task/execution/generation/source from Events Bus into Graph-approved SQLite rows and durable outbox, not just an action receipt.
- [ ] C5. Verify recovery in the original Thread, deduped event replay, uncertain-submit quarantine and no automatic resend or false heartbeat progress.
- [ ] C6. Exercise actual Z.ai provider as well **if production routing supports Z.ai**; verify provider-specific durable Thread identity and exact terminal. If native adapter not available, mark BLOCKED and record gap.
- [ ] C7. Close only owned WebHelm session/pool slot, terminate test-owned Rust daemon, prove original live Node Job/SQLite untouched.

## Gate D — native Job lifecycle (**NOW PRIORITY 1, no WebHelm Browser Worker**)

**D order:** First prove a real native Script-only A→B→C Job terminal through Coordinator, canonical Graph, independent QA/Review and local Git. Next test retry/cancel/restart and the non-browser Model adapter. Browser Thread ID and WebHelm-session QA are reserved for Gate C. A Script-only PASS is a subgate, not proof of D4 Model completion or the entire Gate D. The existing Calculator Job 681 is diagnostic evidence, not an invitation to resubmit uncertain browser tasks.

For every case save real CLI/API input, Graph transition sequence, authoritative Job/Task/Review state, Script/Model execution evidence, and final readback.

- [ ] D1. Native CLI job create --initial-plan → Planner → executable Plan → real Worker → Final Review → COMPLETED. Separately prove create-only zero-Task Job stays idle.
- [ ] D2. CLI, HTTP, Dashboard and incoming broker signals produce the **same canonical Graph transitions**; no covert Node fallback or duplicate workflow policy.
- [ ] D3. Script Worker creates a verifiable isolated file artifact, commits its result and terminates owned process group.
- [ ] D4. Real Model Worker reads pinned Agent/Skill/task context and produces observable output with real correlated terminal events.
- [ ] D5. Three Agent Tasks A → B → C run in strict dependency order under one Coordinator, plus parallel branch/capacity starvation/resume.
- [ ] D6. Review modes: no review; all approvals; request changes with revision shortcut; request changes without shortcut. Confirm re-review, Final Review and proper child lineage.
- [ ] D7. Test failure → bounded retry → success; exhausted failure; cancel running Script/Model Task; correct leases/session cleanup, no false success.
- [ ] D8. Local Git is source of truth for Final Review/merge; Job completes without GitHub. Optional origin push only **after** verified completion; remote failures never reopen the Job.

**Non-WebHelm D subtests (verified):** native Script process execution **4/4 PASS**; native daemon dependency-ordered A→B Script chain **1/1 PASS**; planned Script Job terminal state **1/1 PASS**; immutable local Git merged terminal **1/1 PASS**. Evidence: \`/tmp/rust2-D-script-worker.log\`, \`/tmp/rust2-D-dependency-e2e.log\`, \`/tmp/rust2-D-terminal-e2e.log\`, \`/tmp/rust2-D-git-merge-e2e.log\`. Full three-worker A→B→C and real Project Runner Calculator remain pending; these subsets do **not** authorize a D PASS.

### Four real MVP acceptance cases (2026-11-21 request)

| MVP | Required real acceptance | Actual status |
| --- | --- | --- |
| **D-MVP-1 — Calculator happy path** | Actual \`neo project run\` on clean calculator seed \`ae2f833\`; non-Shortcut Model Builder produces new \`index.html\`; independent browser/QA and Final Review; **Job COMPLETED**, no failed Task. | **PENDING** — do not reuse previous failed Job 681 as a happy-path pass. |
| **D-MVP-2 — Calculator error → Troubleshooter** | Independently seeded calculator Job, one actual failed implementation and a **real Troubleshooter Task**; repair/retry, QA, Final Review, **Job COMPLETED** with failure and recovery lineage. | **PENDING** — Job 681 currently demonstrates failed Builder/queued or failed Troubleshooter, not repaired completion. |
| **D-MVP-3 — DAG with Shortcuts** | Genuine \`neo project run\` three-node A→B→C with real owned \`.shortcut/*.agent.mjs\`; correlated Worker lifecycle events and Review; **Job COMPLETED**. | **PARTIAL** — live Job 682's A/B/C and Coordinator \`SUCCEEDED\`, real NATS + Mobile Activities; native Codex Final Reviewer previously \`FAILED\`, so Job remains \`ACTIVE\`. |
| **D-MVP-4 — DAG without Shortcuts** | Genuine \`neo project run\` with at least one Model-only agent lacking a source-owned Shortcut; native Rust Codex-owned worker, correlated start/terminal Events, actual outputs, Review and **Job COMPLETED**. | **PENDING** — native non-WebHelm Codex Worker transport being ported; no real terminal verified yet. |

All four MVPs must be evidenced separately with exact Job ID, source Git SHA, Task/Review lineage, real artifacts, EventBus history, and terminal Job readback. Test-only fake model/broker/SQLite outcomes never count as live MVP passes. Gate C's WebHelm Browser Worker remains deferred.

## Gate D-ProjectRunner — real Project Runner calculator Job (**after native D core, before E**)

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

## Gate G — production readiness, controlled live cutover, rollback (**partially live, not certified**)

**Current exception / status:** The user authorized early production cutover on 2026-11-21 and subsequently deferred WebHelm Browser Worker Gate C until after D. Native Rust is now live as the sole PM2 relayd owner (port 8787). This **does not** satisfy G1-G8: full authenticated external Model/EventBus execution, Project Runner terminal state, live rollback, and three-node acceptance still need verification. Prioritize D / D-ProjectRunner now; Gate C WebHelm is deferred, not waived. Before final production certification, every outstanding Gate (including C, B-Dashboard, E and F) still requires independent evidence. Early cutover does not prove completion.

- [ ] G1. Implement/review safe production single-owner writable Rust startup, credentials, launchd service path, broker durability/security and health/productionReady reporting; no repurposed isolated-canary flags.
- [ ] G2. Prove a consistent SQLite/WAL/outbox/lease backup can be restored on a disposable host; document exact safe rollback and Node/Rust ownership fencing.
- [ ] G3. Safely park/drain active Node leases/sessions and prevent its automatic restart; verify **exactly one** production writer/claimer before Rust touches canonical store.
- [ ] G4. Start Rust2 as only production owner on Neo Master. Reconcile pre/post state and worker ownership with the baseline; immediately rollback on mismatch.
- [ ] G5. Run a harmless, expressly authorized real production Job through Planner/Coordinator/Worker → verified Events Bus → Graph/SQLite terminal → Dashboard + real iPhone.
- [ ] G6. Restart Rust owner and reconnect broker in a controlled window; verify no duplicate submissions, orphan sessions, lost events or unrecovered leases. Measure against the recorded Node baseline.
- [ ] G7. Exercise rollback first on test/staging and verify Node resumes as unique owner with correct durable facts, active work and endpoints; only attempt production rollback when authorized/necessary.
- [ ] G8. After live Neo Master acceptance, upgrade home98 and Worknode **one at a time**, checking smoke, model/Script Tasks, broker and rollback. Remove Node implementation only after sustained verified operation.

## Gate sign-off — recorded 2026-11-21 (source SHA `23a36de`)

Statuses below mean **complete gate** status; a green subtest does not turn its entire gate green. Evidence files are from the actual Neo Master session; verify their availability before relying on them in future runs.

| Gate | Current status | Verified subset / remaining gap |
| --- | --- | --- |
| A — cutover baseline / critical regression | **PASS** (scoped) | Build, API mapping, 101/101 lib, 23/23 native daemon, 16/16 SQLite writer, 5/5 migration, focused parity. All-targets, Node full, L1/L2/L3 **remain mandatory under D/E**; not represented as passed. |
| B — historical read-only shadow parity | **PASS** (scoped) | 469 Job identities/count, 60/60 Node/Rust sampled fields + later 40/40, large responses, 405 shadow POST guard, clean removal. **No claim of full-record parity**; Dashboard UX/SSE/mobile remain in B-Dashboard/F. |
| B-Dashboard — browser read-only | **PARTIAL** | Real Chrome/WebHelm shadow Dashboard and mobile viewport displayed; live Rust Jobs API and authenticated WebHelm public `/dashboard/` displayed Jobs. Public anonymous route still returns **401**, `/dashboard/api/jobs` **404** (actual route `/relay/api/jobs`); complete read-only review, SSE, scoped 401/403 and post-restart matrix **not signed off**. |
| C — WebHelm Browser Worker + Events Bus | **DEFERRED (after D)** | Real isolated ChatGPT WebHelm canary reached Send, but durable Thread ID and authentic `task.started/task.completed` were not verified. Post-Send uncertainty must remain quarantined; no fabricated success. |
| D — native Job lifecycle (priority 1) | **PARTIAL / IN_PROGRESS** | Live native CLI, Graph/SQLite control, Job creation/cancellation, Scheduler admission and coordinator activation exercised. **Model Worker codex route unsupported** and no real terminal chain/Final Review. |
| D-ProjectRunner — Calculator | **BLOCKED** | Genuine `neo project run` from clean `ae2f833` clone `/Users/chengli/Workspace/neo/calculator-rust2-e2e-20261121`. Failed draft **Job 680 / Task 2068 CANCELLED** by native Graph. Current **Job 681 ACTIVE**, Coordinator **2069 RUNNING**, Builder **2070 FAILED** (unsupported `codex`), Troubleshooter **2071 QUEUED**. No new calculator artifact, independent browser QA, Final Review or Job COMPLETED. |
| E — durability/restart/security | **PARTIAL** | Rust live owner-lock/restart, restored WAL backup, post-Send quarantine, pre-Send lease release, and one-time migration regression tested. Full real broker replay, concurrent three-node fencing, malicious event and live rollback cases unverified. |
| F — real iPhone / three nodes | **NOT_RUN** | No certified real-device Review/Cancel + Neo Master/home98/Worknode route/reconnect acceptance for final live Rust build. Never substitute simulator. |
| G — production cutover/rollback | **PARTIAL / BLOCKED** | **Rust is sole live PM2 relayd** on `8787`; Node stopped. Native status: `runtime=native-rust`, `mode=live-write`, `productionReady=false`, **471 Jobs**, SQLite `PRAGMA quick_check=ok`. Tested backup integrity/restore and single-owner restart; no verified complete production Job, rollback E2E or secondary-node upgrade. |

### Session evidence and no-go summary

- E2E source reference: local `main` commit `23a36de`; migration optimization commit `e125b52`. Following modifications must update this SHA and rerun affected evidence.
- Native daemon 23/23: `/tmp/rust2-daemon-parity-recheck.log`; Rust lib 101/101: `/tmp/rust2-post-migration-lib-tests.log`; SQLite writer 16/16: `/tmp/rust2-post-migration-regression.log` (this older combined run also contains **two earlier daemon failures**, subsequently fixed and retested 23/23); migration 5/5: `/tmp/rust2-once-migration-regression-final.log`.
- Native PM2 service: `agents-relay/daemon`, binary `rust/target/debug/agents-relayd-rust`, port `8787`; backup and prior PM2 definitions in `~/.agents-relay/backups/rust2-exclusive-20261121-*/`. Preserve these for rollback.
- Last authoritative Calculator snapshot: `681 ACTIVE`; `2069 RUNNING`, `2070 FAILED`, `2071 QUEUED`. These are **not** evidence of a completed Job or that the entire Scheduler/Model path works.
- **Current D priority:** Script Worker real execution, A→B→C dependencies, local Git/review, and terminal Job, without WebHelm Browser Worker. Job 681 still demonstrates an unsupported codex adapter; verify a correct non-browser Model path separately. No manual Task advancement or duplicate uncertain browser submission.
- **Full acceptance: 2/9 gates PASS** for their stated scoped criteria (A and B); **7 gates not yet PASS**. The exhaustive suites deferred from A/B remain blocking requirements under D/E/F/G. An intention to finish today is not acceptance evidence.

**Definition of DONE:** all **nine** gates (A, B, B-Dashboard, C, D, D-ProjectRunner, E, F and G) PASS at a reviewed and identified build SHA; real external provider + correlated terminal; a **new calculator Project Runner Job independently reviewed and COMPLETED**; real iPhone UI; exclusive production ownership; proven rollback; original Node state preserved. Only then reconsider upgrading src/reconciler-runtime.ts and src/relayd.ts from PORTING to PASS and declare PORTING=0.

### 2026-11-21 autonomous Rust2 native MVP follow-up (verified as of 18:55Z)

- **Rust baseline regression PASS:** `native_codex_worker` 2/2; `native_sqlite_write_host` 18/18; `native_real_nats_transport` 6/6; `native_daemon_binary_readonly` 23/23; Rust library 101/101, build successful (150 tests). After adding canonical non-browser managed prompt, 3/3 native Codex + 18/18 SQLite + 6/6 NATS + 101/101 library + 23/23 native daemon and build passed. Final rebuilt native binary quick CLI MVP 3/3 passed again.
- **CLI smoke 3/3 PASS:** canonical Graph needs autoMerge for terminal; corrected the Node-based *test harness only*, not the stable Node daemon. Real CLI A→B→C Script worker output, strict order, and Job terminal after daemon restart all verified.
- **WebHelm Dashboard 3/3 PASS:** real Chrome Job 682, Task 2073 lifecycle/events and accessible JEL nodes; only owned browser Session released.
- **Neo Mobile iPhoneHelm 0/4 BLOCKED:** physical iPhone 17 reports `unavailable` in CoreDevice, preventing authorized iPhoneHelm Session. No simulator substituted.
- **Gate D not PASS:** genuine Jobs 681–684 remain ACTIVE: Builder failure→Troubleshooter, Shortcut Final Review CHANGES REQUIRED with genuine revision Task, Calculator generated artifact but invalid DAG result, and model-only Agent A execution/reroute. No Job COMPLETED claim.
- **Provider blocker:** live `glm-5.3-flash` quota exhausted on 2026-11-21 (reset advertised 2026-11-22 07:32:55); native routing visibly selected alternative for some retries. Do not fabricate provider success.
- **Next native hotfix deployment:** canonical managed Codex Agent/Event contract compiled and regression-tested, **not restarted live while in-flight Rust Workers own genuine model leases**. Preserve PM2 and live SQLite; deploy only after safe no-active-worker boundary.
- **Evidence:** `mvp/runs/20261121T1850Z-rust2/summary.md`, CLI report, physical CoreDevice inventory, Rust test logs, and live CLI Job snapshots. This is an honest partial acceptance, NOT `PORTING=0` or `10/10`.

### Rust2 native Planner test/fix follow-up — 2026-11-21

- **Native Planner missing-Shortcut root cause fixed:** projects without `agents/.shortcut/planner.agent.mjs` now use the explicitly authorized, repository-scoped Rust-owned Codex provider; malicious/existing invalid shortcut still fails closed. The existing Graph selects a Plan, the native Planner owns the exact leased execution, and `agents-relay-rust plan apply` is the only Plan commit authority; process exit and fabricated receipt remain invalid. Stable Node.js daemon sources unchanged.
- **Selected Rust regression 159/159 PASS** (Codex Planner 3, Script Planner 5, Codex Worker 3, SQLite 18, NATS 6, native daemon 23, Rust lib 101), native CLI+daemon build PASS, quick CLI **3/3 PASS**. New test `rust/tests/native_codex_planner.rs` verifies fake provider cannot mark a Plan SUCCEEDED and exact native Rust CLI resolution. Rust daemon restarted only after verifying no active Codex process; PM2 remains exclusive Rust owner on 8787.
- **D-MVP-2 PASS:** real Calculator Job **683 COMPLETED**, canonical Troubleshooter `2084` SUCCEEDED, Builder `2080` recovered, QA `2087` SUCCEEDED, reviewer `2090` SUCCEEDED, local merge `succeeded`.
- **D-MVP-1 / D-MVP-4 ACTIVE:** new clean Calculator Job **685** and model-only DAG Job **686** created through genuine `neo project run`; Task-level success is not Job terminal. Preserve real Model events and outputs.
- **D-MVP-3 still NOT PASS:** Job 682's re-scheduled A/B/C incorrectly ran old source-root Shortcut versions despite a repaired source Job worktree. New source-owned Shortcut fixture preflight performed actual public trend search, 8 observed reference URLs, A/B/C verifiable file outputs and verified SHA-256 over **file bytes**, no publication authorization. Full Project Runner review + terminal is still pending.
- **Mobile 4 checks BLOCKED** by physical iPhone 17 `unavailable`; no simulator or synthetic UI observation.
- Evidence: `mvp/runs/20261121T1943Z-rust2/summary.md`, selected test logs, CLI readbacks, Script A/B/C preflight.

### MVP update — Neo Mobile deferred (2026-11-21)

- User explicitly deferred physical Neo Mobile verification. Exclude Mobile from the current Rust2 CLI/DAG completion gate; do not count unrun iPhone checks as PASS or as an implementation FAIL. Resume the iPhoneHelm checklist only when explicitly requested.
- CLI Job 685: Calculator Builder 2101 and independent QA 2105 SUCCEEDED; Reviewer 2107 RUNNING at last readback, so **not COMPLETED** despite independent WebHelm artifact QA 14/14. Artifact logs preserved in `mvp/runs/20261121T1943Z-rust2/`.
- CLI Job 686: Script-free Model A/B/C 2102/2103/2104 SUCCEEDED; Final Reviewer 2106 returned `changes_required` for missing authorized research brief and missing declared Coordinator output. Plan `plan-1` is PLANNING, owned by foreground Coordinator CLI. **Not COMPLETED**; do not forge inputs, review, or missing file.
- Found repeated daemon Planner-launch races with a valid foreground CLI generation. Rust now skips duplicate launch effects when another owner holds a durable unexpired Plan lease; no Plan status is edited. Targeted regression **26/26 PASS**: native Codex Planner 3, Script Planner 5, SQLite 18. Source fix remains inactive in the running daemon until an orderly restart after current owned Codex processes settle.

### Rust-only E2E outbox and Coordinator repair — 2026-11-21 UTC 22:12

- Fixed EventBus `workflow_event_outbox` starvation: strict generation-correlation now supports `model-event/{job}/{task}/{execution}/{event_id}` alongside `script-event/{job}/{task}/{execution}/{type}`, with bounded allowed lifecycle events; existing model-event rows were legitimate but blocked later Script publishing. Native NATS/SQLite regression and live restart verified **36→0 pending** (34 Model + 2 Script). Duplicate `task.started` already in RUNNING state no longer permanently blocks terminal delivery; missing or out-of-order potentially valid terminals still retry.
- Added Rust `dag_coordinator_receipt` project Run JSON materializer. The authoritative Graph/SQLite Task must already be SUCCEEDED and all declared DAG children present, identity/hash-verified, with actual `status: COMPLETED` structured file outputs. Uses atomic no-overwrite file hardlink, protects live project output roots and handles historical relative paths by safe skip. Project source/NodeJS Relay unchanged.
- Exact selected Rust regression **159/159 PASS**, native build PASS and minimum CLI smoke **3/3 PASS**. Evidence: `mvp/runs/20261121T2212Z-rust2/{summary.md,full-regression.log,cli-live-readbacks.json}`.
- External MVP: Job **683** Calculator failure/Troubleshooter recovery `COMPLETED/approved/merged`; Job **685** clean Calculator `COMPLETED/approved/merged`; Job **690** Script Shortcut A/B/C `COMPLETED/approved` but `localMerge` absent, do not invent merged status; Job **691** fresh Model-only DAG with authorized source brief ACTIVE at capture, not yet PASS. Neo Mobile deferred.

### Native Model Worker localhost Events Bus permission — 2026-11-21

- Root cause of real E2E Job **691** failure: `rust/src/native_codex_execution.rs` invoked Codex `--sandbox workspace-write` without `sandbox_workspace_write.network_access=true`. The real Model A created Git-tracked public research and DAG JSON but EventBus NATS `127.0.0.1:4222` returned `EPERM` in sandbox; no authoritative `task.started` or `task.completed` was committed. Correctly failed Task 2132, did not fake terminal. Scoped cancel of the now-unrecoverable test-only Troubleshooter 2133 and Job 691 through real CLI; only the exact cancelled native Codex process group was terminated after verifying SQLite PID/PGID/execution identity.
- Rust-only worker fix: set explicit `-c sandbox_workspace_write.network_access=true` **while keeping workspace-write sandbox** and explicit safe repository allowlist. Isolated real Codex probe with this exact sandbox configuration returned `LOOPBACK_NATS_TCP_OK` from actual TCP connect (exit 0), no EventBus events injected. See `mvp/runs/20261121T2230Z-rust2/native-codex-loopback-evidence.json`. New native Codex Worker fake-provider test verifies argv and never confuses process exit with Task terminal.
- Rust CLI foreground previously exited on EAGAIN while daemon-owned Worker still ran; bounded attachment retry for only idempotent `job.reconcile`, and bounded CLI HTTP retry limited to `job.reconcile` / execution-fenced, idempotent `plan.apply`. All other writes retain fail-closed uncertain-outcome behavior. Existing native CLI foreground 13-test suite includes real Graph+SQLite semantics.
- All newly introduced native Model E2E Jobs must pass authenticated Task events and final review with `COMPLETED` readback; unfinished Jobs are not passes. Neo Mobile remains deliberately postponed.

### Real Model DAG foreground transport E2E follow-up — 2026-11-21

- Native live Job **692** Model A **2135 SUCCEEDED** with real source research, Git artifact and EventBus start/progress/complete; Graph scheduled Model B **2136 RUNNING**. No Shortcut was used for A/B. The canonical Job is not yet COMPLETE; no fabricated later status.
- During active Model B, native foreground CLI detached with a real HTTP `Broken pipe (os error 32)`; daemon Worker remained owned and active. Rust-only CLI now bounded-retries read-only Job/Events `GET` and idempotent `plan.apply`/`job.reconcile` transient errors (EAGAIN, Broken pipe, connection reset, unexpected EOF); other writes fail closed. Live reattachment to same Job succeeded and replayed exact historical events without another Task. New targeted tests cover transient read/event/reconcile and nontransient authorization failure.
- Foreground full regression **15/15 PASS**, native CLI built, CLI MVP **3/3 PASS**. Evidence at `mvp/runs/20261121T2247Z-rust2/`.
