// Direct port of Node src/cli-help.ts: evaluated current local-Git-only help text, preserving JS escape semantics.
#[allow(non_upper_case_globals)] // Public Node export name intentionally preserved.
pub const usage: &str = r##########"agents-relay <job|task|review|artifact|plan|prompt|blocker|escalation|context|init|record|agent-register|agent-discover|status|reconcile|serve|migrate-local-repositories> [options]"##########;
pub const CLI_USAGE: &str = usage;
pub const CLI_HELP_ENTRIES: &[(&str, &str)] = &[
    (
        r##########"root"##########,
        r##########"Agents Relay coordinates durable asynchronous agent jobs through local SQLite and workflow graphs.

Usage:
  agents-relay <command> [options]

Jobs use local Git identity and SQLite lifecycle state. After completion, Relay may push main to configured origin with fast-forward-only semantics.

Commands:
  job create|update|show|list|run|unblock|cancel|pause|resume  Manage SQLite-authoritative local Jobs
  task create|update|show|list|revise|classify|complete|retry|unblock|cancel  Manage durable tasks
  review job               Request graph-owned review (optional thread override)
  review interactive       Bind, wait, ready, fail or abort a host-owned human review
  artifact validate        Check a JSON artifact against a project-owned JSON Schema
  plan                     Invoke the Planner for an existing managed Job
  plan apply               Submit a validated Task Tree within one active Plan
  plan context             Read execution-bound Planner context from SQLite
  prompt                   Print raw Planner/Worker prompt from the production Builder
  blocker add|resolve|show  Manage cross-Job blocker dependencies
  escalation               Run the canonical escalation graph with a configured external executor
  context resolve          Resolve shared project instructions, skills, agents, and runtimes
  init                     Create a local demo Job
  record                   Backfill a completed task into durable history
  agent-register           Register an agent role and its capabilities
  agent-discover           Find registered agents matching hard filters
  status                   Show live aggregate runtime status from agents-relayd
  reconcile                Run reconciliation once
  serve                    Run the dashboard and reconciliation service
  migrate-local-repositories  Migrate canonical SQLite Jobs to local Git identities (daemon stopped)

Run 'agents-relay <command> --help' for command options and examples.
The installed command and local Rust build use the same native implementation."##########,
    ),
    (
        r##########"job"##########,
        r##########"Manage SQLite-authoritative durable jobs.

Usage:
  agents-relay job <create|update|show|list|run|unblock|cancel|pause|resume> [options]

Actions:
  create  Atomically create a durable Job, optionally with its Coordinator DAG Task
  update  Partially update mutable metadata on a healthy existing Job
  show    Show one durable Job
  run     Activate a Coordinator Graph Job; --foreground runs immediately and streams console events
  list    List managed Jobs in a repository
  unblock Authoritatively invalidate current BLOCKED decisions and trigger replanning/resume
  cancel  Cancel the Job through the SQLite/Graph lifecycle
  pause   Persistently stop dispatch and interrupt active generations; lifecycle state remains unchanged
  resume  Clear pause metadata and requeue interrupted work

Common options:
  --repo LOCAL_ROOT_NAME       Local Git root directory name; required local Job identity
  --id JOB_ID             Durable job identifier

Coordinator/DAG creation and activation (no initial Planner required):
  agents-relay job create --repo LOCAL_ROOT_NAME --project-root /absolute/git/root --objective-file job.md
    --preflight=true --project-run-manifest /abs/project/project.run.json --coordinator-graph-file /abs/graph.mmd --coordinator-input-file /abs/input.md
    --coordinator-output-path /abs/result.json --coordinator-project-root /abs/project
    --coordinator-workspace-root /abs/workspace
  agents-relay job run --id JOB --task-id NUMERIC_TASK_ID
    [--project-path /abs/project] [--workspace-root /abs/workspace]
    [--foreground] [--concurrency 4]

Creation atomically stores DRAFT Job and Coordinator Task; activation only
wakes the ordinary Task Reconciler and returns ACTIVE. With --foreground,
the CLI runs that Reconciler directly, prints live Task events, and waits for the
Job to reach a terminal state (Ctrl+C interrupts local workers, but keeps the Job durable for recovery).
The Coordinator owns
one durable Script/Model Task per ready DAG node. After a terminal event,
its successors are dispatched immediately when capacity permits. Independent
Final Review and Git Merge policies remain in force. Review previews do not
create Git commits. No Shortcut Runner or execution mode remains.
Example:
  agents-relay job show --id 101"##########,
    ),
    (
        r##########"prompt"##########,
        r##########"Read-only exact PromptBuilder output for a durable Plan or Task.

  agents-relay prompt --id JOB --plan-id PLAN --adapter codex|chatgpt|z [--output FILE]
  agents-relay prompt --id JOB --task-id TASK --adapter codex|chatgpt|z [--output FILE]
  agents-relay prompt --eval-file CASE.json --adapter codex|chatgpt|z [--output FILE]

A detached --eval-file returns JSON with productionPrompt and safe evaluationPrompt from the SAME managedWorkerInput Builder; it never creates or changes a Job.
Raw durable worker-facing text on stdout, no profile wrapper. --repo selects local SQLite,
not GitHub. Old completed Plans are reconstructed from recorded IDs and prior
Task history; their original historical prompt bytes are not persisted. Only
Codex currently has production Planner dispatch. Web Planner variants show the
same Builder message targeting the other transports, not a live delivery."##########,
    ),
    (
        r##########"review"##########,
        r##########"Use review run for Agent-owned outcome review, review job for final review, or review interactive for host-owned human review.

Outcome: agents-relay review run --prompt-file PATH --agents video-director,market --project-path DIR [--output PATH]
The generic Outcome Reviewer is implicit. Exit 0=PASS, 10=CHANGE_REQUIRED, 20=BLOCKED. The caller owns repair and re-review.

Request a new SHA-bound reviewer turn through the existing Relay lifecycle.

Usage: agents-relay review job --repo LOCAL_ROOT_NAME --id JOB_ID [--thread-id THREAD_ID]

When provided, --thread-id persists a reviewer destination; otherwise the Job reviewer thread, then creator thread, then legacy review route is used. The command wakes Relay. Review Task creation, idempotency, routing and delivery remain graph/daemon-owned. Rejects in-flight/queued reviews; does not itself mark review delivered.

Worker-facing: agents-relay review interactive --path /absolute/file.md --id JOB --task-id TASK --execution-id EXEC
This calls Neo review.preview and requests exactly one human review for the current execution. No Git commit or extra invocation ID.
Internal Neo delivery: review interactive begin|wait|fail|abort with --id, --task-id and --execution-id; fail adds --reason.
Task AWAITING_DECISION resumes on an execution-bound Approve or Request Changes event."##########,
    ),
    (
        r##########"artifact"##########,
        r##########"Check a JSON artifact against a project-owned JSON Schema. Read-only; does not affect Task state or planning.

Usage: agents-relay artifact validate --artifact PATH --schema PATH
Exit 0 on PASS, 1 on schema mismatch or invalid input. Returns JSON { valid, errors }."##########,
    ),
    (
        r##########"review run"##########,
        r##########"Evaluate the calling Agent's requested outcome inside its Worker. A generic Outcome Reviewer runs by default; --agents adds comma-separated professional roles found in the project or shared agent catalog. Does not create Relay Tasks or trigger Final Review.

Usage: agents-relay review run (--prompt TEXT | --prompt-file PATH) [--project-path DIR] [--agents role,role] [--output PATH]

Return codes: 0 PASS, 10 CHANGE_REQUIRED, 20 BLOCKED; CLI/worker errors fail separately."##########,
    ),
    (
        r##########"review job"##########,
        r##########"Request a review in an existing ChatGPT thread.

Required: --repo LOCAL_ROOT_NAME --id JOB_ID.
Optional: --thread-id THREAD_ID persists a reviewer override; omitted uses Job reviewer/creator thread or legacy route. Rejects pending reviews and wakes managed reconciliation."##########,
    ),
    (
        r##########"job create"##########,
        r##########"Create a SQLite-authoritative Job (objective-only).

Required: --repo LOCAL_ROOT_NAME, standalone Job objective, and --preflight=true (exact spelling; all new Jobs). Missing/false/invalid preflight returns JOB_PREFLIGHT_REQUIRED, exit 2, and creates nothing. The flag attests the creator ran Spec Kit Specify/Clarify and independent Preflight Review; it is not stored in SQLite. Job ID defaults to an auto-incrementing store-global number; --id may only reference an existing numeric Job.
Common: --id JOB_ID (optional), --title TEXT, --objective-file PATH|- (preferred), --objective MARKDOWN (short/simple only), --project-root ABSOLUTE_GIT_ROOT, --priority P0|P1|P2|P3, --initial-plan, --review|--no-review, --auto-merge|--no-auto-merge, --tag JSON, --reviewer-thread-id ID, --creator-thread-id ID, --implementation-thread-id ID. --objective and --objective-file are mutually exclusive.
Optional local Git branch binding: --local-merge-source refs/heads/FEATURE --local-merge-target refs/heads/main (both required together). For ordinary code tasks Relay can also bind its isolated local source branch automatically; no remote service or PR is required.
Creation enables auto-merge and Final Review by default. For plan-free DAG
jobs, only neo project run may pass --project-run-manifest PROJECT/project.run.json,
--coordinator-graph-file GRAPH --coordinator-input-file INPUT
--coordinator-output-path ABS --coordinator-project-root ABS
--coordinator-workspace-root ABS to atomically
persist the Job plus one Coordinator Task. Use job run to activate it. Direct unmanaged Coordinator creation is rejected.
Without a Coordinator, create-only DRAFT Jobs can start the Planner with
--initial-plan. Final Review and Git Merge are independent of how work starts.
The --no-review and --no-auto-merge policies are separate; creation is
idempotent and does not rewrite an existing Job.

Example:
  agents-relay job create --repo vlog --project-root /absolute/path/to/vlog --title "Episode" --objective-file episode.md --preflight=true --initial-plan"##########,
    ),
    (
        r##########"job run"##########,
        r##########"Activate a DRAFT Job with a durable Coordinator Agent Graph Task. No Planner or execution mode is required.

Usage: agents-relay job run --id NUMERIC_JOB_ID --task-id NUMERIC_TASK_ID [--repo LOCAL_ROOT_NAME] [--foreground]

The command activates ordinary Job lifecycle and emits a wake-up. It returns
ACTIVE without blocking for all Agent Tasks. The same Job Reconciler creates
Script and Model Tasks, accepts terminal events and directly dispatches newly
ready DAG successors when capacity is available. QUEUED is only the durable
capacity/recovery boundary, not a second scheduled Job. Human review waits,
retry and recovery use the normal Task lifecycle. Final Review and Git Merge
remain ordinary Job policies. No Git commit occurs on interactive review.
There is no Shortcut execution mode."##########,
    ),
    (
        r##########"job update"##########,
        r##########"Partially update mutable metadata on a healthy existing Job.

Required: --id JOB_ID. Optional: --repo LOCAL_ROOT_NAME verifies the stored Job identity.
Mutable: --title, --objective-file PATH|- (preferred) or --objective MARKDOWN, --project-root ABSOLUTE_GIT_ROOT, --priority, --tag JSON, --auto-merge|--no-auto-merge, --review|--no-review, --reviewer-thread-id ID, --creator-thread-id ID, --implementation-thread-id ID, and continuation options. The objective updates local SQLite.
Unspecified fields are preserved. Local Job identity mismatch is rejected.

Example:
  agents-relay job update --id 101 --priority P0 --no-auto-merge"##########,
    ),
    (
        r##########"job show"##########,
        r##########"Show one durable Job.

Required: --id JOB_ID. Optional: --repo LOCAL_ROOT_NAME validates the repository.

Example:
  agents-relay job show --id 101"##########,
    ),
    (
        r##########"job list"##########,
        r##########"List managed Jobs across repositories, or filter by repository.

Optional: --repo LOCAL_ROOT_NAME filters results.

Example:
  agents-relay job list"##########,
    ),
    (
        r##########"job unblock"##########,
        r##########"Authoritatively unblock BLOCKED Troubleshooter Tasks in one Job.

Required: --id JOB_ID --reason TEXT. Optional: --repo LOCAL_ROOT_NAME. Each unblocked Troubleshooter is queued as the same Task and must rerun, verify the condition, and issue a fresh resolution before retrying an original failed Task."##########,
    ),
    (
        r##########"job cancel"##########,
        r##########"Cancel a durable Job and its unfinished Tasks through the authoritative Relay Graph.

Required: --id JOB_ID. Optional: --repo LOCAL_ROOT_NAME checks local identity."##########,
    ),
    (
        r##########"job pause"##########,
        r##########"Pause a durable Job without inventing a PAUSED lifecycle state.

Required: --id JOB_ID. Optional: --repo LOCAL_ROOT_NAME. Running worker and Planner generations are interrupted durably and resume as uncompleted work."##########,
    ),
    (
        r##########"job resume"##########,
        r##########"Resume a paused durable Job.

Required: --id JOB_ID. Optional: --repo LOCAL_ROOT_NAME. Interrupted work is requeued and normal reconciliation continues."##########,
    ),
    (
        r##########"escalation"##########,
        r##########"Run the canonical escalation workflow for a suspected human/external blocker.

Required: --intent TEXT|--intent-file PATH and --blocked-on TEXT|--blocked-on-file PATH. Optional: --context/--context-file, --on-needs-user/--on-needs-user-file, --cwd. The workflow/escalation.mmd graph invokes an operator-configured executor and owns the resolved / failed / needs_user branches. Only needs_user selects the block-for-user path. Set AGENTS_RELAY_ESCALATION_COMMAND to an absolute executable path or JSON argv array (for example ["/opt/homebrew/bin/neo","escalation"]). No Neo executable is assumed by Relay; missing/broken executors produce technical_failure."##########,
    ),
    (
        r##########"status"##########,
        r##########"Show live aggregate runtime status from the running Agents Relay service.

Usage:
  agents-relay status [--host HOST] [--port PORT]

Returns the same summary used by the dashboard header plus a running array with concrete RUNNING task and execution identities. Defaults to 127.0.0.1:8787."##########,
    ),
    (
        r##########"task"##########,
        r##########"Manage durable tasks.

Usage:
  agents-relay task <create|update|show|events|list|revise|complete|retry|unblock|cancel> [options]

Actions:
  create  Create one durable Task under an existing Job
  update  Update mutable Task fields
  show    Show one Task
  list    List Tasks for a Job
  revise  Submit an immutable-head targeted reviewer fix request
  retry   Retry a FAILED Task
  unblock Authoritatively invalidate a BLOCKED decision
  complete Verify a source Worker Git Commit, then atomically finish the current execution
  cancel  Cancel a Task"##########,
    ),
    (
        r##########"task complete"##########,
        r##########"Complete a current DAG file-result Task or commit-required source Task through one server-side validation and Graph gate. NEVER publish task.completed directly for these Tasks.

DAG child Task: agents-relay task complete --repo LOCAL_ROOT_NAME --id JOB --task-id TASK --execution-id CURRENT_EXECUTION [--summary TEXT]
  No --commit-sha. Relay reads ONLY the declared Task output file, validates status COMPLETED, output object, artifact paths and any project.run.json Stage validator before Graph+SQLite Task success and Events Bus terminal publication. Validation errors leave Task RUNNING in the same execution: repair and retry this command.

Commit-required source Task: agents-relay task complete --repo LOCAL_ROOT_NAME --id JOB --task-id TASK --execution-id CURRENT_EXECUTION --commit-sha FULL_GIT_SHA [--summary TEXT]
  Before calling, commit Task changes on its source branch, ensure clean tracked/untracked status, and include exact trailers Relay-Task: TASK_ID and Relay-Execution: CURRENT_EXECUTION. Relay verifies branch HEAD, baseline, ancestry, and immutable source binding before completion. An identical verified completion receipt is idempotent.

Both modes reject stale execution/incorrect repository binding. The daemon (not the CLI) owns validation, Task lifecycle transitions and publication."##########,
    ),
    (
        r##########"task create"##########,
        r##########"Create one durable Task under an existing Job.

Required: --repo LOCAL_ROOT_NAME --id NUMERIC_JOB_ID, --input-file PATH|- (preferred) or --input MARKDOWN, and --output local-git|file. --input and --input-file are mutually exclusive.
--output local-git marks code changes for local Git merge; --output file also requires --output-path PATH. Neither creates a remote request.
Common: --title TITLE (optional; otherwise derived from the first non-empty input line), --idempotency-key KEY, --priority P0|P1|P2|P3, --story-size S|M|L, --agent NAME, --deps 201,202, --dependency-validity JSON, --parent ID, --draft. Relay allocates the store-global increasing numeric Task ID and rejects caller-supplied IDs. The JSON maps declared dependency Task IDs to order-only, revalidate, or rerun. Normal model-backed Tasks omit adapter/provider/model so Relay runs one Execution Router decision over complete worker+model routes. New Tasks are worker-routed; legacy adapter=orchestrator records are recovery-only and cannot be created or manually executed.
Tasks with dependencies start DRAFT; tasks without dependencies start QUEUED unless --draft is given.
Directly-created Tasks are not wrapped in a synthetic Plan. Planner-generated Tasks are created internally by Relay from planner output.

Example:
  agents-relay task create --repo LOCAL_ROOT_NAME --id 101 --output file --output-path story.md --input-file task.md"##########,
    ),
    (
        r##########"task update"##########,
        r##########"Update mutable durable Task fields in place.

Required: --id JOB_ID --task-id ID. Optional --repo LOCAL_ROOT_NAME fences the Job identity.
Mutable while not RUNNING/SUCCEEDED/CANCELLED: --title, --adapter, --priority, --story-size, --input-file PATH|- or --input MARKDOWN, --project, --agent, --parent, --deps, --dependency-validity JSON, --capabilities, --timeout (inactivity window), --max-attempts, --provider, --model, --profile, --reasoning, --cwd, --chatgpt-project, --chatgpt-tab-close-policy, --draft, --queue.
Accepted task.started and newer current-execution task.progress events reset --timeout.
Use --clear-routing to remove routing metadata.

Example:
  agents-relay task update --repo LOCAL_ROOT_NAME --id 101 --task-id 202 --adapter chatgpt --provider chatgpt --model gpt-5.6-sol --reasoning high"##########,
    ),
    (
        r##########"task revise"##########,
        r##########"Authenticated immutable-head targeted revision request from the active Final Reviewer.

Required: --repo LOCAL_ROOT_NAME --id JOB --task-id ORIGINAL --review-task-id FINAL_REVIEW --execution-id CURRENT_REVIEW_EXECUTION --head-sha EXACT_SHA --request-id STABLE_ID --findings-file PATH. The findings file contains a nonempty JSON array [{"id":"F-1","summary":"...","evidence":"..."}].

The Relay service verifies the current Reviewer generation and local Git head, atomically records immutable owner feedback and a semantic child revision. Repeating an identical request ID is idempotent; it does not finish a Reviewer or revision Task. Reviewer must subsequently report its canonical changes-required verdict."##########,
    ),
    (
        r##########"task comment"##########,
        r##########"Append an immutable Task comment. Does not retry or change Task state.

Required: --repo LOCAL_ROOT_NAME --id JOB_ID --task-id TASK_ID and --message TEXT or --message-file FILE."##########,
    ),
    (
        r##########"task comments"##########,
        r##########"List append-only Task comments.

Required: --id JOB_ID --task-id TASK_ID. Optional --repo LOCAL_ROOT_NAME fences the Job identity."##########,
    ),
    (
        r##########"task context"##########,
        r##########"Read the authoritative execution-scoped Task contract.

Required: --id JOB_ID --task-id TASK_ID --execution-id EXECUTION_ID. Optional --repo LOCAL_ROOT_NAME fences the Job identity. Fails closed on stale execution."##########,
    ),
    (
        r##########"task events"##########,
        r##########"Read the latest Task-scoped lifecycle events via Relay.

Required: --id JOB_ID --task-id TASK_ID. Optional --repo, --limit 1..60 (default 60), --order asc|desc (default desc), --after CURSOR (for asc). To read full history: start with --order asc --after 0, then repeat with nextCursor until a page has fewer than --limit events. Failure to retrieve history is not success."##########,
    ),
    (
        r##########"task show"##########,
        r##########"Show one durable Task.

Required: --task-id ID and the normal Job storage options."##########,
    ),
    (
        r##########"task list"##########,
        r##########"List durable Tasks for one Job.

Required: the normal Job storage options."##########,
    ),
    (
        r##########"task retry"##########,
        r##########"Retry one durable Task.

Required: --task-id ID and the normal Job storage options."##########,
    ),
    (
        r##########"task recover"##########,
        r##########"Retry one failed/blocked durable Task from its active automatic Troubleshooter without cancelling that recovery Task.

Required: --task-id ID, --recovery-task-id TROUBLESHOOTER_ID, and the normal Job storage options.
Optional: --failure-kind adapter_failure|model_failure|provider_failure|task_failure|unknown --reason TEXT [--evidence TEXT] [--reroute] [--exclude-current-route]. Routing changes are atomic with recovery. The recovery Task must be an active Troubleshooter whose parentTaskId is the original Task."##########,
    ),
    (
        r##########"task cancel"##########,
        r##########"Cancel one durable Task.

Required: --task-id ID and the normal Job storage options."##########,
    ),
    (
        r##########"task supersede"##########,
        r##########"Mark an already-CANCELLED durable Task as superseded by later corrected work through the Task Resolution Graph.

Required: --task-id ID, --reason TEXT, and the normal managed Job storage options. This does not change Task state and cannot supersede FAILED/BLOCKED/runnable work."##########,
    ),
    (
        r##########"task classify"##########,
        r##########"Classify a FAILED work Task as superseded or invalid without changing its Task lifecycle.

Required: --task-id ID --classification superseded|invalid --target-task-id ID --evidence TEXT --reason TEXT and the normal Job storage options. Unknown or active execution outcomes are rejected."##########,
    ),
    (
        r##########"plan"##########,
        r##########"Invoke the Planner against the current durable Job state.

Agent submit: agents-relay plan apply --repo LOCAL_ROOT_NAME --id JOB_ID --plan-id PLAN_ID --execution-id EXECUTION_ID --file plan.json. Validation errors reject without partial task writes and can be corrected inside the same Planner execution.

Required: --repo LOCAL_ROOT_NAME and --id JOB_ID.
Optional: --prompt TEXT or --prompt-file PATH|- (mutually exclusive). The prompt is additional guidance for this planning round and never replaces the durable Job objective. --force-restate asks Planner to propose evidence-backed dispositions for failed Tasks inside the Plan. Plan apply validates hypothetical history and forward convergence before one atomic SQLite commit; validation errors leave all SQLite state unchanged and can be corrected in the same Planner execution. Unknown execution outcomes remain unresolved without proof. Text responses are never applied as a Plan.

The command persists one real plan-N round, materializes validated next_tasks with planner provenance, and wakes normal reconciliation. It works for zero-task DRAFT Jobs. Historical planner-N rounds remain readable, but new rounds use plan-N.

Example:
  agents-relay plan --repo LOCAL_ROOT_NAME --id 101 --prompt "Plan the full implementation now; keep independent work parallel.""##########,
    ),
    (
        r##########"blocker"##########,
        r##########"Manage durable cross-Job blocker dependencies.

Usage:
  agents-relay blocker <add|resolve|show> [options]

The blocker Job owns reverse `unblocks` references. `add` registers a failed/blocked dependent task. `resolve` is the explicit verified-resolution path; merge-mode blockers resolve against the blocker Job’s authoritative local merge."##########,
    ),
    (
        r##########"blocker add"##########,
        r##########"Register a dependent failed/blocked Task on a blocker Job.

Blocker: --repo LOCAL_ROOT_NAME --id JOB_ID.
Dependent: --dependent-repo LOCAL_ROOT_NAME --dependent-job JOB_ID --dependent-task TASK_ID.
Common: --resolution merge|verified (default merge)."##########,
    ),
    (
        r##########"blocker ensure"##########,
        r##########"Create or reuse an authorized cross-repository blocker Job and register its reverse relation.

Dependent: --repo LOCAL_ROOT_NAME --id DEPENDENT_JOB_ID --dependent-task TASK_ID.
Target: --target-repo LOCAL_ROOT_NAME --title TITLE --reason TEXT --objective-file PATH|-.
Identity: --request-id STABLE_REQUEST_ID --origin planner|troubleshooter --resolution merge|verified --authorized.
Target repositories must be configured in the current trusted workspace; target projects must use a normalized repository-relative path."##########,
    ),
    (
        r##########"blocker resolve"##########,
        r##########"Resolve a verified blocker and safely requeue matching dependents.

Required: --repo LOCAL_ROOT_NAME --id JOB_ID. This explicit path is required for blockers configured with --resolution verified."##########,
    ),
    (
        r##########"blocker show"##########,
        r##########"Show a blocker Job including its durable unblocks relations."##########,
    ),
    (
        r##########"context"##########,
        r##########"Resolve the shared execution context used by XChat and Relay.

Usage:
  agents-relay context resolve --project-path PATH --role ROLE [options]

Actions:
  resolve  Resolve instructions, visible skills/agents, and runtime/delegation metadata"##########,
    ),
    (
        r##########"context resolve"##########,
        r##########"Resolve shared execution context without creating durable state.

Required: --project-path PATH.
Common: --role orchestrator|planner|reviewer|worker|nested-worker, --skills a,b, --agents a,b.
Root overrides: --workspace-root PATH (or AGENTS_RELAY_WORKSPACE_ROOT), --global-root PATH. Agent names resolve through the workspace and project layers.

Example:
  agents-relay context resolve --project-path ~/Workspace/agents-relay --role orchestrator"##########,
    ),
    (
        r##########"record"##########,
        r##########"Backfill work completed outside the relay into durable history.

Required: --file PATH or --repo/--id, plus --summary TEXT.
Common: --task-id ID, --commit SHA, --project NAME.

Example:
  agents-relay record --file .agents-relay.json --summary "Built release" --commit abc123"##########,
    ),
    (
        r##########"reconcile"##########,
        r##########"Reconcile a job once by requesting one reconciliation pass.

Required: --file PATH for local demo mode, or --repo LOCAL_ROOT_NAME --id JOB_ID.

SQLite-backed local Git Jobs are reconciled by agents-relayd. The CLI publishes a job.wake request and does not launch workers; NATS is auto-detected when reachable; use --events nats to require it explicitly. Local/runtime invocations may use --thread-id ID to override the durable reviewer/creator thread for ChatGPT review delivery.

Example:
  agents-relay reconcile --repo LOCAL_ROOT_NAME --id 101"##########,
    ),
    (
        r##########"init"##########,
        r##########"Initialize a local Job using the local Git root identity.

Common: --id ID, --title TEXT, --objective TEXT, --priority P0|P1|P2|P3. All Jobs replan to an explicit satisfied objective; execution modes and schedules are unsupported.

Example:
  agents-relay init --repo LOCAL_ROOT_NAME --id 101 --title "Objective""##########,
    ),
    (
        r##########"serve"##########,
        r##########"Run the dashboard and reconciliation service for a managed job.

Required: --file PATH for local demo mode, or --repo LOCAL_ROOT_NAME --id JOB_ID.
Common: --port PORT, --interval MS, --events nats (optional; reachable NATS is auto-detected), --thread-id ID (reviewer-thread override).

Example:
  agents-relay serve --repo LOCAL_ROOT_NAME --id 101"##########,
    ),
    (
        r##########"agent-register"##########,
        r##########"Register an agent role and its execution endpoint.

Required for durable service mode: --repo LOCAL_ROOT_NAME --id JOB_ID plus --name NAME --responsibility TEXT --role ROLE --endpoint TARGET. Use --file only for explicit demo mode.
Common: --capabilities a,b, --runtime shell|codex|chatgpt, --provider NAME, --model NAME.

Example:
  agents-relay agent-register --file .agents-relay.json --name builder --responsibility "Build code" --role engineer --endpoint shell"##########,
    ),
    (
        r##########"agent-discover"##########,
        r##########"Find registered agents using hard filters.

Required for durable service mode: --repo LOCAL_ROOT_NAME --id JOB_ID. Use --file only for explicit demo mode.
Common: --capabilities a,b, --runtime NAME, --availability available,busy, --task-kind NAME, --explore.

Example:
  agents-relay agent-discover --file .agents-relay.json --capabilities shell"##########,
    ),
];
fn stored(key: &str) -> Option<&'static str> {
    CLI_HELP_ENTRIES
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, content)| *content)
}
pub fn help_text(command: Option<&str>, action: Option<&str>) -> &'static str {
    let command = command.unwrap_or("");
    if matches!(command, "job" | "task" | "context" | "blocker") {
        let extended = action
            .filter(|value| !value.is_empty())
            .map(|action| format!("{command} {action}"));
        return extended
            .as_deref()
            .and_then(stored)
            .or_else(|| stored(command))
            .expect("built-in help entry");
    }
    stored(command).unwrap_or_else(|| stored("root").expect("root help"))
}
