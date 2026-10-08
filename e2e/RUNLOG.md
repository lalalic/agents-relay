# Production E2E Run Log

Branch: `fix/e2e-production-autonomy-20261008`  
Repository under test: `lalalic/agents-relay-e2e`  
Test PR: https://github.com/lalalic/agents-relay-e2e/pull/2

## 2026-10-08 09:16 America/Toronto — E2E-001 blocked (reproduced)

- **Status:** FAIL, not yet fixed. `node e2e/monitor.mjs --pr 2 --job e2e-autonomy-smoke-20261008` exited with code `1`.
- **Observed:** Job `ACTIVE`, PR `OPEN`, five Planner attempts `FAILED`, zero executable Tasks.
- **Error A:** `plan-1`: `Repository lalalic/agents-relay-e2e not found under workspace /Users/chengli/Workspace; pass --project-path explicitly`.
- **Error B:** `plan-2` through `plan-5`: `gh exited null`.
- **Root cause:** Not yet confirmed. Error A indicates project-path resolution failure at the Planner boundary; error B is currently an uninformative subprocess termination report, requiring underlying process/CLI diagnostics before attributing cause.
- **Solution under investigation:** Commit `208e21d` improved GitHub CLI exit diagnostics and preserved 11 failure scenarios. This is **not** evidence that E2E-001 is fixed.
- **Next validation:** Determine the real termination cause of `gh exited null`, fix the Planner execution path on this branch, rerun the production E2E job, and record observable task creation plus autonomous terminal state.

Each later fix should have its own commit documenting observed bug, root cause, solution, and rerun outcome. Do not mark a scenario PASS without an observed end-to-end result.

## 2026-10-08 09:35 America/Toronto — E2E-001 primary evidence audit

- **Evidence checked:** `/private/tmp/relay-e2e-current.json`, `/private/tmp/relay-plan5-diagnostic.log`, the EventsBus JSONL history, existing `agents-relayd` process audit logs, the test checkout, and current branch status.
- **Confirmed path cause:** `/Users/chengli/Workspace/agents-relay-e2e` exists and has the expected GitHub origin, but the production default workspace scan is `/Users/chengli/Workspace`; the test checkout is its sibling at `/Users/chengli/Workspace/agents-relay-e2e`. Therefore `plan-1` failed in `resolveWorkspaceRepositoryPath` before planner execution. This is confirmed evidence, not a hypothesis.
- **Confirmed projection symptom:** plans 2–5 each produced valid `plannerResult.next_tasks` and `generatedTaskIds`, then ended `FAILED` with `gh exited null`; no Task marker was appended. EventsBus preserved the ordered start/wake/fail records, but the prior error string omitted the child termination signal. Existing owned-process audit records show the relevant `gh` processes and process-group termination, but do not identify the failing command or signal at the old diagnostic site.
- **Current durable state:** Job `e2e-autonomy-smoke-20261008` is `ACTIVE`; PR #2 is `OPEN` at `d470873322ae6fed9e4ee8da91226f8086a0465c`; plans 1–5 are `FAILED`; Tasks remain empty. No unrelated production job was changed or restarted.
- **Solution in progress:** use the existing production CLI/EventsBus path with the real checkout explicitly bound for this PR2 run; retain the existing `208e21d` diagnostic change and do not call the scenario fixed until durable Tasks, worker/review/merge, GitHub state, and event evidence are observed.

## 2026-10-08 09:36 America/Toronto — E2E-001 post-fix execution blocker

- **Fix commit:** `1a2d96c` (`fix(github): retry signal-terminated CLI projections`). The focused regression suite passed 8/8, including a direct `gh` SIGTERM followed by successful retry.
- **Live rerun:** plan-7 completed through the real CLI with the real checkout path; its plan comment persisted and generated `implement-autonomy-smoke-20261008` (`QUEUED`) plus `review-autonomy-smoke-20261008` (`DRAFT`). EventsBus has `planner.started` and `job.wake` for plan-7 and no plan-7 failure.
- **Confirmed new blocker:** existing production `agents-relayd` is online, but `/api/jobs?refresh=true` contains no `lalalic/agents-relay-e2e` Job and its event subscriber logged prior `reconcile.signal_unrouted` for this Job. Runtime summary showed 7 active production Jobs and 0 running Tasks. The E2E checkout was created at 09:23 after the original daemon discovery, so the daemon’s repository pool has not adopted it.
- **Action authorized and required:** restart only the existing `agents-relayd` after the active-job check, allowing its configured `/Users/chengli/Workspace` scan to discover the already-present E2E checkout. No other production service/job is being changed.

## 2026-10-08 09:37 America/Toronto — E2E-006 confirmed during E2E-001

- **Production execution evidence:** after the scoped `agents-relayd` restart and repository discovery, PR2 implementation was routed to `chatgpt/browser-worker`; EventsBus recorded worker/model selection, then `task.failed` at delivery phase, followed by automatic Troubleshooter creation and launch.
- **Confirmed root cause:** the shared Browser Workspace launcher imports `yaml`, but the runtime environment lacks the PyYAML module: `ModuleNotFoundError: No module named 'yaml'`. This is the documented E2E-006 failure and is directly present in the correlated terminal event; it is not inferred from a timeout.
- **Current result:** implementation remains historically failed/queued for recovery; Troubleshooter `troubleshoot-implement-autonomy-smoke-20261008-a1` is `RUNNING` with execution `9878c2a3-fb2a-4651-ba60-063f8feb2528`. No manual retry or dependency removal was performed.
- **Solution status:** awaiting the production Troubleshooter’s authoritative diagnosis and recovery event before changing source/runtime or calling E2E-006 fixed.

## 2026-10-08 09:41 America/Toronto — E2E-006 follow-up failure diagnosed

- **Evidence:** the automatic Troubleshooter execution was cancelled at 13:40:22Z after 274.7 seconds (`SIGTERM`, execution `9878c2a3-fb2a-4651-ba60-063f8feb2528`). The existing runtime then retried implementation attempt 2; its correlated `task.failed` event at 13:40:24Z reported `browser-workspace: error: unrecognized arguments: --auto-session`.
- **Root cause:** Relay’s ChatGPT adapter encoded a removed Browser Workspace CLI flag. The installed launcher’s actual help accepts `--config`, `--url`, and `--session-id`; omitting `--session-id` is the supported temporary-session path. The earlier `yaml` import failure was therefore not the only production-path defect.
- **Solution:** rename the internal runner to reflect the supported temporary-session behavior and remove the stale `--auto-session` argument. Updated both source-contract tests to reject the obsolete flag.
- **Fix commit:** `1856fdb` (`fix(browser-worker): use supported temporary session CLI`).
- **Local result:** build succeeded; adapter/browser-workspace focused suite passed `18/18`.
- **Live result:** not yet rerun with the production daemon; implementation Task is currently `FAILED` on attempt 2, PR remains `OPEN`, and E2E-001 is still **FAIL**, not PASS.

## 2026-10-08 09:43 America/Toronto — E2E-006 live retry is deployment-blocked

- **Production retry:** issued `task retry` through the existing daemon at `127.0.0.1:8787`; durable implementation attempt 3 (`5e84a481-2f5c-4a35-8a6c-2b17e9c8eb1b`) failed at 13:42:53Z with the same `--auto-session` CLI error. This is **not** a false pass and the E2E Job remains `ACTIVE`/PR `OPEN`.
- **Confirmed blocker:** PM2 launches `agents-relay@latest`, not this branch’s `dist`; therefore the committed adapter fix cannot affect the current worker until the shared daemon is reloaded with the repaired runtime. This is verified from PM2 metadata, not inferred.
- **Safety check:** the existing daemon currently has 10 active Jobs and 2 unrelated running Codex Tasks in `lalalic/neox` (execution IDs `162825cb-9080-409b-a745-2db9c01e75be` and `67b506ef-68d1-4102-943a-ef5c735d9926`). No daemon restart or unrelated-job mutation will occur while those tasks are running.
- **Next action:** monitor the shared tasks; after they drain, re-check active state and perform only the minimum scoped daemon reload needed to exercise commit `1856fdb`, then rerun the existing E2E Task through the production path.

## 2026-10-08 09:57 America/Toronto — scoped validation reload authorized

- **Safety evidence:** the pre-reload production summary now reports 10 active Jobs and `runningTasks: 0`; the two unrelated `lalalic/neox` executions have both drained. No unrelated task was cancelled or retried.
- **Action:** replacing the existing same-name `agents-relayd` process with this branch’s built `dist/relayd-main.js`, preserving its workspace, port, concurrency, interval, refresh, and webhook-secret arguments. This is a validation reload only; no production-main merge or new daemon is being created.

## 2026-10-08 10:02 America/Toronto — E2E-006 runtime contract revalidated

- **New evidence:** after the canonical Browser Workspace P0 recovery completed, the current launcher help again exposes `--session-id | --auto-session`. An exact invocation without `--auto-session` exits `0` with JSON `session_id_required`; Relay correctly rejects that output as “no submitted receipt.”
- **Correction:** the earlier `1856fdb` removal matched the pre-recovery CLI but not the repaired current runtime. Restored the explicit `--auto-session` flag and corresponding source-contract assertions in a new commit.
- **Local result:** build and focused adapter/browser-workspace suite pass `18/18`.
- **Fix commit:** `862e6a5` (`fix(browser-worker): restore explicit auto-session mode`).
- **Live result:** attempt 5 on the branch daemon still used the no-flag build and failed `browser-worker driver returned no submitted receipt`; the corrected build is ready for the next production retry. E2E-001 remains **FAIL**, not PASS.

## 2026-10-08 10:08 America/Toronto — E2E-006 CLI-version split diagnosed

- **Evidence:** after reloading with `862e6a5`, the production `npx browser-workspace` invocation failed attempt 6 with `unrecognized arguments: --auto-session`, while the interactive `/Users/chengli/.local/bin/browser-workspace` help exposed that flag. The two process environments resolve different Browser Workspace CLI generations.
- **Related lifecycle evidence:** attempt 4 emitted a late `task.completed` for execution `616d91fa-e71d-4d39-8ba8-d2ab1104c1c2` after its delivery failure, while the current durable Task remained failed on attempt 5. The stale completion was not treated as the authoritative current attempt; PR head `6a18e937b72bd615e56aeba3113bc2af168ba08f` nevertheless confirms the worker had performed the requested change.
- **Root cause:** Relay’s browser adapter depended on a version-specific one-shot flag. The production worker’s `npx` tool does not accept it; omitting it on the newer tool returns `session_id_required` with exit 0, which Relay surfaced as no submitted receipt.
- **Solution:** use the common explicit session lifecycle: `session start`, `platform run ... --session-id`, and `session stop` in `finally`, avoiding both one-shot flag variants and preserving cleanup.
- **Local result:** build and focused adapter/browser-workspace suite pass `18/18`.
- **Fix commit:** `aeb86a1` (`fix(browser-worker): use explicit compatible session lifecycle`). Live retry is pending the new build reload; E2E-001 remains **FAIL**, not PASS.

## 2026-10-08 10:16 America/Toronto — E2E-006 receipt-envelope defect fixed

- **Evidence:** explicit-session attempt 7 reached Browser Workspace but ended with `browser-worker driver returned no submitted receipt`. The installed generic runner returns `{platform, action, result:{...action receipt...}}`; the action source itself returns `operation=submit`, `status=submitted`, and `verified=true`.
- **Root cause:** `parseDriverJson` only examined a top-level JSON object and discarded the valid receipt nested under `result`.
- **Solution:** recursively unwrap `result`/`output`/`data` envelopes while preserving the existing submitted-receipt validation. Added executable nested-envelope tests.
- **Fix commit:** `7e13810` (`fix(browser-worker): unwrap platform receipt envelope`).
- **Local result:** build and focused adapter/browser-workspace suite pass `20/20`.
- **Live result:** attempt 7 is the first run before this parser fix; its durable Task is `FAILED`, PR remains `OPEN`, and E2E-001 remains **FAIL**. No PASS is claimed.

## 2026-10-08 10:23 America/Toronto — E2E-006 stdout-envelope defect fixed

- **Primary process evidence:** exact cached production CLI run returned exit-success JSON with `result.ok=true` and `result.stdout` containing the submitted receipt JSON; the controlled Browser Workspace session was stopped cleanly afterward.
- **Root cause:** the generic runner exposes the action receipt as JSON text in `result.stdout`, one envelope deeper than the previous parser fix handled.
- **Solution:** recursively parse JSON strings in `result`/`stdout`/other supported envelopes. Added executable object-envelope and stdout-envelope tests.
- **Fix commit:** `b063a9f` (`fix(browser-worker): parse stdout submission receipts`).
- **Local result:** build and focused adapter/browser-workspace suite pass `22/22`.
- **Live result:** attempt 8 failed before this fix with no submitted receipt; PR remains `OPEN`, and E2E-001 remains **FAIL** until a post-fix attempt reaches durable success/review/merge.

## 2026-10-08 10:30 America/Toronto — E2E-006 external Browser Workspace readiness blocker verified

- **Production retry:** after reloading the existing same-name daemon with the branch build containing `b063a9f`, the real production retry reached attempt 9 (`697efe93-47eb-4e8b-82dc-2ed06939acac`) and ended durably `FAILED` at 13:58:48Z. The Job remains `ACTIVE`; implementation Task attempt is 9/24 and review remains `DRAFT`. PR #2 remains `OPEN` at `6a18e937b72bd615e56aeba3113bc2af168ba08f`.
- **Exact process failure:** Browser Workspace `0.4.1` returned `ok:false` with stderr ending at `session_daemon.py` `_submit_current_page` → `_fill_prompt_if_needed` → `_wait_for_composer` → `wait_until_stable`: `RuntimeError: Temporary Chat composer readiness was not observed ready`. Cleanup reported `caller_owned_session:true`.
- **Root cause classification:** shared Browser Workspace/ChatGPT DOM readiness remains externally broken. This failure occurs inside the Browser Workspace session before a submit receipt exists; it is not a Relay command-construction or receipt-parser failure. Existing EventBus evidence also records the same readiness defect in other production jobs and the canonical Browser Workspace/P0 repair history.
- **Relay validation:** `b063a9f` (`fix(browser-worker): parse stdout submission receipts`) has focused adapter/browser-workspace tests `22/22` passing and successfully handles the exact successful controlled CLI envelope. The failed attempt’s `result.ok:false`/stderr has no receipt for that parser to recover.
- **Safety/state evidence:** production runtime summary after failure is `activeJobs:10, runningTasks:0`; no unrelated job/task was changed. EventsBus records the correlated attempt-9 failure. This scenario is **FAIL/BLOCKED**, not PASS; further Relay source edits would be guesswork until the shared Browser Workspace composer-readiness runtime is repaired and verified.

## 2026-10-08 E2E runner bootstrap — independent loop

- **Controller:** independent NeoY background process `node e2e/sentinel.mjs` (not an Agents Relay Job/Task). Watches real EventsBus JSONL and existing test Job projection every five seconds.
- **Rerun:** `node e2e/trigger.mjs --mode retry --task-id implement-autonomy-smoke-20261008` executed against PR #2 and exited 0. The test implementation ran again and failed on attempt 10, so this is not a passing scenario.
- **Current failure root-cause evidence:** Browser Workspace temporary-submit raised `RuntimeError: Temporary Chat composer readiness was not observed ready` from `_wait_for_composer` in the managed Browser Workspace runtime; this is different from the earlier missing yaml/CLI-argument/receipt errors. The actual UI readiness condition still needs investigation before declaring a fix.
- **Current branch commits:** `e007323` independent sentinel and NeoY handoff; `8862661` explicit controlled test rerun; `64a9d8e` verify terminal handoff status.
- **Handoff blocker:** `chatgpt.turn` requires the stable ID of THIS conversation. Managed Chrome currently showed another conversation; therefore a thread ID was not inferred. The sentinel is monitoring, but **deliveryConfigured=false** and will not send to an unverified thread. Configure `E2E_CHATGPT_THREAD_ID` then restart sentinel with `--handoff-command /Users/chengli/Workspace/agents-relay/e2e/neo-handoff.mjs` to enable safe automatic handoff.
- **Status:** E2E-001 FAIL, automatic turn delivery NOT YET ENABLED. This is not a closed loop until the target Thread is bound and a delivery completes.

## 2026-10-08 — E2E-001 attempt 11 and Sentinel stall false positive

- **Reported issue:** independent Sentinel sent `STALLED` for `implement-autonomy-smoke-20261008` as `QUEUED` with no execution ID immediately after retry; subsequent authoritative read confirmed the Task advanced to `RUNNING`, attempt 11, execution `a415e775-ea7d-4c62-9a7a-ab79957f665b`.
- **Root cause (Sentinel):** stall detection used only the timestamp of the last EventBus entry. A recently updated/retried Task was incorrectly treated as stalled when no new events had yet been observed.
- **Solution:** commit `586bc25` evaluates Task `updatedAt`/`createdAt` alongside the job's latest event timestamp, and reports only genuinely stale active tasks.
- **Separate test failure:** `npm test` failed source-size guard because `src/reconciler-runtime.ts` exceeded 500 lines (520 reported by the test). Move execution-boundary locking to its own module while preserving the exported API.
- **Validation:** `npm run build` and full `npm test`: 605/605 passed after extraction. This does not establish E2E completion; review/merge remain outstanding.
- **Browser Workspace composer fix:** independent browser-workspace branch `fix/e2e-composer-readiness-20261008`, commit `63fea32` retries transient composer discovery failures; ChatGPT contract tests 17/17 passed. Attempt 11 was triggered by `node e2e/trigger.mjs --mode retry --task-id implement-autonomy-smoke-20261008` and must be observed to terminal result before claiming this fix passes live.

## 2026-10-08 — E2E-001 Review head frozen before implementation (attempt 1)

- **Observed:** implementation task `implement-autonomy-smoke-20261008` SUCCEEDED at attempt 11. Its downstream `review-autonomy-smoke-20261008` entered BLOCKED at attempt 1 with `reviewHeadSha` mismatch. Durable Review head was `d470873322ae6fed9e4ee8da91226f8086a0465c`, while live PR #2 and Job head were `6a18e937b72bd615e56aeba3113bc2af168ba08f`.
- **Root cause:** `materializePlannerChild` froze the dependent Review's SHA at planning time, before the implementation dependency could update the PR head. Thus review of the latest implementation was impossible even though Review's instruction explicitly requested head binding at execution time.
- **Solution:** defer SHA binding for planner-created dependent Review tasks; immediately before an eligible Review execution claim, obtain the latest PR head through the repository store and persist it on that Review Task. Preserve already-bound independent/final Review tasks.
- **Validation:** build and full `npm test` PASS 607/607, including two dedicated executable Review-head binding regression tests. Live Review still requires an unblock/rerun and an observed terminal Review result, not yet PASS.

## 2026-10-08 — E2E-006 Review r2 Temporary Chat composer failure

- **Observed:** `review-autonomy-smoke-20261008-r2` FAILED at attempt 1 with execution `fe4b4fc8-af77-411e-ab38-71ecc734331a`. Browser Workspace `temporary-submit` failed in `_wait_for_composer`: `Temporary Chat composer readiness was not observed ready`; no verified submission receipt. The review's head was already the current PR SHA, so this is a new delivery failure, not the earlier Review SHA problem.
- **Cause addressed:** a URL-prefilled Temporary Chat can fail to mount an active composer during hydration. The existing retry only polls the same page; if the composer never appears it cannot recover from that page state. This is a plausible recovery path, not yet proven as the only cause of the live failure.
- **Solution (browser-workspace source):** commit `fa868c1` on `fix/e2e-composer-readiness-20261008` catches only the pre-send composer-readiness failure, reopens a clean Temporary Chat without URL prompt prefill, reasserts temporary mode, and retries once. Other failures still propagate, avoiding duplicate sends.
- **Validation:** syntax compilation and ChatGPT platform contract suite 18/18 PASS. Live Review retry still required to establish E2E PASS.

## 2026-10-08 — E2E-001 review.changes_required lost at Job review graph

- **Reproduced:** Review `review-autonomy-smoke-20261008-r2` attempt 2 emitted authoritative `review.changes_required` for PR head `6a18e937b72bd615e56aeba3113bc2af168ba08f`. The Task became `SUCCEEDED`, but Job `review` remained null and no `review-fix-*` Task was produced; PR #2 stayed `OPEN`, Job `ACTIVE`.
- **Root cause:** Planner-created reviewer Tasks were not registered as the Job's Review before the first verdict. `applyReviewEvent` transitioned the Task before dispatching the Review graph; the graph received `review.changes_required` in state `NONE`, which has no matching transition, and the verdict was dropped.
- **Solution:** For an SHA-matched, current-head Planner-created reviewer with no existing Job Review, durably seed `review: PENDING` with that Task as owner before applying the event. Then the existing Review graph handles changes-required by creating its standard revision Task, or handles approval via normal auto-merge effects.
- **Validation:** Added regression coverage for both Planner reviewer `review.changes_required -> review-fix` and `review.approved -> merge`. Build and full test suite PASS 610/610. Live PR #2 must be retested; no claim of passing E2E yet.

## 2026-10-08 — Review approval must not require future merge evidence

- **Reproduced:** The independent Review on PR #2 reported a second blocking finding: no verified auto-merge/Job COMPLETED evidence existed *before* Review approval, even though auto-merge can only execute after the Review approves. This is a circular prerequisite, not a valid pre-merge artifact defect. Its first finding (unrequested `.seed` file) remains legitimate.
- **Root cause:** Planner-created dependent reviewer instructions did not explicitly separate pre-merge code/artifact quality gates from downstream merge and complete-state E2E assertions, allowing the Reviewer to treat an expected future effect as an unsatisfied Review gate.
- **Solution:** At execution-time SHA binding, append an idempotent instruction limiting the Review verdict to pre-merge PR artifact and tests. Defer merge/Job completion verification to the independent E2E Runner after approval. Existing legitimate artifact findings remain actionable.
- **Validation:** Added tests verifying injection only once across repeat bindings. Full suite PASS 610/610 before Commit. Live Review rerun and automatic post-approval merge still require confirmation.

## 2026-10-08 — Plan-10 no-work Review Gate recovery

- **Observed:** independent E2E trigger produced successful `plan-10` with `objective_status=in_progress`, `next_tasks=[]`. Previous implementation was SUCCEEDED, prior reviewer had terminally completed, but Job remained ACTIVE, `review` null, and the normal Final Review gate never opened.
- **Root cause:** autonomous `completionGateSatisfied` required an explicit Planner `satisfied` declaration even when the latest successful round had no remaining work and a reviewer had already completed, creating a pre-merge circular wait for the merge/COMPLETED stages.
- **Solution:** Permit latest SUCCEEDED `in_progress` with zero planned tasks to enter Final Review only when an existing review Task has finished and implementation tasks all SUCCEEDED. Never borrow this permission from older plans or allow ordinary unfinished in-progress batches through.
- **Validation:** full build and npm test 612/612 PASS including conditional gate and latest-plan failure regression tests; live PR #2 review/merge still requires observation.

## 2026-10-08 — Final Review created but not event-driven dispatched

- **Observed:** after Plan-11 succeeded, `final-review-6a18e937b72b` was durably appended QUEUED, `review.created` published, Job Review PENDING, but no worker launched and runtime remained runningTasks=0.
- **Root cause:** RepositoryWorkerPool.watch ignored `review.created` as neither a lifecycle fact nor a wake; the new Task's ready-to-run transition therefore relied on periodic reconciliation.
- **Solution:** treat `review.created` as a wake-only event using the existing coordinator, not a task state transition or new authority path.
- **Regression:** test publishes `review.created` and observes targeted reconcile without full scan. Build + npm test 613/613 PASS. Live rerun pending.

## 2026-10-08 — Final Review incorrectly required post-merge lifecycle evidence

- **Observed:** `final-review-6a18e937b72b` attempt 1 emitted `task.blocked` at 14:50:28Z despite independently verifying exact PR fixture/test 3/3. Block reason cited old planner/delivery/duplicate-launch issues and missing PR auto-merge/Job COMPLETED evidence before approval.
- **Root cause:** `createFinalReviewTask` embeds the entire Job objective including downstream E2E workflow acceptance in the pre-merge Review instruction without explicit phase separation. The earlier phase separation for planner-created reviews did not apply to the normal final-review factory.
- **Solution:** in the final-review Task factory, explicitly scope the verdict to current immutable artifact, tests and genuine blocking code defects. Historic recovered worker failures must be reported independently, and downstream merge/COMPLETED assertions cannot be preconditions to the approval that causes them. Preserve pre-implementation PR baseline/seed files when evaluating change scope.
- **Validation:** Build and complete `npm test` 613/613 PASS, including new final-review contract assertion. Await fresh live review, GitHub merge and durable COMPLETED before declaring E2E pass.

## 2026-10-08 — Fresh E2E loop B verified; transient merge-state race

- New PR #3 in `lalalic/agents-relay-e2e` merged at 2026-10-08T16:07:38Z. Durable `e2e-autonomy-loop-b-20261008` Job is `COMPLETED`; implementation and review Tasks both `SUCCEEDED`; latest planner `SUCCEEDED`.
- Independent watcher briefly saw GitHub `MERGED` while the durable Job was still `ACTIVE`, generated `MERGED_JOB_NOT_COMPLETED`, then itself observed and recorded PASS at 16:07:47Z. This nine-second projection delay was eventual convergence, not a stuck Job.
- Fix: defer `MERGED_JOB_NOT_COMPLETED` escalation until the normal configurable inactivity window has elapsed since GitHub `mergedAt`; retain a genuine mismatch error after that deadline. Commit recorded independently.
- Revalidated via `node e2e/monitor.mjs --pr 3 --job e2e-autonomy-loop-b-20261008`: exit 0, PR MERGED, Job COMPLETED, no current issues. No repair Job/Task created.

## 2026-10-08 — Loop E controller false STALLED

- Target: `lalalic/agents-relay-e2e#6`, Job `e2e-autonomy-loop-e-20261008`, reviewer execution `de476ff0-38d6-41d9-bd5b-6f62be7a452d`.
- Evidence: local SQLite reported `RUNNING`, lease until `17:35:05Z`, `timeoutMs=900000`; Codex PID 51609 remained alive. `task.started` was committed at `17:21:44Z`. The independent sentinel emitted `STALLED` approximately four minutes after its last observed event, **well before** the Review's 15-minute execution deadline. No terminal failure had occurred.
- Root cause: `e2e/sentinel.mjs` applied its fixed four-minute silence threshold to `RUNNING` tasks even when their configured `timeoutMs` was larger. This was a premature controller alarm, not proof of a stuck worker.
- Repair: for `RUNNING` tasks the sentinel waits at least the declared task timeout plus 30 seconds before issuing `STALLED`; queued tasks retain the usual four-minute guard. This is the controller's deadline only; the Relay watchdog remains authoritative.
- Regression: `test/e2e-sentinel.test.js` proves a 15-minute Review is not flagged at five minutes but is flagged after the deadline.
- Next execution: restart the independent sentinel on PR #6 with fresh state, retaining the active review execution and avoiding any repair Job/Task.
