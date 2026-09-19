# Agents Relay

Agents Relay is a generic TypeScript runtime for durable asynchronous agent jobs coordinated through GitHub pull requests. GitHub PR comments are the source of truth; events only wake the reconciler and update the dashboard.

## Quick start

For GitHub-backed work, create or adopt the PR through Agents Relay itself. This guarantees the durable job marker exists before any managed task is submitted.

~~~sh
agents-relay job create --repo OWNER/REPO --head feat/example --base main \
  --id job-1 --title "Objective" --body "PR description" --mode fixed

agents-relay submit --repo OWNER/REPO --pr 12 --id job-1 \
  --task-id child --input "echo hello" --adapter shell

agents-relay reconcile --repo OWNER/REPO --pr 12 --id job-1
agents-relay status --repo OWNER/REPO --pr 12 --id job-1
~~~

Jobs default to `fixed`, preserving the original submit-and-run behavior. Use
`--mode autonomous` with `init` or `job create` to make reconciliation own
planner progress. The durable status JSON and dashboard show the mode. An
autonomous runtime needs `--planner-command`; it receives the objective/task
snapshot as JSON on stdin and must return `{ "objective_status": "in_progress"|"satisfied", "assessment": "...", "next_tasks": [...] }`.
Planner-created tasks use stable IDs and the existing parent/subtask tree, so
retries and daemon restarts do not create duplicate work.

job create first resolves an existing open PR with the same head/base, then creates it only when needed. Re-running it is idempotent: it reuses the PR and maintains exactly one trusted agents-relay:job:v1 marker.

To adopt an existing unmanaged PR, including a PR with no comments:

~~~sh
agents-relay job adopt --repo OWNER/REPO --pr 6 --id job-6 --title "Existing objective"
~~~

Use job repair with the same arguments to repair duplicate same-job markers. A conflicting marker for another job is rejected rather than overwritten.

~~~sh
agents-relay job repair --repo OWNER/REPO --pr 6 --id job-6
~~~

Managed GitHub submit/status/reconcile/retry/cancel/serve commands require the durable job marker. If it is missing, the CLI fails with a message directing the caller to job adopt. Orchestrators do not need raw gh PR/comment commands: Agents Relay uses GhApiClient and GitHubStore internally.

The original init command remains supported for backward compatibility:

~~~sh
agents-relay init --repo OWNER/REPO --pr 1 --id job-1 --title "Objective"
~~~

For explicit local demo/test mode:

~~~sh
npm install
npm run build
node dist/cli.js init --file .agents-relay.json --title "Dogfood" --id demo
node dist/cli.js submit --file .agents-relay.json --task-id hello --input "echo hello" --adapter shell
node dist/cli.js reconcile --file .agents-relay.json
node dist/relayd.js --file .agents-relay.json
~~~

Open the dashboard on localhost port 8787. The marker format is intentionally public and append-friendly; the CLI uses GitHubStore with the authenticated gh client in operational mode.

reconcile leases and launches ready tasks without waiting inside the runtime scheduler; the CLI waits only long enough for its launched workers to persist results. agents-relayd (or the equivalent agents-relay serve) is the watchdog/dashboard mode and can use --events nats --subject-prefix PREFIX for optional wakeups. See [docs/service.md](docs/service.md). --file PATH is explicit local demo/test mode only.

`agents-relayd` without `--pr`/`--id` runs in workspace mode by default: it discovers nested Git repositories under `~/Workspace`, keeps only GitHub `origin` remotes, and aggregates their managed PR jobs into one dashboard and worker pool. Pass `--workspace PATH` to use another root. `--repo OWNER/REPO` remains the single-repository pool mode.

V1 assumes one active runner/daemon per job. Use a distributed atomic lease before running multiple reconcilers. Do not put secrets, credentials, private prompts, or large private payloads in PR marker comments; store only summaries and artifact references.

Codex/model-backed tasks require --provider and --model (or equivalent routing metadata) before launch. See [docs/architecture.md](docs/architecture.md) and [SKILL.md](SKILL.md).

The minimal agent-network surface is machine-driven registration and discovery. `agent-register` persists an agent identity, responsibility boundary, claimed capabilities, endpoint/runtime, availability, and routing metadata in a trusted PR marker; `agent-discover` applies hard filters and returns evidence-backed candidates. Adapters remain runtimes, not agent identities. See [docs/architecture.md](docs/architecture.md) for the constrained future remote submission contract.

### ChatGPT workers through MacBridge

Use the chatgpt adapter to make a relay task create a real ChatGPT web conversation through the local MacBridge runtime. The returned ChatGPT conversation_id is stored as the task threadId, so lineage is durable and a retry continues the same conversation.

Managed Codex and ChatGPT worker prompts automatically receive the durable PR URL plus job/task/parent/project context before the original task input. The stored task input is not rewritten.

Each ChatGPT task owns its own conversation. Retries reuse that task's conversation; sibling tasks never share a conversation merely because they use the same adapter. When the job reaches COMPLETED, or GitHub reports the PR merged, Agents Relay deletes every ChatGPT task conversation through MacBridge. The durable threadId remains in the task marker with threadDeletedAt for audit history. Failed deletion records threadCleanupError and is retried on later reconciliation without reopening the terminal job.

~~~sh
agents-relay submit --repo OWNER/REPO --pr 5 --id job-1 \
  --task-id research-ui --adapter chatgpt \
  --capabilities model,chatgpt,macbridge \
  --provider openai --model gpt-5-6-sol --reasoning high \
  --chatgpt-project g-p-EXACT_PROJECT_ID \
  --input "Research the dashboard UX and return implementation guidance."
~~~

The adapter calls MacBridge's loopback-only /experimental/chatgpt/conversation endpoint. Configure it with --macbridge-url and --macbridge-token-file, or AGENTS_RELAY_MACBRIDGE_URL / AGENTS_RELAY_MACBRIDGE_TOKEN_FILE. By default it uses loopback port MAC_DEV_BRIDGE_HTTP_PORT (or 8788) and the MacBridge menu app token file under ~/Library/Application Support/MacDeveloperBridge/http-token. Secrets are read locally and are never stored in PR markers.

GitHub PR state is authoritative for terminal lifecycle: a merged PR reconciles its managed job to `COMPLETED`; a closed, unmerged PR reconciles to `CANCELLED` and cannot launch queued work. The dashboard exposes `/api/jobs` and shows repository-wide managed PR state beside each durable Agents Relay job state so stale markers are visible instead of being mistaken for current truth.

For work that was completed outside the relay but must be represented truthfully in durable history, use `agents-relay record --task-id <id> --summary <summary> --commit <sha>`. Recorded tasks use the `orchestrator` adapter and terminal `SUCCEEDED` state; they do not pretend a shell/model worker executed the work. This is a repair/backfill mechanism—normal work should be submitted before execution. Managed jobs also retain the GitHub PR body as the job description for dashboard display.
