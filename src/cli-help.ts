export const usage = 'agents-relay <job|task|review|plan|blocker|projection|escalation|context|init|record|agent-register|agent-discover|status|reconcile|serve> [options]';
const help = {
  root: `Agents Relay coordinates durable asynchronous agent jobs through local SQLite and workflow graphs.

Usage:
  npx agents-relay <command> [options] [--no-github]

--no-github: SQLite/Graph-only mode. GitHub auth/API, PR creation, merge and fetch are disabled. Local completion is Graph-owned.

Commands:
  job create|update|show|list|merge|unblock|cancel  Manage SQLite-authoritative jobs with optional GitHub PRs
  task create|update|show|list|complete|retry|unblock|cancel  Manage durable tasks
  review request           Request graph-owned review (optional thread override)
  plan                     Invoke the Planner for an existing managed Job
  blocker add|resolve|show  Manage cross-Job blocker dependencies
  projection conflicts|resolve  Inspect and repair deterministic GitHub projection conflicts
  escalation               Run the canonical escalation graph and Neo escalation executor
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
  npx agents-relay job <create|update|show|list|merge|unblock|cancel> [options]

Actions:
  create  Create a durable Job, optionally binding an existing unmanaged PR
  update  Partially update mutable metadata on a healthy existing Job
  show    Show one durable Job
  list    List managed Jobs in a repository
  merge   Queue a retryable external PR merge; Graph completes the Job only after confirmation
  unblock Authoritatively invalidate current BLOCKED decisions and trigger replanning/resume
  cancel  Close the backing PR and cancel the Job

Common options:
  --repo OWNER/REPO       GitHub repository
  --id JOB_ID             Durable job identifier
  --pr NUMBER             Existing PR number

Example:
  npx agents-relay job show --repo OWNER/REPO --pr 12 --id job-1`,
  review: `Request a new SHA-bound reviewer turn through the existing Relay lifecycle.

Usage: npx agents-relay review request --repo OWNER/REPO --pr NUMBER --id JOB_ID [--thread-id THREAD_ID]

When provided, --thread-id persists a reviewer destination; otherwise the Job reviewer thread, then creator thread, then legacy review route is used. The command wakes Relay. Review Task creation, idempotency, routing and delivery remain graph/daemon-owned. Rejects in-flight/queued reviews; does not itself mark review delivered.`,
  'review request': `Request a review in an existing ChatGPT thread.

Required: --repo OWNER/REPO --pr NUMBER --id JOB_ID.
Optional: --thread-id THREAD_ID persists a reviewer override; omitted uses Job reviewer/creator thread or legacy route. Rejects pending reviews and wakes managed reconciliation.`,
  'job create': `Create a SQLite-authoritative Job.

Required: --repo OWNER/REPO, --id JOB_ID, and either --head BRANCH or --pr NUMBER.
With --head, reuse/create the PR for that head. With --pr, bind an external PR reference locally without a GitHub query.
Common: --base BRANCH (default: main), --title TEXT, --objective-file PATH|- (preferred), --objective MARKDOWN (short/simple only), --project-path RELATIVE_PATH, --priority P0|P1|P2|P3, --mode fixed|autonomous, --initial-plan, --no-review, --tag JSON, --reviewer-thread-id ID, --creator-thread-id ID. --objective and --objective-file are mutually exclusive. For a new --head Job, one is required and must contain enough standalone context to complete the Job without the originating chat/thread. Objective Markdown is also the default PR body; --body is an explicit override.
Job creation always enables auto-merge. By default it is create-only; --initial-plan follows durable Job creation with the first real Planner round, activates the Job, and publishes the normal wake so Relay can continue without a second orchestrator command. Re-running create against an already healthy Job is idempotent and does not mutate its metadata.

Example:
  npx agents-relay job create --repo OWNER/REPO --head feat/example --base main --id job-1 --title "Objective" --objective-file job.md --initial-plan`,
  'job update': `Partially update mutable metadata on a healthy existing Job.

Required: --repo OWNER/REPO, --pr NUMBER, and --id JOB_ID.
Mutable: --title, --objective-file PATH|- (preferred) or --objective MARKDOWN, --project-path RELATIVE_PATH, --priority, --mode fixed|autonomous, --schedule, --tag JSON, --auto-merge|--no-auto-merge, --review|--no-review, --reviewer-thread-id ID, --creator-thread-id ID, and continuation options. The objective updates local SQLite; PR body changes are independent external actions.
Unspecified fields are preserved. Local Job/PR identity mismatch is rejected.

Example:
  npx agents-relay job update --repo OWNER/REPO --pr 12 --id job-1 --priority P0 --no-auto-merge`,
  'job show': `Show one durable Job.

Required: --repo OWNER/REPO, --pr NUMBER, and --id JOB_ID.

Example:
  npx agents-relay job show --repo OWNER/REPO --pr 12 --id job-1`,
  'job list': `List managed Jobs in a repository.

Required: --repo OWNER/REPO.

Example:
  npx agents-relay job list --repo OWNER/REPO`,
  'job merge': `Request an idempotent external pull-request merge; return QUEUED until confirmed, when the Graph Engine completes the Job.

Required: --repo OWNER/REPO, --pr NUMBER, and --id JOB_ID. The current PR head SHA is pinned into the merge request.`,
  'job unblock': `Authoritatively unblock the effective BLOCKED work Tasks in one Job.\n\nRequired: --repo OWNER/REPO --pr NUMBER --id JOB_ID --reason TEXT. Autonomous Jobs transition blocked work to historical UNBLOCKED state and wake Planner with unblock facts as Plan trigger/context; fixed Jobs record UNBLOCKED first and then resume according to fixed-job retry semantics.`,
  'job cancel': `Cancel the durable Job and close its backing pull request.

Required: --repo OWNER/REPO, --pr NUMBER, and --id JOB_ID. Nonterminal Tasks are cancelled before the PR is closed.`,
  escalation: `Run the canonical escalation workflow for a suspected human/external blocker.\n\nRequired: --intent TEXT|--intent-file PATH and --blocked-on TEXT|--blocked-on-file PATH. Optional: --context/--context-file, --on-needs-user/--on-needs-user-file, --cwd. The executable workflow/escalation.mmd graph invokes Neo escalation, then owns the resolved / failed / needs_user branch. Only needs_user selects the block-for-user path.`,
  status: `Show live aggregate runtime status from the running Agents Relay service.

Usage:
  npx agents-relay status [--host HOST] [--port PORT]

Returns the same summary used by the dashboard header plus a running array with concrete RUNNING task and execution identities. Defaults to 127.0.0.1:8787.`,
  task: `Manage durable tasks.

Usage:
  npx agents-relay task <create|update|show|list|retry|unblock|cancel> [options]

Actions:
  create  Create one durable Task under an existing Job
  update  Update mutable Task fields
  show    Show one Task
  list    List Tasks for a Job
  retry   Retry a FAILED Task
  unblock Authoritatively invalidate a BLOCKED decision
  complete Complete an orchestrator-owned Task
  cancel  Cancel a Task`,
  'task create': `Create one durable Task under an existing Job.

Required: normal Job storage options plus --input-file PATH|- (preferred) or --input MARKDOWN, and --output task-pr|file. --input and --input-file are mutually exclusive.
Common: --task-id ID, --priority P0|P1|P2|P3, --story-size S|M|L, --agent NAME, --agent-graph-file PATH|-, --deps a,b, --parent ID, --draft. Normal model-backed Tasks omit adapter/provider/model so Relay runs one Execution Router decision over complete worker+model routes. Use --adapter orchestrator only for synchronous self-work; explicit adapter/provider/model remain compatibility/debug constraints.\nTasks with dependencies start DRAFT; tasks without dependencies start QUEUED unless --draft is given.
Directly-created Tasks are not wrapped in a synthetic Plan. Planner-generated Tasks are created internally by Relay from planner output.

Example:
  npx agents-relay task create --repo OWNER/REPO --pr 12 --id job-1 --task-id build --output task-pr --input-file task.md`,
  'task update': `Update mutable durable Task fields in place.

Required: --task-id ID and the normal Job storage options.
Mutable while not RUNNING/SUCCEEDED/CANCELLED: --adapter, --priority, --story-size, --input-file PATH|- or --input MARKDOWN, --project, --agent, --agent-graph-file PATH|-, --parent, --deps, --capabilities, --timeout, --max-attempts, --provider, --model, --profile, --reasoning, --cwd, --chatgpt-project, --chatgpt-tab-close-policy, --draft, --queue.
Use --clear-routing to remove routing metadata.

Example:
  npx agents-relay task update --repo OWNER/REPO --pr 12 --id job-1 --task-id build --adapter chatgpt --provider chatgpt --model gpt-5.6-sol --reasoning high`,
  'task show': `Show one durable Task.

Required: --task-id ID and the normal Job storage options.`,
  'task list': `List durable Tasks for one Job.

Required: the normal Job storage options.`,
  'task start': `Mark one orchestrator-owned self Task RUNNING when the creating orchestrator actually begins the work.

Required: --task-id ID and the normal Job storage options. The Task must use adapter=orchestrator and be QUEUED. Start must occur before task complete.`,
  'task complete': `Complete one orchestrator-owned Task after the creating orchestrator has finished the work.

Required: --task-id ID, --summary TEXT, and the normal Job storage options. The Task must use adapter=orchestrator and already be RUNNING. This command is for the same orchestrator turn that created the self-task; it is not a deferred handoff mechanism.`,
  'task retry': `Retry one durable Task.

Required: --task-id ID and the normal Job storage options.`,
  'task cancel': `Cancel one durable Task.

Required: --task-id ID and the normal Job storage options.`,
  plan: `Invoke the Planner against the current durable Job state.

Required: --repo OWNER/REPO, --pr NUMBER, and --id JOB_ID.
Optional: --prompt TEXT or --prompt-file PATH|- (mutually exclusive). The prompt is additional guidance for this planning round and never replaces the durable Job objective.

The command persists one real plan-N round, materializes validated next_tasks with planner provenance, and wakes normal reconciliation. It works for zero-task DRAFT Jobs. Historical planner-N rounds remain readable, but new rounds use plan-N.

Example:
  npx agents-relay plan --repo OWNER/REPO --pr 12 --id job-1 --prompt "Plan the full implementation now; keep independent work parallel."`,
  blocker: `Manage durable cross-Job blocker dependencies.

Usage:
  npx agents-relay blocker <add|resolve|show> [options]

The blocker Job owns reverse \`unblocks\` references. \`add\` registers a failed/blocked dependent task. \`resolve\` is the explicit verified-resolution path; merge-mode blockers also resolve automatically after the blocker PR is observed merged.`,
  'blocker add': `Register a dependent failed/blocked Task on a blocker Job.

Blocker: --repo OWNER/REPO --pr NUMBER --id JOB_ID.
Dependent: --dependent-repo OWNER/REPO --dependent-pr NUMBER --dependent-job JOB_ID --dependent-task TASK_ID.
Common: --resolution merge|verified (default merge).`,
  'blocker resolve': `Resolve a verified blocker and safely requeue matching dependents.

Required: --repo OWNER/REPO --pr NUMBER --id JOB_ID. This explicit path is required for blockers configured with --resolution verified.`,
  'blocker show': `Show a blocker Job including its durable unblocks relations.`,
  context: `Resolve the shared execution context used by XChat and Relay.

Usage:
  npx agents-relay context resolve --project-path PATH --role ROLE [options]

Actions:
  resolve  Resolve instructions, visible skills/agents, and runtime/delegation metadata`,
  'context resolve': `Resolve shared execution context without creating durable state.

Required: --project-path PATH.
Common: --role orchestrator|planner|reviewer|worker|nested-worker, --skills a,b, --agents a,b.
Root overrides for testing/configuration: --workspace-root PATH, --neo-root PATH|none, --global-root PATH.

Example:
  npx agents-relay context resolve --project-path ~/Workspace/agents-relay --role orchestrator`,
  record: `Backfill work completed outside the relay into durable history.

Required: --file PATH or --repo/--pr/--id, plus --summary TEXT.
Common: --task-id ID, --commit SHA, --project NAME.

Example:
  npx agents-relay record --file .agents-relay.json --summary "Built release" --commit abc123`,
  reconcile: `Reconcile a job once by requesting one reconciliation pass.

Required: --file PATH for local demo mode, or --repo OWNER/REPO --pr NUMBER --id JOB_ID.

Managed GitHub jobs are reconciled by agents-relayd. The CLI publishes a job.wake request and does not launch workers; NATS is auto-detected when reachable; use --events nats to require it explicitly. Local/runtime invocations may use --thread-id ID to override the durable reviewer/creator thread for ChatGPT review delivery.

Example:
  npx agents-relay reconcile --repo OWNER/REPO --pr 12 --id job-1`,
  init: `Initialize a new job. GitHub mode requires --repo and --pr; local mode requires explicit --file.

Common: --id ID, --title TEXT, --objective TEXT, --mode fixed|autonomous, --priority P0|P1|P2|P3.

Example:
  npx agents-relay init --repo OWNER/REPO --pr 12 --id job-1 --title "Objective"`,
  serve: `Run the dashboard and reconciliation service for a managed job.

Required: --file PATH for local demo mode, or --repo OWNER/REPO --pr NUMBER --id JOB_ID.
Common: --port PORT, --interval MS, --events nats (optional; reachable NATS is auto-detected), --thread-id ID (reviewer-thread override).

Example:
  npx agents-relay serve --repo OWNER/REPO --pr 12 --id job-1`,
  'agent-register': `Register an agent role and its execution endpoint.

Required: --file PATH or managed GitHub options, plus --name NAME --responsibility TEXT --role ROLE --endpoint TARGET.
Common: --capabilities a,b, --runtime shell|codex|chatgpt, --provider NAME, --model NAME.

Example:
  npx agents-relay agent-register --file .agents-relay.json --name builder --responsibility "Build code" --role engineer --endpoint shell`,
  projection: `Inspect and explicitly repair deterministic V2 GitHub projection conflicts.

Usage:
  npx agents-relay projection conflicts --repo OWNER/REPO --pr NUMBER [--store PATH]
  npx agents-relay projection resolve --repo OWNER/REPO --pr NUMBER --projection-id ID --action requeue|discard-local

A deterministic same-id/different-definition append conflict is classified once, stops
consuming retry budget, and retains structured diagnostic evidence. It is never
auto-overwritten: an operator resolves it after reconciling the divergent definition.
  requeue        Re-arm the recorded projection after the divergent side is reconciled
  discard-local  Drop the blocked local mutation so a fresh one can be enqueued`,
  'agent-discover': `Find registered agents using hard filters.

Required: --file PATH or managed GitHub options.
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
