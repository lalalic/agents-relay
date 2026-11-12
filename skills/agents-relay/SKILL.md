---
name: agents-relay
description: Use Agents Relay for durable multi-step or multi-agent work that needs Jobs and Tasks, planning, dependencies, independent review, failure recovery, human escalation, or progress across sessions. Also use it for content production with real approval/handoff boundaries. Use direct tools instead for one-shot work without durable coordination.
---

# Agents Relay

Relay owns durable Jobs and Tasks. Use its CLI—not private storage or GitHub projections. Handle one-shot work directly.

## Capability tree

Goal: reliably create, inspect, resume, review, and merge a local Git Job, with optional GitHub publishing.

- Create: bind one Job ID to a validated canonical local Git root; optionally create the first Plan or a Coordinator DAG.
- Inspect and resume: use the version-matched CLI and SQLite-backed Job/Task history.
- Review and merge: review the local Git head, then merge through the normal Job gate.
- Publish: use an explicitly configured GitHub remote for external PR effects; publishing is never required for local completion.

## Job Execution Lifecycle (JEL)

Explain **JEL** to the user: **Create → [optional Plan] → Execute → Final Review → Merge → Completed**. A Coordinator Agent Graph does not need an initial Planner; otherwise the same Task/Review/Merge lifecycle applies. After work/recovery Tasks terminate (SUCCEEDED/FAILED/CANCELLED), Final Review judges completion: PASS merges; CHANGES_REQUIRED persists findings, starts Planner N+1 for minimal fixes, then re-reviews. No automatic post-success Plan. Planner/Workers use discovered **ponytail** Skill (YAGNI, reuse, minimal Tasks); preserve mandatory safeguards.

## 1. Choose and start a Job

Use Relay for durable multi-Task work with explicit objectives and acceptance criteria.

Consult CLI help; examples:

```sh
npx agents-relay job create --repo LOCAL_ROOT_NAME --project-root /absolute/path/to/git-root --title "Objective" --objective-file job.md --initial-plan
npx agents-relay job show --id JOB_ID
npx agents-relay task list --repo LOCAL_ROOT_NAME --id JOB_ID
```

`job.repository` is the local Git root directory name and `job.projectRoot` is its immutable canonical path. `job.projectPath` may select a nested directory such as `vlog`. `job.githubRepo` is optional remote metadata for explicit publishing effects. Use returned Job IDs. Omit `--initial-plan` for DRAFT-only or Coordinator Graph work. Local Git is the source of truth for review and merge; no GitHub login is needed for the default workflow.

Read `contracts/task-job-contract.md` before authoring or changing Jobs or Tasks and `contracts/orchestrator-workflows.md` when handling initial planning, P0/self Jobs, or merge/delivery boundaries. For content work, load the active Neo Project rules, its Agent Graph if present, and the relevant stage contracts—not a presumed universal production sequence.

## 2. Plan and execute

Usually let `job create --initial-plan` establish the first Planner round; use `plan` for an existing create-only Job. Direct `task create` is for deliberately orchestrator-authored work. Tasks describe verifiable outcomes, **not shell commands**. Declare exactly one durable result (`task_pr` or `file`), meaningful dependencies, and `storySize`; Relay chooses worker/model routes unless the task truly needs a specific capability.

Agent `skills` suggests Worker skills; `model`/`reasoning` suggest Router preferences. Neither is mandatory (see `contracts/agent-contract.md`).

An assigned **execution Prompt** pins a specific Skill version and supplies Role, Bootstrap, Contracts, Contexts, and Task/Plan identity. Preserve these references. Resolve the matching CLI as `../../dist/cli.js` relative to the pinned Skill directory; do **not** substitute an unrelated globally installed CLI. Before acting, load the exact execution-bound context:

```sh
node <matching-absolute-dist/cli.js> task context --id JOB --task-id TASK --execution-id EXECUTION
node <matching-absolute-dist/cli.js> plan context --id JOB --plan-id PLAN --execution-id EXECUTION
```

Task and Planner context commands reject stale identities. Optional `--repo` constrains the Job. Never infer Task content from GitHub. Planner submits via `apply_cli`; only `PLAN_APPLIED:<plan-id>:<execution-id>` proves application. Authorized delegation creates durable child Tasks.

### Plan-free Coordinator / DAG execution

`agentGraph` is a declarative dependency DAG. Relay persists one Coordinator
Task and one independent **Agent Task for each node as its dependencies become
ready**. The Coordinator owns the Graph but does not lease a Worker or use a
second execution state machine. Script and Model nodes have identical durable
Task lifecycle, retry, recovery, human review and terminal event semantics.
An Agent terminal event **immediately** reconciles and dispatches ready
successors when capacity allows. Otherwise QUEUED retains recovery and fair
admission. Branches can run concurrently; fan-ins await dependencies.

To create a plan-free Coordinator Job, include its Graph and execution paths
**in the original Job creation**, atomically with the durable Job. For example:

```sh
  npx agents-relay job create --repo LOCAL_ROOT_NAME --project-root /absolute/project/root --title "Episode" \
  --objective-file job.md \
  --coordinator-graph-file /absolute/project/graph.mmd \
  --coordinator-input-file /absolute/run/neo-project-run.input.md \
  --coordinator-output-path /absolute/run/neo-project-run.result.json \
  --coordinator-project-root /absolute/project \
  --coordinator-workspace-root /absolute/workspace \
  --coordinator-shared-root /absolute/shared
npx agents-relay job run --id JOB_ID --task-id coordinator \
  --project-path /absolute/project --workspace-root /absolute/workspace \
  --shared-root /absolute/shared
```

Creation atomically persists **DRAFT Job + Coordinator Task**. Activation
returns a scheduled receipt, not completion. Neo's `neo project run` wraps this
creation/binding/activation sequence and resumes an existing Run without
creating a second Job. Do not use legacy `--shortcut-execution`, `--mode
shortcut`, `--shortcut-local`, `--legacy-shortcut-runtime` or receipts.
Final Review (`--review`/`--no-review`) and local Git Merge
(`--auto-merge`/`--no-auto-merge`) are independent ordinary Job policies;
there is no automatic Plan or special content-only completion mode.

## 3. Verify, review, and recover

Inspect Task status/events with pinned CLI. Final Review: `agents-relay review job --repo LOCAL_ROOT_NAME --id JOB_ID [--thread-id THREAD_ID]`. Agent review: `agents-relay review run --prompt-file PATH --project-path DIR`.

Process exit and delivery are not Task completion. Agents publish `task.started`, optional `task.progress`, and one correlated terminal `task.completed` or `task.failed` via `events-bus`; never `task.blocked`. See `contracts/event-contract.md` and `contracts/worker-self-review.md`.

A Reviewer finding defects in a known immutable head emits `task.completed` with `data.verdict: changes-required`, `data.head_sha`, and actionable findings—not `task.failed`. If the Reviewer cannot establish the required head or produce a valid review, it reports an execution failure with `task.failed`, not an invented verdict.

For a failed Task, **diagnose before retrying**. Load
`contracts/task-recovery-flows.md`; for external repository prerequisites load
`contracts/blocker-job-recovery.md`. Troubleshooter inspects the exact Task's
state and paginated event history, proves the technical repair and calls the
pinned `task recover --task-id ORIGINAL --recovery-task-id TROUBLESHOOTER`.
For verified human-only blockers, use pinned `task escalate --task-id ...`;
this is a Relay CLI operation, not an Event. Recheck evidence after escalation;
never treat a stale response or an unverified operation as recovery.

## 4. Configured escalation and host-owned Interactive Review

`agents-relay escalation` runs the canonical Escalation Graph only with
an operator-configured `AGENTS_RELAY_ESCALATION_COMMAND` (absolute executable
or JSON argv with an absolute executable). Missing/broken configuration
returns `technical_failure`, never presumed human resolution. This differs
from the Task Troubleshooter `task escalate` operation.

A Worker requests human Review once in its current execution using
`agents-relay review interactive --path ABS --id JOB --task-id TASK --execution-id EXEC`.
Relay delegates rendering to the configured host (Neo uses `review.preview` and
Markcut). The reviewed Task enters `AWAITING_DECISION`. An inbox/compile receipt
is **not approval**. An accepted Approve resumes the same Agent Task; Request
Changes resumes the same Task with feedback (a scripted Task can switch to its
Model executor for semantic revision, then return to Script for validation).
One execution ID identifies at most one review. Preview does **not** create Git commits, snapshots or independent reviewer Tasks. Review feedback and decisions live in Relay's durable Task history, not a synthetic Git revision. See `contracts/event-contract.md`.

## 5. Manage services when needed

For setup, outages, or persistent service health checks, load the separate `daemon-service-manage` Skill. The Relay Skill provides `bin/services.mjs`: run `node <pinned-skill-dir>/bin/services.mjs setup|status|doctor` as applicable. Do not start or restart services for ordinary Job operations, or create legacy unqualified PM2 names.
