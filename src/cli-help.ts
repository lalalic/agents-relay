export const usage = 'agents-relay <job|task|review|artifact|plan|prompt|blocker|projection|escalation|context|init|record|agent-register|agent-discover|status|reconcile|serve> [options]';
const help = {
  root: `Agents Relay coordinates durable asynchronous agent jobs through local SQLite and workflow graphs.

Usage:
  npx agents-relay <command> [options] [--no-github]

--no-github: SQLite/Graph-only mode. GitHub auth/API, PR creation, merge and fetch are disabled. Local completion is Graph-owned.

Commands:
  job create|update|show|list|run|shortcut-receipt|merge|unblock|cancel|pause|resume  Manage SQLite-authoritative jobs with optional GitHub PRs
  task create|update|show|list|revise|classify|complete|retry|unblock|cancel  Manage durable tasks
  review job               Request graph-owned review (optional thread override)
  review interactive       Bind, wait, ready, fail or abort a host-owned human review
  artifact validate        Check a JSON artifact against a project-owned JSON Schema
  plan                     Invoke the Planner for an existing managed Job
  plan apply               Submit a validated Task Tree within one active Plan
  plan context             Read execution-bound Planner context from SQLite
  prompt                   Print raw Planner/Worker prompt from the production Builder
  blocker add|resolve|show  Manage cross-Job blocker dependencies
  projection conflicts|resolve  Inspect and repair deterministic GitHub projection conflicts
  escalation               Run the canonical escalation graph with a configured external executor
  context resolve          Resolve shared project instructions, skills, agents, and runtimes
  init                     Create a local demo job or initialize a GitHub job
  record                   Backfill a completed task into durable history
  agent-register           Register an agent role and its capabilities
  agent-discover           Find registered agents matching hard filters
  status                   Show live aggregate runtime status from agents-relayd
  reconcile                Run reconciliation once
  serve                    Run the dashboard and reconciliation service

Run 'npx agents-relay <command> --help' for command options and examples.
Use 'node dist/cli.js' only for explicit local development/demo mode.`,
  job: `Manage SQLite-authoritative durable jobs.

Usage:
  npx agents-relay job <create|update|show|list|run|shortcut-receipt|merge|unblock|cancel|pause|resume> [options]

Actions:
  create  Create a durable SQLite-authoritative Job
  update  Partially update mutable metadata on a healthy existing Job
  show    Show one durable Job
  run     Activate a create-only Job with a durable Agent Graph Task
  shortcut-receipt  Atomically record a validated nonhuman result for a persisted wait
  list    List managed Jobs in a repository
  merge   Legacy entry point; local Git merge is Graph-owned (no CLI PR merge)
  unblock Authoritatively invalidate current BLOCKED decisions and trigger replanning/resume
  cancel  Cancel the Job through the SQLite/Graph lifecycle (no PR required)
  pause   Persistently stop dispatch and interrupt active generations; lifecycle state remains unchanged
  resume  Clear pause metadata and requeue interrupted work

Common options:
  --repo OWNER/REPO       Required for create; optional Job identity check otherwise
  --id JOB_ID             Durable job identifier

Graph Job activation:
  agents-relay job run --id JOB --task-id TASK
    [--project-path DIR] [--workspace-root DIR]

The Job is created DRAFT without a Planner. This command activates its Graph
Task, then the same Relay Reconciler schedules all durable Agent child Tasks.
Final Review uses --review/--no-review; Merge uses --auto-merge/--no-auto-merge. Both are normal Job policies, independent of the Coordinator start.
The --mode shortcut flag is accepted only as a deprecated CLI input alias.
Historical direct Shortcut checkpoints are read for compatibility.

Record an asynchronous result with:
  agents-relay job shortcut-receipt --id JOB --task-id TASK
    --node-id NODE --wait-id WAIT --revision REV --execution-id EXECUTION
    --output-file result.json --content-sha256 SHA256

The file must contain the completed shortcut result object. SHA256 is computed
over its canonical JSON content and must equal the persisted wait content hash.

Example:
  npx agents-relay job show --id 101`,
  prompt: `Read-only exact PromptBuilder output for a durable Plan or Task.

  agents-relay prompt --id JOB --plan-id PLAN --adapter codex|chatgpt|z [--output FILE]
  agents-relay prompt --id JOB --task-id TASK --adapter codex|chatgpt|z [--output FILE]
  agents-relay prompt --eval-file CASE.json --adapter codex|chatgpt|z [--output FILE]

A detached --eval-file returns JSON with productionPrompt and safe evaluationPrompt from the SAME managedWorkerInput Builder; it never creates or changes a Job.
Raw durable worker-facing text on stdout, no profile wrapper. --repo selects local SQLite,
not GitHub. Old completed Plans are reconstructed from recorded IDs and prior
Task history; their original historical prompt bytes are not persisted. Only
Codex currently has production Planner dispatch. Web Planner variants show the
same Builder message targeting the other transports, not a live delivery.`,
  review: `Use review run for Agent-owned outcome review, review job for final review, or review interactive for host-owned human review.

Outcome: agents-relay review run --prompt-file PATH --agents video-director,market --project-path DIR [--output PATH]
The generic Outcome Reviewer is implicit. Exit 0=PASS, 10=CHANGE_REQUIRED, 20=BLOCKED. The caller owns repair and re-review.

Request a new SHA-bound reviewer turn through the existing Relay lifecycle.

Usage: npx agents-relay review job --repo OWNER/REPO --id JOB_ID [--thread-id THREAD_ID]

When provided, --thread-id persists a reviewer destination; otherwise the Job reviewer thread, then creator thread, then legacy review route is used. The command wakes Relay. Review Task creation, idempotency, routing and delivery remain graph/daemon-owned. Rejects in-flight/queued reviews; does not itself mark review delivered.

Worker-facing: agents-relay review interactive --path /absolute/file.md --id JOB --task-id TASK --execution-id EXEC
This calls Neo review.preview and requests exactly one human review for the current execution. No Git commit or extra invocation ID.
Internal Neo delivery: review interactive begin|wait|fail|abort with --id, --task-id and --execution-id; fail adds --reason.
Task AWAITING_DECISION resumes on an execution-bound Approve or Request Changes event.`,
  artifact: `Check a JSON artifact against a project-owned JSON Schema. Read-only; does not affect Task state or planning.

Usage: agents-relay artifact validate --artifact PATH --schema PATH
Exit 0 on PASS, 1 on schema mismatch or invalid input. Returns JSON { valid, errors }.`,
  'review run': `Evaluate the calling Agent's requested outcome inside its Worker. A generic Outcome Reviewer runs by default; --agents adds comma-separated professional roles found in the project or shared agent catalog. Does not create Relay Tasks or trigger Final Review.

Usage: agents-relay review run (--prompt TEXT | --prompt-file PATH) [--project-path DIR] [--agents role,role] [--output PATH]

Return codes: 0 PASS, 10 CHANGE_REQUIRED, 20 BLOCKED; CLI/worker errors fail separately.`,
  'review job': `Request a review in an existing ChatGPT thread.

Required: --repo OWNER/REPO --id JOB_ID.
Optional: --thread-id THREAD_ID persists a reviewer override; omitted uses Job reviewer/creator thread or legacy route. Rejects pending reviews and wakes managed reconciliation.`,
  'job create': `Create a SQLite-authoritative Job (objective-only).

Required: --repo OWNER/REPO and a standalone Job objective. Job ID defaults to an auto-incrementing store-global number; --id may only reference an existing numeric Job.
Common: --id JOB_ID (optional), --title TEXT, --objective-file PATH|- (preferred), --objective MARKDOWN (short/simple only), --project-path RELATIVE_PATH, --priority P0|P1|P2|P3, --initial-plan, --review|--no-review, --auto-merge|--no-auto-merge, --tag JSON, --reviewer-thread-id ID, --creator-thread-id ID, --implementation-thread-id ID. --objective and --objective-file are mutually exclusive.
Job creation enables auto-merge and Final Review by default. By default it is create-only; --initial-plan validates the first real Planner round before atomically creating the durable Job and Plan, then publishes the normal wake. A Coordinator Job does not require an initial Plan; neither review nor merge behavior changes based on its start point. Re-running create against an already healthy Job is idempotent and does not mutate its metadata.

Example:
  npx agents-relay job create --repo OWNER/REPO --project-path vlog --title "Episode" --objective-file episode.md --initial-plan`,
  'job run': `Activate a create-only Job with a durable Agent Graph Task. No Planner or execution mode is required.

Usage: agents-relay job run --id JOB --task-id TASK [--project-path DIR] [--no-github]

The command activates the normal Job lifecycle and emits a wake-up. The ordinary
Relay Scheduler creates runtime Agent Tasks, runs Script or Model executors,
waits for human review, retries failures and handles completion. A Job may use
ordinary Final Review and Merge policies. The --mode shortcut argument is a
deprecated start alias only; it does not choose an execution engine.`,
  'job update': `Partially update mutable metadata on a healthy existing Job.

Required: --id JOB_ID. Optional: --repo OWNER/REPO verifies the stored Job identity.
Mutable: --title, --objective-file PATH|- (preferred) or --objective MARKDOWN, --project-path RELATIVE_PATH, --priority, --tag JSON, --auto-merge|--no-auto-merge, --review|--no-review, --reviewer-thread-id ID, --creator-thread-id ID, --implementation-thread-id ID, and continuation options. The objective updates local SQLite; PR body changes are independent external actions.
Unspecified fields are preserved. Local Job/PR identity mismatch is rejected.

Example:
  npx agents-relay job update --id 101 --priority P0 --no-auto-merge`,
  'job show': `Show one durable Job.

Required: --id JOB_ID. Optional: --repo OWNER/REPO validates the repository.

Example:
  npx agents-relay job show --id 101`,
  'job list': `List managed Jobs across repositories, or filter by repository.

Optional: --repo OWNER/REPO filters results.

Example:
  npx agents-relay job list`,
  'job merge': `Legacy entry point; external GitHub PR merges are not initiated by this CLI.

Managed Jobs use Graph-owned local merge and publication. Identify a Job with --id JOB_ID; --repo OWNER/REPO is optional.`,
  'job unblock': `Authoritatively unblock BLOCKED Troubleshooter Tasks in one Job.\n\nRequired: --id JOB_ID --reason TEXT. Optional: --repo OWNER/REPO. Each unblocked Troubleshooter is queued as the same Task and must rerun, verify the condition, and issue a fresh resolution before retrying an original failed Task.`,
  'job cancel': `Cancel a durable Job and its unfinished Tasks through the authoritative Relay Graph.

Required: --id JOB_ID. Optional: --repo OWNER/REPO checks identity. No PR number is required.`,
  'job pause': `Pause a durable Job without inventing a PAUSED lifecycle state.

Required: --id JOB_ID. Optional: --repo OWNER/REPO. Running worker and Planner generations are interrupted durably and resume as uncompleted work.`,
  'job resume': `Resume a paused durable Job.

Required: --id JOB_ID. Optional: --repo OWNER/REPO. Interrupted work is requeued and normal reconciliation continues.`,
  escalation: `Run the canonical escalation workflow for a suspected human/external blocker.\n\nRequired: --intent TEXT|--intent-file PATH and --blocked-on TEXT|--blocked-on-file PATH. Optional: --context/--context-file, --on-needs-user/--on-needs-user-file, --cwd. The workflow/escalation.mmd graph invokes an operator-configured executor and owns the resolved / failed / needs_user branches. Only needs_user selects the block-for-user path. Set AGENTS_RELAY_ESCALATION_COMMAND to an absolute executable path or JSON argv array (for example ["/opt/homebrew/bin/neo","escalation"]). No Neo executable is assumed by Relay; missing/broken executors produce technical_failure.`,
  status: `Show live aggregate runtime status from the running Agents Relay service.

Usage:
  npx agents-relay status [--host HOST] [--port PORT]

Returns the same summary used by the dashboard header plus a running array with concrete RUNNING task and execution identities. Defaults to 127.0.0.1:8787.`,
  task: `Manage durable tasks.

Usage:
  npx agents-relay task <create|update|show|events|list|revise|retry|unblock|cancel> [options]

Actions:
  create  Create one durable Task under an existing Job
  update  Update mutable Task fields
  show    Show one Task
  list    List Tasks for a Job
  revise  Submit an immutable-head targeted reviewer fix request
  retry   Retry a FAILED Task
  unblock Authoritatively invalidate a BLOCKED decision
  complete Complete an orchestrator-owned Task
  cancel  Cancel a Task`,
  'task create': `Create one durable Task under an existing Job.

Required: normal Job storage options plus --input-file PATH|- (preferred) or --input MARKDOWN, and --output task-pr|file. --input and --input-file are mutually exclusive.
Common: --task-id ID (optional; Relay auto-assigns a global increasing integer Task ID), --title TITLE (optional; otherwise derived from the first non-empty input line), --idempotency-key KEY, --priority P0|P1|P2|P3, --story-size S|M|L, --agent NAME, --agent-graph-file PATH|-, --deps a,b, --dependency-validity JSON, --parent ID, --draft. The JSON maps declared dependency Task IDs to order-only, revalidate, or rerun. Normal model-backed Tasks omit adapter/provider/model so Relay runs one Execution Router decision over complete worker+model routes. New Tasks are worker-routed; legacy adapter=orchestrator records are recovery-only and cannot be created or manually executed.\nTasks with dependencies start DRAFT; tasks without dependencies start QUEUED unless --draft is given.
Directly-created Tasks are not wrapped in a synthetic Plan. Planner-generated Tasks are created internally by Relay from planner output.

Example:
  npx agents-relay task create --repo OWNER/REPO --id j-5-owner-repo-1 --output file --output-path story.md --input-file task.md`,
  'task update': `Update mutable durable Task fields in place.

Required: --id JOB_ID --task-id ID. Optional --repo OWNER/REPO fences the Job identity.
Mutable while not RUNNING/SUCCEEDED/CANCELLED: --title, --adapter, --priority, --story-size, --input-file PATH|- or --input MARKDOWN, --project, --agent, --agent-graph-file PATH|-, --parent, --deps, --dependency-validity JSON, --capabilities, --timeout (inactivity window), --max-attempts, --provider, --model, --profile, --reasoning, --cwd, --chatgpt-project, --chatgpt-tab-close-policy, --draft, --queue.
Accepted task.started and newer current-execution task.progress events reset --timeout.
Use --clear-routing to remove routing metadata.

Example:
  npx agents-relay task update --repo OWNER/REPO --id 101 --task-id build --adapter chatgpt --provider chatgpt --model gpt-5.6-sol --reasoning high`,
  'task revise': `Authenticated immutable-head targeted revision request from the active Final Reviewer.

Required: --repo OWNER/REPO --id JOB --task-id ORIGINAL --review-task-id FINAL_REVIEW --execution-id CURRENT_REVIEW_EXECUTION --head-sha EXACT_SHA --request-id STABLE_ID --findings-file PATH. The findings file contains a nonempty JSON array [{"id":"F-1","summary":"...","evidence":"..."}].

The Relay service verifies the current Reviewer generation and local Git head, atomically records immutable owner feedback and a semantic child revision. Repeating an identical request ID is idempotent; it does not finish a Reviewer or revision Task. Reviewer must subsequently report its canonical changes-required verdict.`,
  'task comment': `Append an immutable Task comment. Does not retry or change Task state.

Required: --repo OWNER/REPO --id JOB_ID --task-id TASK_ID and --message TEXT or --message-file FILE.`,
  'task comments': `List append-only Task comments.

Required: --id JOB_ID --task-id TASK_ID. Optional --repo OWNER/REPO fences the Job identity.`,
  'task context': `Read the authoritative execution-scoped Task contract.

Required: --id JOB_ID --task-id TASK_ID --execution-id EXECUTION_ID. Optional --repo OWNER/REPO fences the Job identity. Fails closed on stale execution.`,
  'task events': `Read the latest Task-scoped lifecycle events via Relay.

Required: --id JOB_ID --task-id TASK_ID. Optional --repo, --limit 1..60 (default 60), --order asc|desc (default desc), --after CURSOR (for asc). To read full history: start with --order asc --after 0, then repeat with nextCursor until a page has fewer than --limit events. Failure to retrieve history is not success.`,
  'task show': `Show one durable Task.

Required: --task-id ID and the normal Job storage options.`,
  'task list': `List durable Tasks for one Job.

Required: the normal Job storage options.`,
  'task retry': `Retry one durable Task.

Required: --task-id ID and the normal Job storage options.`,
  'task recover': `Retry one failed/blocked durable Task from its active automatic Troubleshooter without cancelling that recovery Task.

Required: --task-id ID, --recovery-task-id TROUBLESHOOTER_ID, and the normal Job storage options.
Optional: --failure-kind adapter_failure|model_failure|provider_failure|task_failure|unknown --reason TEXT [--evidence TEXT] [--reroute] [--exclude-current-route]. Routing changes are atomic with recovery. The recovery Task must be an active Troubleshooter whose parentTaskId is the original Task.`,
  'task cancel': `Cancel one durable Task.

Required: --task-id ID and the normal Job storage options.`,
  'task supersede': `Mark an already-CANCELLED durable Task as superseded by later corrected work through the Task Resolution Graph.\n\nRequired: --task-id ID, --reason TEXT, and the normal managed Job storage options. This does not change Task state and cannot supersede FAILED/BLOCKED/runnable work.`,
  'task classify': `Classify a FAILED work Task as superseded or invalid without changing its Task lifecycle.\n\nRequired: --task-id ID --classification superseded|invalid --target-task-id ID --evidence TEXT --reason TEXT and the normal Job storage options. Unknown or active execution outcomes are rejected.`,
  plan: `Invoke the Planner against the current durable Job state.

Agent submit: agents-relay plan apply --repo OWNER/REPO --id JOB_ID --plan-id PLAN_ID --execution-id EXECUTION_ID --file plan.json. Validation errors reject without partial task writes and can be corrected inside the same Planner execution.

Required: --repo OWNER/REPO and --id JOB_ID.
Optional: --prompt TEXT or --prompt-file PATH|- (mutually exclusive). The prompt is additional guidance for this planning round and never replaces the durable Job objective. --force-restate asks Planner to propose evidence-backed dispositions for failed Tasks inside the Plan. Plan apply validates hypothetical history and forward convergence before one atomic SQLite commit; validation errors leave all SQLite state unchanged and can be corrected in the same Planner execution. Unknown execution outcomes remain unresolved without proof. Text responses are never applied as a Plan.

The command persists one real plan-N round, materializes validated next_tasks with planner provenance, and wakes normal reconciliation. It works for zero-task DRAFT Jobs. Historical planner-N rounds remain readable, but new rounds use plan-N.

Example:
  npx agents-relay plan --repo OWNER/REPO --id 101 --prompt "Plan the full implementation now; keep independent work parallel."`,
  blocker: `Manage durable cross-Job blocker dependencies.

Usage:
  npx agents-relay blocker <add|resolve|show> [options]

The blocker Job owns reverse \`unblocks\` references. \`add\` registers a failed/blocked dependent task. \`resolve\` is the explicit verified-resolution path; merge-mode blockers also resolve automatically after the blocker PR is observed merged.`,
  'blocker add': `Register a dependent failed/blocked Task on a blocker Job.

Blocker: --repo OWNER/REPO --id JOB_ID.
Dependent: --dependent-repo OWNER/REPO --dependent-pr NUMBER --dependent-job JOB_ID --dependent-task TASK_ID.
Common: --resolution merge|verified (default merge).`,
  'blocker ensure': `Create or reuse an authorized cross-repository blocker Job and register its reverse relation.

Dependent: --repo OWNER/REPO --id DEPENDENT_JOB_ID --dependent-task TASK_ID.
Target: --target-repo OWNER/REPO --title TITLE --reason TEXT --objective-file PATH|-.
Identity: --request-id STABLE_REQUEST_ID --origin planner|troubleshooter --resolution merge|verified --authorized.
Target repositories must be configured in the current trusted workspace; target projects must use a normalized repository-relative path.`,
  'blocker resolve': `Resolve a verified blocker and safely requeue matching dependents.

Required: --repo OWNER/REPO --id JOB_ID. This explicit path is required for blockers configured with --resolution verified.`,
  'blocker show': `Show a blocker Job including its durable unblocks relations.`,
  context: `Resolve the shared execution context used by XChat and Relay.

Usage:
  npx agents-relay context resolve --project-path PATH --role ROLE [options]

Actions:
  resolve  Resolve instructions, visible skills/agents, and runtime/delegation metadata`,
  'context resolve': `Resolve shared execution context without creating durable state.

Required: --project-path PATH.
Common: --role orchestrator|planner|reviewer|worker|nested-worker, --skills a,b, --agents a,b.
Root overrides: --workspace-root PATH (or AGENTS_RELAY_WORKSPACE_ROOT), --global-root PATH, --shared-root PATH (or AGENTS_RELAY_SHARED_ROOT). Shared capabilities have no implicit Neo directory.

Example:
  npx agents-relay context resolve --project-path ~/Workspace/agents-relay --role orchestrator`,
  record: `Backfill work completed outside the relay into durable history.

Required: --file PATH or --repo/--id, plus --summary TEXT.
Common: --task-id ID, --commit SHA, --project NAME.

Example:
  npx agents-relay record --file .agents-relay.json --summary "Built release" --commit abc123`,
  reconcile: `Reconcile a job once by requesting one reconciliation pass.

Required: --file PATH for local demo mode, or --repo OWNER/REPO --id JOB_ID.

Managed GitHub jobs are reconciled by agents-relayd. The CLI publishes a job.wake request and does not launch workers; NATS is auto-detected when reachable; use --events nats to require it explicitly. Local/runtime invocations may use --thread-id ID to override the durable reviewer/creator thread for ChatGPT review delivery.

Example:
  npx agents-relay reconcile --repo OWNER/REPO --id 101`,
  init: `Initialize a new job. GitHub mode requires --repo and --pr; local mode requires explicit --file.

Common: --id ID, --title TEXT, --objective TEXT, --priority P0|P1|P2|P3. All Jobs replan to an explicit satisfied objective; execution modes and schedules are unsupported.

Example:
  npx agents-relay init --repo OWNER/REPO --pr 12 --id 101 --title "Objective"`,
  serve: `Run the dashboard and reconciliation service for a managed job.

Required: --file PATH for local demo mode, or --repo OWNER/REPO --id JOB_ID.
Common: --port PORT, --interval MS, --events nats (optional; reachable NATS is auto-detected), --thread-id ID (reviewer-thread override).

Example:
  npx agents-relay serve --repo OWNER/REPO --id 101`,
  'agent-register': `Register an agent role and its execution endpoint.

Required for durable service mode: --repo OWNER/REPO --id JOB_ID plus --name NAME --responsibility TEXT --role ROLE --endpoint TARGET. Use --file only for explicit demo mode.
Common: --capabilities a,b, --runtime shell|codex|chatgpt, --provider NAME, --model NAME.

Example:
  npx agents-relay agent-register --file .agents-relay.json --name builder --responsibility "Build code" --role engineer --endpoint shell`,
  projection: `Inspect and explicitly repair deterministic V2 GitHub projection conflicts.

Usage:
  npx agents-relay projection conflicts --repo OWNER/REPO --id JOB_ID
  npx agents-relay projection resolve --repo OWNER/REPO --id JOB_ID --projection-id ID --action requeue|discard-local

A deterministic same-id/different-definition append conflict is classified once, stops
consuming retry budget, and retains structured diagnostic evidence. It is never
auto-overwritten: an operator resolves it after reconciling the divergent definition.
  requeue        Re-arm the recorded projection after the divergent side is reconciled
  discard-local  Drop the blocked local mutation so a fresh one can be enqueued`,
  'agent-discover': `Find registered agents using hard filters.

Required for durable service mode: --repo OWNER/REPO --id JOB_ID. Use --file only for explicit demo mode.
Common: --capabilities a,b, --runtime NAME, --availability available,busy, --task-kind NAME, --explore.

Example:
  npx agents-relay agent-discover --file .agents-relay.json --capabilities shell`,

} as const;

export function helpText(command?: string, action?: string): string {
  if (command === 'job') return action ? help[`job ${action}` as keyof typeof help] ?? help.job : help.job;
  if (command === 'task') return action ? help[`task ${action}` as keyof typeof help] ?? help.task : help.task;
  if (command === 'context') return action ? help[`context ${action}` as keyof typeof help] ?? help.context : help.context;
  if (command === 'blocker') return action ? help[`blocker ${action}` as keyof typeof help] ?? help.blocker : help.blocker;
  if (command === 'projection') return help.projection;
  return command ? help[command as keyof typeof help] ?? help.root : help.root;
}
