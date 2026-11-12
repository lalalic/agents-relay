---
name: agents-relay
description: Use Agents Relay for durable multi-step or multi-agent work that needs Jobs and Tasks, planning, dependencies, independent review, failure recovery, human escalation, or progress across sessions. Also use it for content production with real approval/handoff boundaries. Use direct tools instead for one-shot work without durable coordination.
---

# Agents Relay

Agents Relay manages durable Jobs and Tasks. Use its CLI for Job/Task state and actions; do not read its private storage, GitHub projections, or internal service APIs. Prefer completing simple, non-delegated work directly without Relay.

## Job Execution Lifecycle (JEL)

Explain **JEL** to the user: **Create → Plan → Execute → Final Review → Merge → Completed**. After work/recovery Tasks terminate (SUCCEEDED/FAILED/CANCELLED), Final Review judges completion: PASS merges; CHANGES_REQUIRED persists findings, starts Planner N+1 for minimal fixes, then re-reviews. No automatic post-success Plan. Planner/Workers use discovered **ponytail** Skill (YAGNI, reuse, minimal Tasks); preserve mandatory safeguards.

## 1. Choose and start a Job

Use Relay for durable multi-Task work. Record the standalone objective, constraints, acceptance checks, and deliverables before Job creation.

Consult CLI help; examples:

```sh
npx agents-relay job create --repo OWNER/REPO --title "Objective" --objective-file job.md --initial-plan
npx agents-relay job show --id JOB_ID
npx agents-relay task list --repo OWNER/REPO --id JOB_ID
```

Use the returned Job ID; never invent IDs. Omit `--initial-plan` only for create-only work. GitHub is audit-only; local Git owns merge. For local-only operations use `--no-github`.

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

Graph Tasks use Relay's ordinary Task Reconciler: `agentGraph` becomes a
**Coordinator** with durable Agent-named children created as dependencies become
ready. Script and Model are Task execution choices; each has the same
Task-level retry, failure and review semantics. `job run --id JOB --task-id TASK` activates any create-only Graph Job and
hands it to that same Reconciler; it is not a separate DAG scheduler or Job
execution mode. Set `--content-only` at creation only when Final Review and
Merge are not required. A Graph needs no Planner unless one is requested.

## 3. Verify, review, and recover

Inspect Task status/events with pinned CLI. Final Review: `agents-relay review job --repo OWNER/REPO --id JOB_ID [--thread-id THREAD_ID]`. Agent review: `agents-relay review run --prompt-file PATH --project-path DIR`.

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
One execution ID identifies at most one review. Preview does **not** create Git
commits, snapshots or independent reviewer Tasks. Legacy in-flight Shortcut
checkpoints remain compatible. See `contracts/event-contract.md`.

## 5. Manage services when needed

For setup, outages, or persistent service health checks, load the separate `daemon-service-manage` Skill. The Relay Skill provides `bin/services.mjs`: run `node <pinned-skill-dir>/bin/services.mjs setup|status|doctor` as applicable. Do not start or restart services for ordinary Job operations, or create legacy unqualified PM2 names.
