export const usage = 'agents-relay <job|task|plan|blocker|context|init|record|agent-register|agent-discover|status|reconcile|tick|serve> [options]';
const help = {
  root: `Agents Relay coordinates durable asynchronous agent jobs through GitHub pull requests.

Usage:
  npx agents-relay <command> [options]

Commands:
  job create|update|show|list|merge|cancel  Manage durable GitHub-backed jobs
  task create|update|show|list|complete|retry|cancel  Manage durable tasks
  plan                     Invoke the Planner for an existing managed Job
  blocker add|resolve|show  Manage cross-Job blocker dependencies
  context resolve          Resolve shared project instructions, skills, agents, and runtimes
  init                     Create a local demo job or initialize a GitHub job
  record                   Backfill a completed task into durable history
  agent-register           Register an agent role and its capabilities
  agent-discover           Find registered agents matching hard filters
  status                   Show live aggregate runtime status from agents-relayd
  reconcile                Run reconciliation once
  tick                     Run the indexed autonomous scheduler heartbeat
  serve                    Run the dashboard and reconciliation service

Run 'npx agents-relay <command> --help' for command options and examples.
Use 'node dist/cli.js' only for explicit local development/demo mode.`,
  job: `Manage GitHub-backed durable jobs.

Usage:
  npx agents-relay job <create|update|show|list|merge|cancel> [options]

Actions:
  create  Create a durable Job, optionally binding an existing unmanaged PR
  update  Partially update mutable metadata on a healthy existing Job
  show    Show one durable Job
  list    List managed Jobs in a repository
  merge   Merge the backing PR and complete the Job
  cancel  Close the backing PR and cancel the Job

Common options:
  --repo OWNER/REPO       GitHub repository
  --id JOB_ID             Durable job identifier
  --pr NUMBER             Existing PR number

Example:
  npx agents-relay job show --repo OWNER/REPO --pr 12 --id job-1`,
  'job create': `Create a durable Job and its trusted marker.

Required: --repo OWNER/REPO, --id JOB_ID, and either --head BRANCH or --pr NUMBER.
With --head, reuse/create the PR for that head. With --pr, bind an existing unmanaged PR.
Common: --base BRANCH (default: main), --title TEXT, --objective-file PATH|- (preferred), --objective MARKDOWN (short/simple only), --project-path RELATIVE_PATH, --priority P0|P1|P2|P3, --mode fixed|autonomous, --no-auto-merge, --no-review, --task-fields JSON. --objective and --objective-file are mutually exclusive. For a new --head Job, one is required and must contain enough standalone context to complete the Job without the originating chat/thread. Objective Markdown is also the default PR body; --body is an explicit override.
Job creation never creates executable tasks. The orchestrator decides the initial task batch separately. Re-running create against an already healthy Job is idempotent and does not mutate its metadata.

Example:
  npx agents-relay job create --repo OWNER/REPO --head feat/example --base main --id job-1 --title "Objective" --objective-file job.md`,
  'job update': `Partially update mutable metadata on a healthy existing Job.

Required: --repo OWNER/REPO, --pr NUMBER, and --id JOB_ID.
Mutable: --title, --objective-file PATH|- (preferred) or --objective MARKDOWN, --project-path RELATIVE_PATH, --priority, --mode fixed|autonomous, --schedule, --task-fields JSON, --auto-merge|--no-auto-merge, --review|--no-review, and continuation options. Updating the objective also updates the PR body.
Unspecified fields are preserved. Marker/binding corruption is never repaired implicitly; update fails with a precise diagnostic instead.

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
  'job merge': `Merge the backing pull request and complete the durable Job.

Required: --repo OWNER/REPO, --pr NUMBER, and --id JOB_ID. The current PR head SHA is pinned into the merge request.`,
  'job cancel': `Cancel the durable Job and close its backing pull request.

Required: --repo OWNER/REPO, --pr NUMBER, and --id JOB_ID. Nonterminal Tasks are cancelled before the PR is closed.`,
  status: `Show live aggregate runtime status from the running Agents Relay service.

Usage:
  npx agents-relay status [--host HOST] [--port PORT]

Returns the same summary used by the dashboard header plus a running array with concrete RUNNING task and execution identities. Defaults to 127.0.0.1:8787.`,
  task: `Manage durable tasks.

Usage:
  npx agents-relay task <create|update|show|list|retry|cancel> [options]

Actions:
  create  Create one durable Task under an existing Job
  update  Update mutable Task fields
  show    Show one Task
  list    List Tasks for a Job
  retry   Retry a failed or blocked Task
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
  'task complete': `Complete one orchestrator-owned Task after the creating orchestrator has finished the work.

Required: --task-id ID, --summary TEXT, and the normal Job storage options. The Task must use adapter=orchestrator and be QUEUED or RUNNING. This command is for the same orchestrator turn that created the self-task; it is not a deferred handoff mechanism.`,
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

Managed GitHub jobs are reconciled by agents-relayd. The CLI publishes a job.wake request and does not launch workers; use --events nats.

Example:
  npx agents-relay reconcile --repo OWNER/REPO --pr 12 --id job-1`,
  tick: `Process autonomous jobs indexed into current/recent GitHub next-run buckets.

Required: --repo OWNER/REPO.
Common: --lookback-buckets N (default 3).

Example:
  npx agents-relay tick --repo OWNER/REPO`,
  init: `Initialize a new job. GitHub mode requires --repo and --pr; local mode requires explicit --file.

Common: --id ID, --title TEXT, --objective TEXT, --mode fixed|autonomous, --priority P0|P1|P2|P3.

Example:
  npx agents-relay init --repo OWNER/REPO --pr 12 --id job-1 --title "Objective"`,
  serve: `Run the dashboard and reconciliation service for a managed job.

Required: --file PATH for local demo mode, or --repo OWNER/REPO --pr NUMBER --id JOB_ID.
Common: --port PORT, --interval MS, --events nats.

Example:
  npx agents-relay serve --repo OWNER/REPO --pr 12 --id job-1`,
  'agent-register': `Register an agent role and its execution endpoint.

Required: --file PATH or managed GitHub options, plus --name NAME --responsibility TEXT --role ROLE --endpoint TARGET.
Common: --capabilities a,b, --runtime shell|codex|chatgpt, --provider NAME, --model NAME.

Example:
  npx agents-relay agent-register --file .agents-relay.json --name builder --responsibility "Build code" --role engineer --endpoint shell`,
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
  return command ? help[command as keyof typeof help] ?? help.root : help.root;
}
