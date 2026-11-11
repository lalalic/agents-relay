---
name: agents-relay
description: Use Agents Relay for durable multi-step or multi-agent work that needs Jobs and Tasks, planning, dependencies, independent review, failure recovery, human escalation, or progress across sessions. Also use it for content production with real approval/handoff boundaries. Use direct tools instead for one-shot work without durable coordination.
---

# Agents Relay

Agents Relay manages durable Jobs and Tasks. Use its CLI for Job/Task state and actions; do not read its private storage, GitHub projections, or internal service APIs. Prefer completing simple, non-delegated work directly without Relay.

## Job Execution Lifecycle (JEL)

Explain **JEL** to the user: **Create → Plan → Execute → Final Review → Merge → Completed**. After work/recovery Tasks terminate (SUCCEEDED/FAILED/CANCELLED), Final Review judges completion: PASS merges; CHANGES_REQUIRED persists findings, starts Planner N+1 for minimal fixes, then re-reviews. No automatic post-success Plan. Planner/Workers use discovered **ponytail** Skill (YAGNI, reuse, minimal Tasks); preserve mandatory safeguards.

## 1. Choose and start a Job

Use Relay when the objective requires independent Tasks, durable progress, retries, review, or cross-session handoffs. Capture the full user objective, decisions, constraints, acceptance checks, and delivery expectations in standalone Markdown before creating a Job. A fresh agent must be able to act without the originating conversation. Put a Mermaid diagram before its explanation only when it clarifies a real workflow.

For ordinary CLI use, consult `npx agents-relay --help` and `npx agents-relay <command> --help` rather than memorizing all flags. Examples:

```sh
npx agents-relay job create --repo OWNER/REPO --title "Objective" --objective-file job.md --initial-plan
npx agents-relay job show --id JOB_ID
npx agents-relay task list --repo OWNER/REPO --id JOB_ID
```

Use the **Job ID returned by create**; do not invent an ID, PR number, or Task. Omit `--initial-plan` only for explicitly create-only work. Existing GitHub PRs are not imported as Jobs; GitHub is audit-only and local Git owns merge/delivery. For local-only work, consult the CLI's `--no-github` option.

Read `contracts/task-job-contract.md` before authoring or changing Jobs or Tasks and `contracts/orchestrator-workflows.md` when handling initial planning, P0/self Jobs, or merge/delivery boundaries. For content work, load the active Neo Project rules, its Agent Graph if present, and the relevant stage contracts—not a presumed universal production sequence.

## 2. Plan and execute

Usually let `job create --initial-plan` establish the first Planner round; use `plan` for an existing create-only Job. Direct `task create` is for deliberately orchestrator-authored work. Tasks describe verifiable outcomes, **not shell commands**. Declare exactly one durable result (`task_pr` or `file`), meaningful dependencies, and `storySize`; Relay chooses worker/model routes unless the task truly needs a specific capability.

An assigned **execution Prompt** pins a specific Skill version and supplies Role, Bootstrap, Contracts, Contexts, and Task/Plan identity. Preserve these references. Resolve the matching CLI as `../../dist/cli.js` relative to the pinned Skill directory; do **not** substitute an unrelated globally installed CLI. Before acting, load the exact execution-bound context:

```sh
node <matching-absolute-dist/cli.js> task context --id JOB --task-id TASK --execution-id EXECUTION
node <matching-absolute-dist/cli.js> plan context --id JOB --plan-id PLAN --execution-id EXECUTION
```

These are alternative commands for Task and Planner executions. Both fail closed for stale identities. Optional `--repo` further constrains Job identity. Do not reconstruct task content from PR comments or guessed local files. The Planner submits its candidate through the returned `apply_cli`; only the exact `PLAN_APPLIED:<plan-id>:<execution-id>` receipt proves application. Follow the assigned Role and independent Contracts; load optional context only when the work requires it. Authorized delegation creates durable Relay child Tasks, not untracked agent processes.

## 3. Verify, review, and recover

Use the pinned CLI to inspect authoritative status, Task events, comments, and review evidence. For SHA-bound final Job review, use `agents-relay review job --repo OWNER/REPO --id JOB_ID [--thread-id THREAD_ID]`; for independent Agent-owned outcome review, use `agents-relay review run --prompt-file PATH --project-path DIR`.

A worker's process exit, browser submission receipt, or emitted event is **not** proof of durable completion. Task agents publish `task.started`, optional `task.progress`, and exactly one correlated terminal `task.completed` or `task.failed` via the canonical `events-bus` capability. Never emit `task.blocked` as a worker terminal outcome. Read `contracts/event-contract.md` for exact identity, event semantics, and reviewer verdict payloads; implementation agents also follow `contracts/worker-self-review.md`.

A Reviewer finding defects in a known immutable head emits `task.completed` with `data.verdict: changes-required`, `data.head_sha`, and actionable findings—not `task.failed`. If the Reviewer cannot establish the required head or produce a valid review, it reports an execution failure with `task.failed`, not an invented verdict.

For a failed Task, diagnose before retrying. Read `contracts/task-recovery-flows.md` for recovery and human escalation boundaries. For authorized technical prerequisites in another repository, use `contracts/blocker-job-recovery.md` and the pinned `blocker ensure` CLI action; repository boundaries alone do not justify escalation. Troubleshooter inspects the original Task via `task show` and paginated `task events`, verifies the root cause, then uses the pinned CLI `task recover --task-id ORIGINAL --recovery-task-id TROUBLESHOOTER` only after proving the repair. Only a genuinely human-required decision justifies the **pinned CLI** `task escalate --task-id TROUBLESHOOTER --required-action ... --resolution-condition ...`; this is a Relay operation, **not** an Events Bus event. Never invent or publish an escalation event, and never escalate a browser-readiness failure as a login request without authentication evidence. Only Relay can block/unblock a Troubleshooter; after a human response, recheck the blocker before recovering the original Task. Do not silently treat missing or stale evidence as success.

## 4. Configured escalation and host-owned Interactive Review

`agents-relay escalation` executes the canonical Escalation Graph using only
`AGENTS_RELAY_ESCALATION_COMMAND` provided by the operator's environment. The
value is either an **absolute executable path** or a JSON argv array with an
absolute executable first (for example
`'["/opt/homebrew/bin/neo","escalation"]'` on a host explicitly using Neo).
Relay appends `--handoff-file`, optional `--on-needs-user-file` and `--cwd`.
No Shell expansion or default `neo` call is allowed. Missing or broken
configuration returns `technical_failure`; it must never be treated as
`resolved` or `needs_user`. This direct escalation command is distinct from
`task escalate`, which is the durable Troubleshooter/human-blocker transition.

For human Preview/Review, use the **existing** Relay
`review.interactive.begin/wait/ready/fail/abort` lifecycle. Relay provides the
execution-bound invocation and decision contract and emits a provider-neutral
`task.interactive_waiting` with `source.component: interactive-review`.
Preview media compilation, delivery (for example Markcut to Neo Mobile),
notifications, and UI are owned by the calling project/provider. Never invent
an approval from a compile receipt or a preview handoff, never replace the
exact event template with a provider-specific event, and never create an
unnecessary separate Preview Provider framework. A managed Preview inside a
Shortcut uses the original Task identity, not a Review child Task; the
Shortcut returns `WAITING_REVIEW` after the host durably suspends it, and
resumes the same Task after an authenticated decision. Neo Preview commits
Run Git changes automatically; do not invoke a separate checkpoint command.
Consult the project's Review/Preview contract for version binding.

## 5. Manage services when needed

For setup, outages, or persistent service health checks, load the separate `daemon-service-manage` Skill. The Relay Skill provides `bin/services.mjs`: run `node <pinned-skill-dir>/bin/services.mjs setup|status|doctor` as applicable. Do not start or restart services for ordinary Job operations, or create legacy unqualified PM2 names.
