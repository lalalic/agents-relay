---
name: agents-relay
description: Use Agents Relay for durable multi-step or multi-agent work that needs Jobs and Tasks, planning, dependencies, independent review, failure recovery, human escalation, or progress across sessions. Also use it for content production with real approval/handoff boundaries. Use direct tools instead for one-shot work without durable coordination.
---

# Agents Relay

Relay owns durable Jobs and Tasks; do one-shot work directly. On Neo Master, **use the published npm package**, not the local developer checkout. The default CLI is `npx --yes --package agents-relay@latest agents-relay`; the daemon is `npx --yes --package agents-relay@latest agents-relayd`. Never use a stale globally installed `agents-relay` binary or local `dist/cli.js` for live Jobs.

## Capability tree

- Create/inspect: Job ID, SQLite state, and immutable `job.projectRoot` (canonical independent Git root); `repository` is its basename, never `owner/repo`.
- Execute: normal Planner or plan-free Coordinator DAG; use the same published CLI version as daemon.
- Review/merge: local Git head and normal Job gate; `COMPLETED` requires no network or PR.
- Deliver: optional verified non-force origin/main push after completion; never changes Job state.
- Daemon: no Workspace scan and no `--workspace` requirement. Neo's `package.published` watcher restarts package-backed PM2 services after npm `latest` is confirmed.

## Source Worker completion

New source Tasks (`gitDeliveryRequired: true`) must commit with `Relay-Task: ID` and `Relay-Execution: EXECUTION_ID` trailers, then run the matching `agents-relay task complete` CLI with `--repo --id --task-id --execution-id --commit-sha --summary`. Relay verifies clean Git HEAD and execution before emitting completion. **Never directly emit `task.completed`**. File, Reviewer, Troubleshooter and legacy Tasks retain normal events.

## Job Execution Lifecycle (JEL)

**JEL:** Create → [Plan] → Execute → Final Review → local Merge → Completed. Plan-free Coordinator uses the same lifecycle. PASS merges; CHANGES_REQUIRED records findings and starts Planner N+1 for minimal fixes, then re-reviews. No post-success Plan. Planner/Workers use **ponytail** (YAGNI, reuse, minimal Tasks) without bypassing safety gates.

## 1. Choose and start a Job

Use Relay for durable multi-Task work with explicit objectives and acceptance criteria.

Consult CLI help; examples:

```sh
npx --yes --package agents-relay@latest agents-relay --help
npx --yes --package agents-relay@latest agents-relay job create --repo LOCAL_ROOT_NAME --project-root /absolute/path/to/git-root --title "Objective" --objective-file job.md --initial-plan
npx --yes --package agents-relay@latest agents-relay job show --id JOB_ID
npx --yes --package agents-relay@latest agents-relay task list --repo LOCAL_ROOT_NAME --id JOB_ID
```

`job.repository` is the local Git root directory name and `job.projectRoot` is its immutable canonical path. Every Neo Project (`vlog`, `toyalive-3d`, etc.) has an independent Git root; no `job.projectPath` field exists. Remote owner/repository metadata is not part of Job identity. Use returned Job IDs. Omit `--initial-plan` for DRAFT-only or Coordinator Graph work. Local Git is the source of truth for review and merge; GitHub authentication and PRs are not part of Job execution.

Read `contracts/task-job-contract.md` before authoring or changing Jobs or Tasks and `contracts/orchestrator-workflows.md` when handling initial planning, P0/self Jobs, or merge/delivery boundaries. For content work, load the active Neo Project rules, its Agent Graph if present, and the relevant stage contracts—not a presumed universal production sequence.

## 2. Plan and execute

`job create --initial-plan` starts Planner; `plan` advances an existing DRAFT Job. Direct `task create` is for orchestrator-authored Tasks. Describe outcomes/dependencies, not shell commands. Public outputs: `--output local-git` or `--output file --output-path PATH`; historical SQLite `task_pr` means local Git work. Include `storySize`; `skills`, `model`, and `reasoning` are advisory. See `contracts/agent-contract.md`.

An execution Prompt pins a Skill/package version, Role, contracts, Task/Plan ID and execution ID. Use **that exact published npm version** when it differs from current `latest`; never substitute a local checkout or a different major/minor version. Before acting, load execution-bound context:

```sh
# RELAY_VERSION comes from the execution Prompt's pinned published package.
npx --yes --package "agents-relay@${RELAY_VERSION}" agents-relay task context --id JOB --task-id TASK --execution-id EXECUTION
npx --yes --package "agents-relay@${RELAY_VERSION}" agents-relay plan context --id JOB --plan-id PLAN --execution-id EXECUTION
```

Task/Planner context rejects stale identities. Planner submits via `apply_cli`; only `PLAN_APPLIED:<plan-id>:<execution-id>` proves application. Delegated Tasks remain durable.

### Plan-free Coordinator / DAG execution

`agentGraph` is a dependency DAG: one durable Coordinator Task plus one durable Agent Task per ready node. Coordinator owns the Graph without a Worker lease. Script/Model Tasks share retry, review and terminal semantics; terminal events immediately release successors, respecting capacity and dependencies.

To create a plan-free Coordinator Job, include its Graph and execution paths
**in the original Job creation**, atomically with the durable Job. For example:

```sh
npx --yes --package agents-relay@latest agents-relay job create --repo LOCAL_ROOT_NAME --project-root /absolute/project/root --title "Episode" \
  --objective-file job.md \
  --coordinator-graph-file /absolute/project/graph.mmd \
  --coordinator-input-file /absolute/run/neo-project-run.input.md \
  --coordinator-output-path /absolute/run/neo-project-run.result.json \
  --coordinator-project-root /absolute/project \
  --coordinator-workspace-root /absolute/workspace \
npx --yes --package agents-relay@latest agents-relay job run --repo LOCAL_ROOT_NAME --id JOB_ID --task-id NUMERIC_TASK_ID \
  --workspace-root /absolute/workspace
# Immediate CLI execution and live events (no background scheduling wait):
# append --foreground to the `job run` invocation.
```

Creation atomically persists a DRAFT Job and numeric Coordinator Task ID; reuse returned `taskId` for activation and caller Run bindings. DAG identity is `parentTaskId`/`nodeId`/`graphHash`. Normal activation queues; `--foreground` runs immediately and prints events, retaining durable state on interruption. `neo project run` binds and resumes the same Job. Reject legacy shortcut flags/modes. Final Review (`--review`/`--no-review`) and local merge (`--auto-merge`/`--no-auto-merge`) remain independent Job policies.

## 3. Verify, review, and recover

Inspect Tasks with the version-matched published CLI. Final Review: `npx --yes --package agents-relay@latest agents-relay review job --repo LOCAL_ROOT_NAME --id JOB_ID [--thread-id THREAD_ID]`. Agent review: `npx --yes --package agents-relay@latest agents-relay review run --prompt-file PATH --project-path DIR` (standalone context only; never `job.projectPath`).

Process exit or Preview receipt is not completion. Emit `task.started`, optional `task.progress`, and one correlated `task.completed` or `task.failed` through `events-bus`; never `task.blocked`. Verified reviewer findings use `task.completed` with `data.verdict: changes-required`, `data.head_sha` and actionable findings; unverifiable reviews fail. See `contracts/event-contract.md` and `contracts/worker-self-review.md`.

**Diagnose before retrying** failed Tasks; inspect events and `contracts/task-recovery-flows.md` (external prerequisites: `contracts/blocker-job-recovery.md`). Use the version-matched published CLI for `task recover --task-id ORIGINAL --recovery-task-id TROUBLESHOOTER` or verified human-only `task escalate`; a stale receipt is not resolution.

## 4. Configured escalation and host-owned Interactive Review

`npx --yes --package agents-relay@latest agents-relay escalation` requires configured `AGENTS_RELAY_ESCALATION_COMMAND`; missing/broken configuration is a technical failure. `task escalate` instead escalates a Task.

For host-owned Review use `npx --yes --package agents-relay@latest agents-relay review interactive --path ABS --id JOB --task-id TASK --execution-id EXEC`. Neo `review.preview` or Markcut owns Preview; receipt is not approval. Approve or Request Changes resumes the same Task; each execution owns at most one Review. Durable feedback is not a Git commit.

## 5. Manage services when needed

For service operations load `daemon-service-manage`. Use `node <skill-dir>/bin/services.mjs setup|status|doctor`. Never restart Relay for ordinary Job commands or create legacy PM2 names.
