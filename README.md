# Agents Relay

Agents Relay is a TypeScript runtime for durable asynchronous agent Jobs driven locally by SQLite and canonical workflow Graphs. The EventBus wakes reconciliation; an EventBus message or GitHub PR comment is never the lifecycle authority. Job, Plan, Task, Review, Execution, Lease and Recovery state survive daemon restarts in SQLite.

Every Job is keyed by an immutable local Git identity: `repository` is the Git root directory name and `projectRoot` is its validated canonical path. `projectPath` can select a nested directory; worktrees never become Job roots. SQLite owns the durable Job/Task/Review state. Local Git is the source of truth for review and merge. `githubRepo` is optional explicit publishing metadata; GitHub authentication and a PR are unnecessary for the default local workflow.


Agent frontmatter hints (`skills`, `model`, `reasoning`) are described in [Agent Definition Contract](skills/agents-relay/contracts/agent-contract.md). They are advisory only and do not alter Skill resolution or Router constraints.

The canonical V2 architecture contract is
[DESIGN-PRINCIPLES.md](DESIGN-PRINCIPLES.md). README sections below describe
the runtime; they do not replace that contract.

**Escalation executor:** `AGENTS_RELAY_ESCALATION_COMMAND` selects an external
executable (absolute path) or a JSON argv array with a fixed command prefix.
For example, the Neo deployment uses
`AGENTS_RELAY_ESCALATION_COMMAND='["/opt/homebrew/bin/neo","escalation"]'`.
Relay appends `--handoff-file`, optional `--on-needs-user-file`, and `--cwd`
without using a shell. No Neo executable is assumed. Missing/failed executors
produce `technical_failure` rather than silently resolving a blocker.

**Unified Coordinator/DAG L3 gate:** `npm run test:l3:dag` exercises five
three-Agent scenarios: mixed Shortcut/Model without Agent Review, all Shortcut
Approve, Shortcut Request Changes → re-review → Approve, Model Request Changes
→ re-review → Approve, and both Shortcut and Model Request Changes → Approve
within one DAG. The classic five are also part of `npm run test:verification:l3`.
Each scenario uses a disposable local Git repo and isolated SQLite, and verifies
that its temporary directory is removed. Further coverage tests real Job
activation, atomically created Coordinator, event-driven direct successor
dispatch (including parallel branches and resource starvation),
failed Agent recovery and restart/idempotency. Every Agent is a durable Task;
`QUEUED` does not impose another global Job scheduling pass when capacity is
available. The Coordinator has no Worker lease. There is no Shortcut Runner,
separate DAG state machine, Git Review commit, or hidden approval.

**Interactive Review:** Relay owns the generic
`review.interactive.begin/wait/fail/abort` lifecycle, execution-bound
identity and decision correlation. The caller (Neo `review.preview`, backed by Markcut)
owns preview generation, media, UI and notifications. New waiting events use
`component: interactive-review`; existing recorded events retain their history.

**Harness/Project integration:** The intended Relay boundary is standalone and
provider-neutral: callers supply shared Agent/Skill capability sources and a
Job Execution Context, not a Neo installation. The [Harness-independence
specification](docs/harness-independence.md) describes resolution precedence,
Git-root isolation, adapter ownership, acceptance criteria, and **remaining
Neo-specific runtime dependencies**. The decoupling is not yet complete.

For authoritative Task unblock, Resolution ownership, Planner rejection feedback, and failure recovery, see [Unblock and Resolution workflow](docs/unblock-resolution-workflow.md) with its [Mermaid diagram](docs/diagrams/unblock-resolution-end-to-end.mmd).

## V2 architecture

\`\`\`mermaid
flowchart LR
    Human[Human / orchestrator] --> CLI[CLI / Dashboard]
    CLI --> Store[(SQLite / WAL<br/>Job Task Plan Review truth)]
    Worker[Workers / adapters] --> Events[EventBus<br/>wake + observations]
    Events --> Coordinator[ReconcileCoordinator]
    Store --> Coordinator
    Coordinator --> Graphs[Canonical Mermaid Graph Engine]
    Graphs --> Effects[Stateless actions / effects]
    Effects --> Store
    Store --> Views[Dashboard / Recovery]
    Effects --> Outbox[Durable external-action outbox]
    Outbox --> GH[GitHub Commit / PR / Review / Merge API]
    GH --> Facts[Confirmed external facts]
    Facts --> Store
\`\`\`

SQLite holds the sole lifecycle authority; the Graph Engine selects every transition.
GitHub operations are explicitly requested and confirmed by adapters, never used to
discover or reconstruct Job/Task state. EventBus delivery wakes reconciliation;
it cannot replace the durable SQLite record.

### Rust backend — staged native rewrite

The Rust work in [`rust/`](rust/README.md) now includes Graph parity,
transactional SQLite and global Task IDs, an OS-locked **single-node** native Script daemon with a fixture-only,
correlated Model Worker port, parent-death-safe supervision and recovery,
one-time launch claims and atomic terminal receipts, Coordinator DAG creation,
host Review decision/continuation, read-only Final Review eligibility and
process/lease Recovery inspection. Cross-language E2E tests
verify the same SQLite authority; parallel Coordinator ticks deduplicate
child creation. Run `npm run test:rust` for the differential suite.

**Production remains TypeScript.** The separate Rust daemon only accepts
marked temporary SQLite fixtures. Real Codex/Browser provider routing,
Planner/Reviewer execution, full JEL Final Review, production Scheduler
ownership, EventBus and CLI/REST ingress are not yet native. No multi-node
support is planned. A release build or passing isolated tests is
not authorization to start a second writer on the canonical database.

### Workflow graph navigation

| Area | Canonical graph |
| --- | --- |
| Job lifecycle | [`workflow/job-lifecycle.mmd`](workflow/job-lifecycle.mmd) |
| Task lifecycle | [`workflow/task-lifecycle.mmd`](workflow/task-lifecycle.mmd) |
| Review lifecycle | [`workflow/review-lifecycle.mmd`](workflow/review-lifecycle.mmd) |
| Planner trigger | [`workflow/planner-trigger.mmd`](workflow/planner-trigger.mmd) |
| Planner orchestration | [`workflow/planner-orchestration.mmd`](workflow/planner-orchestration.mmd) |
| Blocker resolution | [`workflow/blocker-resolution.mmd`](workflow/blocker-resolution.mmd) |
| Authoritative unblock | [`workflow/authoritative-unblock.mmd`](workflow/authoritative-unblock.mmd) |
| Troubleshooter | [`workflow/troubleshooter.mmd`](workflow/troubleshooter.mmd) |
| Escalation | [`workflow/escalation.mmd`](workflow/escalation.mmd) |
| Related-task action policy | [`workflow/task-related-action.mmd`](workflow/task-related-action.mmd) |

These paths always represent the current canonical graphs. Historical graph definitions are available through Git history, tags, and commits rather than parallel versioned files in `workflow/`. See [`docs/workflow-engine.md`](docs/workflow-engine.md) for the executable profile and runtime boundary.

### Structured runtime observability

`src/observability.ts` is the single structured logging/event boundary that records why a lifecycle or projection decision happened. One correlated record chain (`wake -> graph -> transition -> store commit -> projection outcome`) lets an operator reconstruct a representative task lifecycle without ad-hoc stderr parsing. Records are observational only, never a second durable store; they correlate by repository/PR/job/task/execution, classify failures as deterministic `conflict` vs `transient` retry vs `terminal`, redact secrets/prompts, bound large payloads, and keep routine idle/no-op cycles quiet at the default level. See [`docs/structured-observability.md`](docs/structured-observability.md) for the record contract, fields, noise policy, and redaction rules.

## Quick start

For new work, create a local Job through Agents Relay. GitHub publication requires an explicit `--github-repo OWNER/REPO`; local execution, review, and merge do not depend on GitHub. Tasks are validated against the SQLite Job, not GitHub markers.

~~~sh
cat > job.md <<'EOF'
# Goal

Standalone Job context. Put a Mermaid block first when a workflow/state/architecture diagram helps.
EOF

npx agents-relay job create --repo LOCAL_ROOT_NAME --project-root "$PWD" \
  --title "Objective" --objective-file job.md --initial-plan

# Create-only example: the orchestrator explicitly adds these Tasks.
# For normal autonomous execution, instead pass --initial-plan at creation
# and let the Planner choose the minimal Tasks; do not also create these manually.
cat > task.md <<'EOF'
# Work

Implement this phase using the Job objective as context.
EOF
npx agents-relay task create --repo LOCAL_ROOT_NAME --id JOB_ID \
  --task-id initial --output task-pr --input-file task.md

npx agents-relay task create --repo LOCAL_ROOT_NAME --id JOB_ID \
  --task-id child --output task-pr \
  --input "Implement the described child task and publish a terminal event."

npx agents-relay reconcile --repo LOCAL_ROOT_NAME --id JOB_ID
npx agents-relay job show --id JOB_ID
~~~

Task readiness is explicit: `DRAFT` means the durable task exists but is not executable yet; `QUEUED` means Relay may execute it now; `RUNNING` means worker execution has started. Tasks created with dependencies start `DRAFT` and become `QUEUED` when those dependencies succeed. A dependency-free task created with `--draft` stays held until `task update --queue`. After binding an interactive request, a running Task may enter `AWAITING_DECISION` and release its Worker. Approved or changes-requested decisions requeue the same Task; `BLOCKED` is reserved for Troubleshooter escalation. Ordinary `DRAFT` Tasks remain unstarted/dependency-held.

Mutable draft/queued/retryable task fields can be changed in place without replacing the durable task identity. `task update` rejects `RUNNING`, `SUCCEEDED`, and `CANCELLED` tasks so active execution and terminal history cannot be rewritten. For example:

~~~sh
npx agents-relay task update --repo LOCAL_ROOT_NAME --id JOB_ID --task-id child \
  --adapter chatgpt --provider chatgpt --model gpt-5.6-sol --reasoning high \
  --capabilities model,chatgpt,browser-harness

# Explicitly release a held DRAFT task
npx agents-relay task update --repo LOCAL_ROOT_NAME --id JOB_ID --task-id child --queue
~~~

Jobs separate durable lifecycle from derived runtime status. Durable lifecycle is `DRAFT | ACTIVE | COMPLETED | CANCELLED`: a newly created Job is DRAFT, and creating executable work or starting the Planner activates it. Runtime status (`IDLE`, `WAITING`, `QUEUED`, `RUNNING`, `BLOCKED`, `FAILED`, `REVIEWING`, `MERGE_PENDING`, `MERGED`, or `CANCELLED`) is computed from Tasks, Review, and locally confirmed merge facts and is never persisted as lifecycle truth.

The **Job Execution Lifecycle (JEL)** is Create → Plan → Execute → Final Review → Merge → Completed. All work/recovery Tasks must reach a terminal state (SUCCEEDED, FAILED, or CANCELLED) before Final Review is eligible; terminal failure is evidence for the reviewer, not automatic acceptance. The independent Final Reviewer records findings. A PASS goes to the merge gate; CHANGES_REQUIRED persists findings and starts a minimal Planner N+1 repair round, then another Final Review. No automatic Plan N+1 is created after successful work. Planner and Workers use the discovered `ponytail` Skill to avoid unnecessary tasks without omitting required verification. For operator discussion, call this lifecycle **JEL**.

The Dashboard Job detail includes a **View JEL chart** link. It opens the full-screen graph viewer (Fit, zoom in/out, Ctrl/⌘-wheel zoom, and drag-to-pan) with a read-only Mermaid diagram that shows each persisted Plan, execution round, Final Review (including CHANGES_REQUIRED → Plan N+1), merge stage, and completion status. Every node displays wall-clock elapsed time derived from persisted timestamps (including queued time); missing timing data is labeled **unknown**, not estimated. The JEL popup highlights failed attempts in red, repeated worker attempts (Retry) in purple, and Troubleshooter tasks in amber, as dashed read-only diagnostic branches off their Execute round. Historical failure is shown only when a persisted `recoveryForAttempt` record supports it. The chart never changes Job state. Plan-free Coordinator Jobs show direct execution without a fictitious Plan, followed by normal Final Review and Git Merge.

Lifecycle transition authority lives in the directly renderable canonical flowchart sources linked in [Workflow graph navigation](#workflow-graph-navigation). Git history owns prior graph versions; the working tree contains only the current graph set.

The canonical Mermaid Graph Engine is the authoritative durable workflow decision path. Job/Task lifecycle transitions plus Review, Planner, Blocker/Unblock, and Troubleshooter orchestration branches are defined by the canonical workflow graphs and executed through the shared graph runtime. TypeScript supplies facts and primitive action/effect implementations; it must not duplicate those workflow branches as a second procedural state machine.

Job objectives and Task inputs are Markdown. Prefer `--objective-file` / `--input-file` (use `-` for stdin) for durable long-form context; inline `--objective` / `--input` remain for short/simple text and are mutually exclusive with the file variants. When a diagram materially clarifies the work, put Mermaid first and then Markdown detail. A newly created Job must capture enough context to finish independently of the originating chat. SQLite owns Job metadata and objectives. Any display PR or historical PR marker is a compatibility/audit projection, not the source of lifecycle truth.

Every Job is objective-driven. By default, `job create` persists only a DRAFT
Job; `--initial-plan` also initializes the first real Planner round and its
validated work. For a create-only Job, the caller can add Tasks directly with
`task create` or invoke the Planner explicitly with `plan`. Direct
orchestrator-created tasks are persisted directly and are not wrapped in a
synthetic Plan. `agents-relay plan` works immediately on a zero-task DRAFT Job,
activates it, persists a real `plan-N` planning round, and materializes validated
`next_tasks`. Reconciliation does not invent the first round for an untouched
zero-task DRAFT Job. Once work starts, Relay waits for all work/recovery Tasks
to terminate and triggers Final Review. Only a CHANGES_REQUIRED review verdict
can start the next Planner round; PASS proceeds to the local merge gate.

Manual planning syntax:

~~~sh
npx agents-relay plan --repo LOCAL_ROOT_NAME --id JOB_ID --prompt "Plan the implementation from the durable objective"
npx agents-relay plan --repo LOCAL_ROOT_NAME --id JOB_ID --prompt-file guidance.md
~~~

The optional prompt is additional round guidance; it does not replace the durable Job objective. New planning rounds use `plan-N`; historical `planner-N` records remain readable.

The durable status JSON and dashboard show planning provenance. The runtime uses the bundled `skills/agents-relay/agents/planner.agent.md` by default; `--planner-command` is an optional override
snapshot as JSON on stdin and must return `{ "objective_status": "in_progress"|"satisfied", "assessment": "...", "next_tasks": [...] }`.
Planner-created tasks use stable IDs and the existing parent/subtask tree, so
retries and daemon restarts do not create duplicate work.
Task producers must follow `skills/agents-relay/contracts/task-job-contract.md`; that shared skill contract defines story size, lifecycle events, review, and auto-merge semantics.

Execution routing is code-driven: Relay builds complete executable worker+model routes from authoritative runtime/model/resource facts, merges profile defaults with the user's explicit `[choices]`, deduplicates them, removes only impossible routes via hard gates, then calls the generic typed `decide(request, contract)` boundary exactly once with one merged choice list and the `[routing-instruction]` text forwarded verbatim. Task/resource/capability signals and the routing instruction are soft decision facts; decision failure falls back deterministically to a usable Codex default route. See [Execution Router and typed decisions](docs/worker-model-routers.md).
All task producers use the same story-size contract: `S`≈5 minutes, `M`≈15 minutes, and `L`≈45 minutes of inactivity, with `M` as the default. `high` reasoning doubles that inactivity window. Accepted `task.started` and newer `task.progress` events from the exact current execution reset it. ChatGPT Browser Worker start-ack timeout is derived as one third of the effective inactivity timeout, clamped between 1 and 5 minutes. Orchestrators and planners should choose `storySize`, not raw timeout milliseconds; `--timeout` remains only as an explicit compatibility/debug override.

There is no Job scheduling or cron support. Reconciliation resumes objective planning from durable state, including after a missed wake-up or restart. See [objective-driven Jobs](docs/objective-driven-jobs.md).

GitHub publication is optional and requires an explicit `--github-repo OWNER/REPO`; it is never inferred from the local Git remote. Job creation is create-only by default. A Coordinator may be included atomically by supplying its Graph, input and absolute execution paths. Task execution options belong to `task create`, and the orchestrator may create zero, one, or multiple initial Tasks according to user intent.

Use `job update` for partial mutable metadata changes on an already healthy Job marker/binding:

~~~sh
npx agents-relay job update --id JOB_ID --priority P0 --no-auto-merge
~~~

Request an eligible new review with `npx agents-relay review job --repo LOCAL_ROOT_NAME --id JOB_ID`.
Pass optional `--thread-id THREAD_ID` to persist a reviewer-thread override for subsequent
review routing. Without it, Relay uses the stored reviewer thread, then creator thread,
or the legacy review path when neither exists. This request wakes graph-owned
review orchestration; it is not a delivery receipt.

Review destinations are durable Job facts. `job create` and `job update` accept
`--reviewer-thread-id` and `--creator-thread-id`; a reviewer ID takes precedence
over the creator/origin ID. A local runtime invocation may pass
`--thread-id` as an explicit one-run review override. When a destination exists,
final-review routing requires a ChatGPT/webhelm worker and submits the
review request as a verified `new-turn` to that existing thread with the Job ID,
PR number, and immutable review head SHA. Failure still follows the ordinary
review task retry/recovery path; a transport failure is never treated as
review delivery.

`job update` validates the trusted Job marker first. Missing, malformed, duplicated, mismatched, or conflicting bindings fail with a precise diagnostic and are not repaired implicitly. The orchestrator handles exceptional repair explicitly according to the Job contract, then retries the update. `job show` reads one Job and `job list` lists managed Jobs in a repository.

Managed GitHub task create/update/show/list/retry/cancel and reconcile/serve commands also require a durable Job marker. Orchestrators do not need raw GitHub commands for normal Job creation or metadata updates: Agents Relay uses its authenticated GitHub client internally.

The init command creates a local demo Job from the current Git root:

~~~sh
npx agents-relay init --repo LOCAL_ROOT_NAME --pr 1 --id JOB_ID --title "Objective"
~~~

## npm publishing

Pushes to `main` run `.github/workflows/publish.yml`: install, test, choose the next npm version, pack-check, publish, and create the matching `vX.Y.Z` tag. Feature branches do not edit `package.json` versions. If `agents-relay` is not published yet the first release is `1.0.0`; later releases increment only the patch version from the npm registry. The repository must provide an `NPM_TOKEN` Actions secret with permission to publish the public `agents-relay` package.

Normal consumers should invoke the CLI with `npx agents-relay ...` (or `npx agents-relayd ...`).

After a successful publish, the workflow records one idempotent `agents-relay:package-published:v1` marker comment using local-merge Job metadata. It uses the closed display PR when present, otherwise a reusable `[Agents Relay] Publication events` issue. The GitHub `issue_comment` webhook resolves the embedded Job ID back to its durable SQLite Job and emits a correlated `package.published` events-bus event containing repository, package, version, registry, commit SHA, PR number, and webhook delivery ID. Its source identity is the GitHub delivery (`github/<repository>/delivery/<delivery-id>`), not a worker execution identity.

`package.published` is a release fact, not a service-management command. Agents Relay does not pull packages, restart PM2, or decide which local service consumes a package. An external deployment subscriber may listen for this event, verify that the exact version is pullable, update/restart the affected service, verify its running version and health, and publish its own deployment outcome event. This keeps publication, deployment, and healthy-running as separate facts and removes the need for an orchestrator thread to synchronously wait for npm readiness.

For explicit local demo/test mode:

~~~sh
npm install
npm run build
node dist/cli.js init --file .agents-relay.json --title "Dogfood" --id demo
node dist/cli.js task create --file .agents-relay.json --task-id hello --output task-pr --input "Complete the described task"
node dist/cli.js reconcile --file .agents-relay.json
npx agents-relay serve --file .agents-relay.json
~~~

### Opt-in Temporary Chat quality checks

The normal `npm test` suite does not open a browser or send ChatGPT messages.
For an explicit live check of the one-shot Temporary Chat path, use an
authenticated browser session and run:

~~~sh
npm run test:chatgpt-temp-quality
~~~

This small live suite covers two Temporary Chat submission gates: a normal text
prompt and a prompt with an attachment. It does not exercise worker lifecycle
events, durable-thread reuse, resume, or retry behavior.

Open the dashboard on localhost port 8787. The marker format is intentionally public and append-friendly. Daemon/workspace operation uses `ProjectedDurableStore` over SQLite RelayStore plus the authenticated GitHub projection adapter; GitHubStore is not the daemon operational state database.

Deterministic projection conflicts are safe and observable. A same-id/different-definition `append_task`/`append_plan` is classified once into a durable `conflict` state, stops consuming retry budget, keeps structured divergence evidence, and is never auto-overwritten. Inspect with `agents-relay projection conflicts --repo LOCAL_ROOT_NAME --pr NUMBER` and repair explicitly with `agents-relay projection resolve --repo LOCAL_ROOT_NAME --pr NUMBER --projection-id ID --action requeue|discard-local`. See [docs/architecture-v2.md](docs/architecture-v2.md).

External product feedback uses the reusable `src/feedback.ts` contract. See [docs/feedback-intake.md](docs/feedback-intake.md) for the schema, attachment limits, privacy rules, materialization path, and provenance envelope for later Jobs/Tasks/PRs.

reconcile leases and launches ready tasks without waiting inside the runtime scheduler; the CLI waits only long enough for its launched workers to persist results. agents-relayd (or the equivalent npx agents-relay serve) is the watchdog/dashboard mode. Model-backed workers require --events nats; the event transport carries authoritative terminal worker events as well as wake/progress traffic. See [docs/service.md](docs/service.md). --file PATH is explicit local demo/test mode only.

Router Rules are stored at `~/.agents-relay/execution-router-rules.md` by default and use `[choices]` plus `[routing-instruction]` sections (see the Execution Router doc). `agents-relayd --execution-router-rules PATH` selects a different file for that daemon process; the explicit CLI path takes precedence over `AGENTS_RELAY_EXECUTION_ROUTER_RULES`, which remains supported for compatibility.

`agents-relayd` without `--pr`/`--id` runs in workspace mode by default: it discovers nested Git repositories under `~/Workspace`, identifies each Git root by its unique directory name, and aggregates its local Jobs into one dashboard and worker pool. Pass `--workspace PATH` to use another root. `--repo LOCAL_ROOT_NAME` selects one local repository identity.

For automation, Agents Relay can use GitHub App installation authentication via `AGENTS_RELAY_GITHUB_APP_ID`, `AGENTS_RELAY_GITHUB_APP_INSTALLATION_ID`, and `AGENTS_RELAY_GITHUB_APP_PRIVATE_KEY_FILE` (or matching CLI flags). Webhook mode is local-first: targeted webhook reconciliation is primary, dashboard auto-refresh reads the disposable in-process view restored from SQLite RelayStore state, and the broad watchdog drops to a 30-minute fallback. No separate persisted dashboard Job cache is maintained. See [docs/github-app-rate-limit.md](docs/github-app-rate-limit.md).

Run one logical reconciliation authority per Job. `ReconcileCoordinator` serializes in-process work; use a distributed atomic lease before multiple independent reconcilers own the same Job. Do not put secrets, credentials, private prompts, or large private payloads in the PR-body Job marker or PR-comment Task markers; store only summaries and artifact references.

Model-backed tasks are routed by Relay before launch. Normal task producers omit adapter/provider/model; explicit routing flags remain compatibility/debug constraints. See [docs/architecture.md](docs/architecture.md) and [skills/agents-relay/SKILL.md](skills/agents-relay/SKILL.md).

XChat and other orchestrators can consume Relay's exact shared discovery implementation without duplicating filesystem search logic:

~~~sh
npx agents-relay context resolve --project-path ~/Workspace/agents-relay --role orchestrator
~~~

The command resolves concrete paths only for the current execution. Use `--skills` / `--agents` for explicit selections; no resolved absolute path is written into durable task state.

The minimal agent-network surface is machine-driven registration and discovery. `agent-register` persists an agent identity, responsibility boundary, claimed capabilities, endpoint/runtime, availability, and routing metadata in a trusted PR marker; `agent-discover` applies hard filters and returns evidence-backed candidates. Adapters remain runtimes, not agent identities. See [docs/architecture.md](docs/architecture.md) for the constrained future remote submission contract.

### Agent worker lifecycle

Managed tasks are descriptive work for agents, not shell commands. Use `codex` or `chatgpt` for worker tasks. Commands such as tests, build tools, Markad Vision, ffmpeg, and other CLIs are invoked by the orchestrator or by an executing agent; they are not worker adapters.

Every model-backed task declares a durable output with `--output task-pr` or `--output file --output-path PATH`. Agents Relay bootstraps workers with the managed PR URL, durable task-comment URL, job/task identity, project, output contract, and mandatory terminal-event contract; workers retrieve the task intent from GitHub rather than receiving a duplicate copy of the stored task prompt.

For Codex and ChatGPT, **correlated worker events are authoritative lifecycle inputs**, not a separate durable store. Event publication uses the configured `events-bus` surface (`publish` for sandboxed/hosted workers, or its local CLI helper with `EVENTS_BUS_EVENT_SOURCE` set); Agents Relay subscribes, validates correlation, applies graph transitions, persists results in RelayStore, and projects them to GitHub. Relay publishes `task.process.launched` only after successful adapter launch; `task.started` is worker-owned and must be a new, correlated start acknowledgement. Codex publishes `task.process.exited` when its synchronous runtime exits, while ChatGPT publishes `task.process.async_exited` after its one-shot submission runtime exits; neither substitutes for `task.completed`, `task.failed`, `task.blocked`, or `task.cancelled`. The executing agent must publish exactly one correlated terminal event. Relay persists the matching durable state only from that terminal event. Model-backed tasks require an event bus and time out explicitly if no terminal event arrives.

External execution uses the single global `webhelm` executable installed by the
WebHelm Skill. Before starting Relay, install that Skill through the agent's
normal Skill mechanism and follow the setup instructions in its own
`SKILL.md`. The Skill can live in any directory; its installer links the
global `webhelm` command to the Skill's launcher. Relay calls
`webhelm platform profile chatgpt` before browser workspace initialization.
Relay does not discover Skill directories or invoke a separate runtime.

The ChatGPT adapter uses Relay's `agents/chatgpt-worker.agent.md` lifecycle contract. A new worker uses `webhelm platform run chatgpt new-thread --session-id SESSION_ID --config <file>` in a caller-owned Session. This is a regular persistent ChatGPT thread, which supports the connected Neo MCP in the verified account. Relay closes the Session after submission, but the ChatGPT thread remains in history. Existing-thread review and handoff continue through `new-turn`. File paths are included in the worker message for Neo MCP reading; they are not uploaded as browser attachments. Submission receipts retain `status: submitted`; the event bus owns task completion.

~~~sh
npx agents-relay task create --repo LOCAL_ROOT_NAME --pr 5 --id JOB_ID \
  --task-id research-ui --adapter chatgpt \
  --capabilities model,chatgpt,browser-harness \
  --provider openai --model MODEL \
  --output file --output-path runs/research-ui.md \
  --input "Research the dashboard UX and write the final report to the declared output file."
~~~

SQLite and the canonical Graphs are authoritative for terminal lifecycle.
A remote PR merge/close is audit metadata, not completion evidence. Final
Review PASS authorizes local Git merge; confirmed local-merge evidence gates
`COMPLETED`. The dashboard distinguishes durable Job lifecycle from derived
runtime status. `/api/runtime-summary` counts only RUNNING Tasks of ACTIVE
Jobs with a valid current Worker execution and lease. The Coordinator itself
has no Worker lease, and every Script/Model DAG node is an ordinary Task.
Terminal Task events trigger immediate same-Job Reconciler continuation for
ready successors; the global pool still enforces total Worker capacity.
A human Preview is Task-bound and never auto-commits Git. The retired
Shortcut runtime and receipt path are no longer executable or displayed as
a separate Job mode; normalized historical metadata is ignored. Child Agent
resolution receives configured `--workspace-root` and `--shared-root` roots
identically for Script and Model execution.


Relay has no orchestrator worker adapter for new work. Orchestrators are external clients that create/plan durable Tasks; Execution Router selects a real worker route (`codex` or `chatgpt`). The CLI and dashboard do not expose manual orchestrator-only `task start`, `task complete`, or synthetic `record` paths.

Historical stores may still contain `adapter: orchestrator`. Reconciliation treats that value only as legacy migration evidence: QUEUED work that never started can be converted in place to normal worker requirements; RUNNING work with an unknown outcome is quarantined as BLOCKED instead of replayed; only explicit durable `externalCompletionVerified` evidence can complete legacy work without execution. New Task creation and Task update reject that adapter.

For managed Jobs, SQLite is the canonical collaboration and lifecycle record; an optional GitHub display PR carries audit information only.

### Automatic task troubleshooting

When an ACTIVE Job contains a current-run `FAILED` task, reconciliation may create one P0-priority `troubleshooter` recovery task for that exact failed attempt. `BLOCKED` work is not troubleshooter-owned: it remains blocked until authoritative unblock transitions it to `UNBLOCKED`. The recovery task is routed to a local Codex-capable worker with repository/tool access and runs under the bundled Troubleshooter agent contract. Troubleshooter diagnosis is event-first: it must inspect the failed task's task-scoped lifecycle event history (including ordering, duplicate/missing/late events, source and phase data) before classifying root cause or retrying.

The Troubleshooter diagnoses before retrying. A task-local or transient execution cause is repaired narrowly; a shared worker/runtime/tool defect is repaired through the owning repository's P0/self-job workflow. A suspected human/external blocker enters the canonical [`workflow/escalation.mmd`](workflow/escalation.mmd) graph through `agents-relay escalation`; Troubleshooter does not decide the escalation result branch itself.

```mermaid
flowchart LR
    Failed[Failed task] --> Troubleshooter
    Troubleshooter -->|technical| Repair[Repair / retry]
    Troubleshooter -->|suspected human blocker| Escalation[Escalation graph]
    Escalation --> Invoke[Configured Escalation Executor]
    Invoke --> Provider[External Provider, e.g. Neo]
    Codex -->|resolved| Resume[Resume recovery]
    Codex -->|failed| Technical[Technical recovery evidence]
    Codex -->|needs_user| User[Notify user + task.blocked]
    User --> Unblock[Authoritative unblock]
    Unblock --> Repair
```

The escalation graph is the authority for what happens after Neo returns: `resolved` selects resume recovery, `failed` selects technical-failure handling, and only `needs_user` selects the block-for-user action. Notification mechanics stay caller-described through `--on-needs-user`; Relay does not bind WeChat, Discord, iMessage, or another channel. Only after the failure cause is repaired does Troubleshooter retry the original FAILED task and verify durable progress. Historical resolved failures do not spawn duplicate recovery work, and deterministic reconciliation does not duplicate a Troubleshooter task for the same failed attempt.


### Authoritative unblock and Planner history

Dependency release and runtime unblock are separate concepts. Dependency completion simply releases DAG work. A runtime/external blocker remains `BLOCKED` until `task unblock`, `job unblock`, or blocker-Job resolution records the blocked baseline/current evidence and emits `task.unblocked`, transitioning the Task to `UNBLOCKED`.

For every Job, unblock evidence becomes durable recovery context. Relay retries the same authorized Troubleshooter, while ordinary work uses Planner-owned recovery when necessary. Every Planner round is a first-class `agents-relay:plan:v1` record. It is persisted before generated Tasks, then updated with the Planner assessment and generated Task IDs. Legacy Job `changeCycle` data is accepted only as compatibility input and is not written by the current model.


### Browser Workspace product boundary

Agents Relay owns the persistent `Relay` browser workspace as product infrastructure. At daemon startup it runs `webhelm status`, dynamically imports the returned absolute `admin_helper`, and calls `ensureWorkspace("Relay", 6)`. This bootstrap is best-effort: Browser Workspace discovery/helper failures are logged and skipped so they do not prevent `agents-relayd` from starting; ChatGPT browser work may remain unavailable until Browser Workspace recovers. New ChatGPT workers use a Relay-owned browser Session and close it after verified submission. Existing-thread `new-turn` messages use the durable async queue directly, without creating a browser Session. Relay does not create or delete workspaces through CLI lifecycle commands.

## Shared publication reporting

Repositories with an existing verified publish/release workflow can report the final result back to Agents Relay with the reusable actions in this repository:

```yaml
permissions:
  contents: read
  issues: write
  pull-requests: read

- name: Report verified publication
  uses: lalalic/agents-relay/.github/actions/report-publication@publication-v1
  with:
    token: ${{ github.token }}
    artifact: my-package-or-artifact
    version: ${{ steps.release.outputs.version }}
    channel: https://registry.npmjs.org

- name: Report release failure
  if: ${{ failure() }}
  continue-on-error: true
  uses: lalalic/agents-relay/.github/actions/report-publication-failure@publication-v1
  with:
    token: ${{ github.token }}
    stage: release workflow
```

The caller must report only a release it has actually verified. For local-first Jobs, the action reads the Job ID and optional display PR from the authoritative local-merge commit message and posts the compatible `agents-relay:package-published:v1` or publish-failure marker to that display PR or to a reusable publication issue. Historical GitHub-merged PR correlation remains supported as a fallback. The marker and GitHub webhook are transport/correlation only: Agents Relay resolves the originating Job and persists publication facts through `RelayStore.recordPublication(...)` into the authoritative SQLite `publication_delivery` and `publication_state` tables. Publication success or failure never changes a completed Job's lifecycle state.

`artifact` can identify an npm/PyPI package, Chrome extension, GitHub Release artifact, or a custom published artifact. `channel` identifies the registry/store/release channel and is displayed as publication metadata. Repeated reports of the same artifact/version are idempotent.

### Project-scoped agent Markdown inheritance

Agent lookup has exactly two layers: Relay built-in `skills/agents-relay/agents/` and `<job-context-root>/agents/`. `job.projectPath` selects the context root within the repository (including monorepo content projects); no workspace/global agent fallback is searched. Project agent frontmatter can specify `extends: relay/planner`, `mode: extend`, and `sections: { replace: [Heading/Subheading], extend: [Other Heading] }` using heading paths, or `mode: replace` for a full behavioral replacement. Relay-owned lifecycle, Job/Task and events contracts are injected separately and cannot be replaced by a project agent. An unextended local agent is a standalone definition. The resolver emits a deterministic SHA-256 of composed Markdown; a missing section or unsupported parent fails instead of silently dropping instructions.

### Plan-free Graph Jobs (unified start)

Create a Job without `--initial-plan`, materialize one queued Agent Graph Task,
then activate it with `agents-relay job run --id JOB --task-id TASK`. No
`executionMode` is stored; normal `job run` only activates and publishes a wake-up.
For an immediate foreground run with streaming Task events (no scheduler wait), use
`agents-relay job run --id JOB --task-id TASK --foreground`. This runs the
ordinary Reconciler and waits for a terminal Job state; Ctrl+C interrupts
local workers but preserves durable Job state for normal recovery. Model-backed
Tasks still require the configured Event Bus.
The ordinary Reconciler creates the Coordinator and durable Agent-named Tasks,
with the same Script/Model execution, Task Review, Retry and recovery used by
all other Jobs. Final Review follows the normal `--review`/`--no-review`
policy, and local Git Merge follows `--auto-merge`/`--no-auto-merge`.
Neither policy is affected by starting directly from a Coordinator Task.
New Job creation no longer accepts `--content-only` or `--shortcut-execution`. Historical completed/cancelled Shortcut
records retain their old fields for read-only compatibility.
