---
name: agents-relay
description: Use Agents Relay for durable multi-step or multi-agent work that needs Jobs and Tasks, planning, dependencies, independent review, failure recovery, human escalation, or progress across sessions. Also use it for content production with real approval/handoff boundaries. Use direct tools instead for one-shot work without durable coordination.
---

# Agents Relay

Relay owns durable Jobs and Tasks; do one-shot work directly. On Neo Master, use the deployed **native Rust** commands `agents-relay` and `agents-relayd`. Build from `rust/Cargo.toml`; the live PM2 daemon and CLI must use the same Rust revision. There is no Node/npm Relay backend or `dist/cli.js`.

## Capability tree

- Create/inspect: Job ID, SQLite state, and immutable `job.projectRoot` (canonical independent Git root); `repository` is its basename, never `owner/repo`.
- Execute: normal Planner or plan-free Coordinator DAG; use the native CLI deployed with the daemon.
- Review/merge: local Git head and normal Job gate; `COMPLETED` requires no network or PR.
- Deliver: optional verified non-force origin/main push after completion; never changes Job state.
- Daemon: no Workspace scan and no `--workspace` requirement. Restart PM2 intentionally after installing a verified Rust binary; never rely on npm package publications.

## Codex Thread-aware routing and recovery

Every Codex Task persists its `threadId` from verified Codex JSONL
`thread.started` to SQLite, fenced by the exact current `executionId`. A
new execution of the **same Task** resumes that ID with turn-scoped
Profile, Model, Provider and reasoning instead of creating a new thread.
The Model Router offers exactly one configured Model per Profile (including
the implicit `default` Profile) and ranks eligible Profiles according to the
configured routing policy and health. Quota/429 failures with proven zero
tool-side-effects can exclude the failed Profile and reschedule the original
Task through the Graph in a *new* owned process generation. Never replay an
ambiguous or side-effectful turn. If no eligible Profile remains, fail closed.

Troubleshooter is a **one-execution specialist** (`maxAttempts=1`). It is
never retried/reopened or used for routine provider quota fallback. On an
unresolved failure, invoke the existing durable escalation workflow.

## Native Codex Worker execution permissions

**Every** trusted local Codex subprocess launched by Relay uses the shared
`--dangerously-bypass-approvals-and-sandbox` permission profile: Planner,
Implementation, Troubleshooter, other Model Workers, standalone Outcome Reviewers,
and Codex thread Continuations. No Codex sandbox and no interactive shell approval
prompts. This allows Xcode,
SwiftPM, and other developer tools to access system/user cache paths outside the
repository. This is an operator-authorized, high-trust execution mode; only
allowlisted native Codex executables and authorized Task contexts may be run.
It does not bypass Relay's durable process ownership, Task/Graph completion,
independent Final Review, or external/public/paid-action authorization rules.
This setting applies to all Codex subprocess launch paths. Browser Workers,
non-Codex tools, and external provider policies remain independent.

## Source Worker completion

New source Tasks (`gitDeliveryRequired: true`) must commit with `Relay-Task: ID` and `Relay-Execution: EXECUTION_ID` trailers, then run the matching `agents-relay task complete` CLI with `--repo --id --task-id --execution-id --commit-sha --summary`. Relay verifies clean Git HEAD and execution before emitting completion. **Never directly emit `task.completed`**. File, Reviewer, Troubleshooter and legacy Tasks retain normal events.

## Job Execution Lifecycle (JEL)

**JEL:** Create → [Plan] → Execute → Final Review → local Merge → Completed. An immutable-head Final Review `approved` receipt from the *matching successful Final Reviewer Task* is authoritative completion evidence even when a preceding infrastructure-only Plan round FAILED; this never rewrites that Plan. For reviewed older Jobs missing `localMerge` despite `autoMerge=true`, the Rust daemon may stage a merge receipt only from the **currently checked-out non-main Git branch whose tip matches the exact approved head SHA** and whose existing target ref is `refs/heads/main`; SQLite CAS, Job Graph, and real local Git merge remain mandatory. Stale, detached or changed branches fail closed. Missing merge metadata is not proof that `COMPLETED` can be asserted. Plan-free Coordinator uses the same lifecycle. PASS merges. CHANGES_REQUIRED first verifies each finding's original Implementation owner; a fully attributed review directly creates Graph-owned Targeted Revision Task(s), reusing the original Codex Thread without mutating its succeeded evidence. Ambiguous/new findings go to the existing Planner for minimal new work, not a redundant whole-Job plan. Every subsequent Final Review gets a new SHA-bound verdict while retaining the prior Reviewer Thread when its Codex identity is valid. No post-success Plan. Planner/Workers use **ponytail** (YAGNI, reuse, minimal Tasks) without bypassing safety gates.

## 1. Choose and start a Job

Use Relay for durable multi-Task work with explicit objectives and acceptance criteria.

For **every new Job**, apply the `speckit-specify` and `speckit-clarify` requirements/clarification contracts, then obtain an independent future-Final-Reviewer preflight with `review run --prompt-file` **before** `job create`. Only `PASS` authorizes creation; revise `CHANGE_REQUIRED`, stop on `BLOCKED`/review failure. A conversation-only design is not authorization. The creator explicitly declares completion using **`--preflight=true`** (only accepted spelling); missing, false, or any other value fails with `ERROR [JOB_PREFLIGHT_REQUIRED]` and exit 2 before creating a Job. This is a non-persisted responsibility assertion, not review evidence. No `job.preflight`, Preflight Task, Receipt, or new JEL state. Project Run callers must also declare it before creating new Coordinator Jobs. Full Spec Kit file-producing workflows require an authorized `.specify/` checkout; see `contracts/task-job-contract.md` and `contracts/orchestrator-workflows.md`.

Consult CLI help; examples:

```sh
agents-relay --help
agents-relay job create --repo LOCAL_ROOT_NAME --project-root /absolute/path/to/git-root --title "Objective" --objective-file job.md --preflight=true --initial-plan
agents-relay job show --id JOB_ID
agents-relay task list --repo LOCAL_ROOT_NAME --id JOB_ID
```

`job.repository` is the local Git root directory name and `job.projectRoot` is its immutable canonical path. Every Neo Project (`vlog`, `toyalive-3d`, etc.) has an independent Git root; no `job.projectPath` field exists. Remote owner/repository metadata is not part of Job identity. Use returned Job IDs. Omit `--initial-plan` for DRAFT-only or Coordinator Graph work. Local Git is the source of truth for review and merge; GitHub authentication and PRs are not part of Job execution.

Read `contracts/task-job-contract.md` before authoring or changing Jobs or Tasks and `contracts/orchestrator-workflows.md` when handling initial planning, P0/self Jobs, or merge/delivery boundaries. For content work, load the active Neo Project rules, its Agent Graph if present, and the relevant stage contracts—not a presumed universal production sequence.

## 2. Plan and execute

`job create --initial-plan` starts Planner; `plan` advances an existing DRAFT Job. Direct `task create` is for orchestrator-authored Tasks. Describe outcomes/dependencies, not shell commands. Public outputs: `--output local-git` or `--output file --output-path PATH`; historical SQLite `task_pr` means local Git work. Include `storySize`; `skills`, `model`, and `reasoning` are advisory. See `contracts/agent-contract.md`.

An execution Prompt pins the native CLI path, Role, contracts, Task/Plan ID and execution ID. Use the **exact matching Rust CLI path** from the execution Prompt; do not substitute a different executable revision. Before acting, load execution-bound context:

```sh
# Use the pinned native CLI path from the Prompt when one is provided.
agents-relay task context --id JOB --task-id TASK --execution-id EXECUTION
agents-relay plan context --id JOB --plan-id PLAN --execution-id EXECUTION
```

Task/Planner context rejects stale identities. Planner submits via `apply_cli`; only `PLAN_APPLIED:<plan-id>:<execution-id>` proves application. Delegated Tasks remain durable.

### Plan-free Coordinator / DAG execution

`agentGraph` is a dependency DAG: one durable Coordinator Task plus one durable Agent Task per ready node. Coordinator owns the Graph without a Worker lease. Script/Model Tasks share retry, review and terminal semantics; terminal events immediately release successors, respecting capacity and dependencies.

Coordinator DAGs are **Neo Project Run-only**. Do not create Coordinator
Jobs directly for ordinary Relay work, even when an Implementation Job has a
single Agent. Run `neo project run` for a declared Project `graph.mmd` or
`project.run.json` named `.mmd` Graph; that caller supplies the validated
`--project-run-manifest` and private Run-local input/output. Relay retains
Coordinator support for previously created Jobs. Ordinary Jobs use one direct
Implementation Task (or normal dependencies), optional Planner and independent
Final Review.

For Project runs, creation atomically persists a DRAFT Job and numeric Coordinator Task ID; reuse returned `taskId` for activation and caller Run bindings. DAG identity is `parentTaskId`/`nodeId`/`graphHash`. Normal activation queues; `--foreground` runs immediately and prints events, retaining durable state on interruption. `neo project run` binds and resumes the same Job. Reject legacy shortcut flags/modes. Final Review (`--review`/`--no-review`) and local merge (`--auto-merge`/`--no-auto-merge`) remain independent Job policies.

## 3. Verify, review, and recover

Inspect Tasks with the version-matched native Rust CLI. Final Review: `agents-relay review job --repo LOCAL_ROOT_NAME --id JOB_ID [--thread-id THREAD_ID]`. Agent review: `agents-relay review run --prompt-file PATH --project-path DIR` (standalone context only; never `job.projectPath`).

Process exit or Preview receipt is not completion. Emit `task.started`, optional `task.progress`, and one correlated `task.completed` or `task.failed` through `events-bus`; never `task.blocked`. Verified reviewer findings use `task.completed` with `data.verdict: changes-required`, `data.head_sha` and actionable findings; unverifiable reviews fail. See `contracts/event-contract.md` and `contracts/worker-self-review.md`.

**Diagnose before retrying** failed Tasks; inspect events and `contracts/task-recovery-flows.md` (external prerequisites: `contracts/blocker-job-recovery.md`). Use the version-matched native Rust CLI for `task recover --task-id ORIGINAL --recovery-task-id TROUBLESHOOTER` or verified human-only `task escalate`; a stale receipt is not resolution.

## 4. Configured escalation and host-owned Interactive Review

`agents-relay escalation` requires configured `AGENTS_RELAY_ESCALATION_COMMAND`; missing/broken configuration is a technical failure. `task escalate` instead escalates a Task.

For host-owned Review use `agents-relay review interactive --path ABS --id JOB --task-id TASK --execution-id EXEC`. Neo `review.preview` or Markcut owns Preview; receipt is not approval. Approve or Request Changes resumes the same Task; each execution owns at most one Review. Durable feedback is not a Git commit.

## 5. Manage services when needed

For service operations load `daemon-service-manage`. Use `node <skill-dir>/bin/services.mjs setup|status|doctor`. Never restart Relay for ordinary Job commands or create legacy PM2 names.
