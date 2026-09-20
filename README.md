# Agents Relay

Agents Relay is a generic TypeScript runtime for durable asynchronous agent jobs coordinated through GitHub pull requests. GitHub PR comments store durable workflow state; correlated terminal events are authoritative for model-backed task lifecycle transitions.

## Quick start

For GitHub-backed work, create or adopt the PR through Agents Relay itself. This guarantees the durable job marker exists before any managed task is submitted.

~~~sh
npx agents-relay job create --repo OWNER/REPO --head feat/example --base main \
  --id job-1 --title "Objective" --body "PR description" --mode fixed

# Create/reuse the managed job and submit its initial task atomically
npx agents-relay job create --repo OWNER/REPO --head feat/example --base main \
  --id job-1 --start --task-id initial --adapter codex --provider openai \
  --model MODEL --output task-pr --input "Implement the objective and publish a terminal event."

npx agents-relay submit --repo OWNER/REPO --pr 12 --id job-1 \
  --task-id child --adapter codex --provider openai --model MODEL --output task-pr \
  --input "Implement the described child task and publish a terminal event."

npx agents-relay reconcile --repo OWNER/REPO --pr 12 --id job-1
npx agents-relay status --repo OWNER/REPO --pr 12 --id job-1
~~~

Mutable queued/retryable task fields can be changed in place without replacing the durable task identity. `task update` rejects `RUNNING`, `SUCCEEDED`, and `CANCELLED` tasks so active execution and terminal history cannot be rewritten. For example:

~~~sh
npx agents-relay task update --repo OWNER/REPO --pr 12 --id job-1 --task-id child \
  --adapter chatgpt --provider chatgpt --model gpt-5.6-sol --reasoning high \
  --capabilities model,chatgpt,browser-harness
~~~

Jobs default to `fixed`, preserving the original submit-and-run behavior. Every
executable task is now created by a completed durable planning decision. `job
create --start` records `planner-0` (supplied by the orchestrator) and the
initial task atomically from the caller's perspective; retrying the command is
idempotent. Use `--mode autonomous` with `init` or `job create` to make
reconciliation own planner progress. Autonomous creation with only an objective
may create a model planner first, but it cannot materialize work until that
planner succeeds. Fixed jobs never grow another planning round.

The durable status JSON and dashboard show the mode and planning provenance. An
autonomous runtime uses the bundled `skills/agents-relay/agents/planner.agent.md` by default; `--planner-command` is an optional override
snapshot as JSON on stdin and must return `{ "objective_status": "in_progress"|"satisfied", "assessment": "...", "next_tasks": [...] }`.
Planner-created tasks use stable IDs and the existing parent/subtask tree, so
retries and daemon restarts do not create duplicate work.

job create first resolves an existing open PR with the same head/base, then creates it only when needed. Re-running it is idempotent: it reuses the PR and maintains exactly one trusted agents-relay:job:v1 marker.
Use `--start` to create/reuse the job and submit its initial task in one invocation. Start mode requires explicit `--adapter`, `--model`, `--output`, and non-empty `--input`; the task ID defaults to `initial`. Re-running with the same task definition reuses that task and never duplicates it. Omitting `--start` preserves create-only behavior, leaving an `OPEN` job with zero tasks until a caller submits work.

To adopt an existing unmanaged PR, including a PR with no comments:

~~~sh
npx agents-relay job adopt --repo OWNER/REPO --pr 6 --id job-6 --title "Existing objective"
~~~

Use job repair with the same arguments to repair duplicate same-job markers. A conflicting marker for another job is rejected rather than overwritten.

~~~sh
npx agents-relay job repair --repo OWNER/REPO --pr 6 --id job-6
~~~

Managed GitHub submit/status/reconcile/retry/cancel/serve commands require the durable job marker. If it is missing, the CLI fails with a message directing the caller to job adopt. Orchestrators do not need raw gh PR/comment commands: Agents Relay uses GhApiClient and GitHubStore internally.

The original init command remains supported for backward compatibility:

~~~sh
npx agents-relay init --repo OWNER/REPO --pr 1 --id job-1 --title "Objective"
~~~

## npm publishing

Pushes to `main` run `.github/workflows/publish.yml`: install, test, choose the next npm version, pack-check, publish, and create the matching `vX.Y.Z` tag. Feature branches do not edit `package.json` versions. If `agents-relay` is not published yet the first release is `1.0.0`; later releases increment only the patch version from the npm registry. The repository must provide an `NPM_TOKEN` Actions secret with permission to publish the public `agents-relay` package.

Normal consumers should invoke the CLI with `npx agents-relay ...` (or `npx agents-relayd ...`).

For explicit local demo/test mode:

~~~sh
npm install
npm run build
node dist/cli.js init --file .agents-relay.json --title "Dogfood" --id demo
node dist/cli.js submit --file .agents-relay.json --task-id hello --adapter codex --provider openai --model MODEL --output task-pr --input "Complete the described task"
node dist/cli.js reconcile --file .agents-relay.json
npx agents-relay serve --file .agents-relay.json
~~~

Open the dashboard on localhost port 8787. The marker format is intentionally public and append-friendly; the CLI uses GitHubStore with the authenticated gh client in operational mode.

reconcile leases and launches ready tasks without waiting inside the runtime scheduler; the CLI waits only long enough for its launched workers to persist results. agents-relayd (or the equivalent npx agents-relay serve) is the watchdog/dashboard mode. Model-backed workers require --events nats; the event transport carries authoritative terminal worker events as well as wake/progress traffic. See [docs/service.md](docs/service.md). --file PATH is explicit local demo/test mode only.

`agents-relayd` without `--pr`/`--id` runs in workspace mode by default: it discovers nested Git repositories under `~/Workspace`, keeps only GitHub `origin` remotes, and aggregates their managed PR jobs into one dashboard and worker pool. Pass `--workspace PATH` to use another root. `--repo OWNER/REPO` remains the single-repository pool mode.

For automation, Agents Relay can use GitHub App installation authentication via `AGENTS_RELAY_GITHUB_APP_ID`, `AGENTS_RELAY_GITHUB_APP_INSTALLATION_ID`, and `AGENTS_RELAY_GITHUB_APP_PRIVATE_KEY_FILE` (or matching CLI flags). Webhook mode is cache-first: targeted webhook reconciliation is primary, dashboard auto-refresh reads cached job state, and the broad watchdog drops to a 30-minute fallback. See [docs/github-app-rate-limit.md](docs/github-app-rate-limit.md).

V1 assumes one active runner/daemon per job. Use a distributed atomic lease before running multiple reconcilers. Do not put secrets, credentials, private prompts, or large private payloads in PR marker comments; store only summaries and artifact references.

Codex/model-backed tasks require --provider and --model (or equivalent routing metadata) before launch. See [docs/architecture.md](docs/architecture.md) and [skills/agents-relay/SKILL.md](skills/agents-relay/SKILL.md).

The minimal agent-network surface is machine-driven registration and discovery. `agent-register` persists an agent identity, responsibility boundary, claimed capabilities, endpoint/runtime, availability, and routing metadata in a trusted PR marker; `agent-discover` applies hard filters and returns evidence-backed candidates. Adapters remain runtimes, not agent identities. See [docs/architecture.md](docs/architecture.md) for the constrained future remote submission contract.

### Agent worker lifecycle

Managed tasks are descriptive work for agents, not shell commands. Use `codex` or `chatgpt` for worker tasks. Commands such as tests, build tools, Markad Vision, ffmpeg, and other CLIs are invoked by the orchestrator or by an executing agent; they are not worker adapters.

Every model-backed task declares a durable output with `--output task-pr` or `--output file --output-path PATH`. Agents Relay enriches the prompt with the PR URL, job/task identity, output contract, and mandatory terminal-event contract.

For Codex and ChatGPT, **events are authoritative task state**. Event publication uses the canonical Neo `events-bus` surface (`events__publish` for sandboxed/hosted workers, or `NEO_EVENTS_EMIT` for direct local workers); Agents Relay only subscribes and reconciles. Relay publishes `task.process.launched` only after successful adapter launch; `task.started` is worker-owned and must be a new, correlated start acknowledgement. Codex publishes `task.process.exited` when its synchronous runtime exits, while ChatGPT publishes `task.process.async_exited` after its submission runtime exits; neither substitutes for `task.completed`, `task.failed`, `task.blocked`, or `task.cancelled`. The ChatGPT worker-owned tab follows the configured close policy: `after-start` waits for the correlated start acknowledgement, `never` keeps it open for debug, and `after-terminal` waits for a new exact-task terminal event; start-ack failure closes only the owned tab after 60 seconds. The executing agent must publish exactly one correlated terminal event. Relay persists the matching durable state only from that terminal event. Model-backed tasks require an event bus and time out explicitly if no terminal event arrives.

The ChatGPT adapter uses the Neo `~/Workspace/neo/skills/chatgpt-browser-worker` as a one-shot submitter. It opens a fresh Temporary Chat tab, uses the account defaults, submits the prompt, verifies acceptance, and applies `--chatgpt-tab-close-policy` (or `AGENTS_RELAY_CHATGPT_TAB_CLOSE_POLICY`): `after-start` by default, `never` for test/debug, or `after-terminal` after a new exact-task terminal event. It never closes a user tab and does not poll for the assistant response, resume/reopen a thread, or use conversation text as the result channel. Any observed ChatGPT thread ID is diagnostic only.

~~~sh
npx agents-relay submit --repo OWNER/REPO --pr 5 --id job-1 \
  --task-id research-ui --adapter chatgpt \
  --capabilities model,chatgpt,browser-harness \
  --provider openai --model MODEL \
  --output file --output-path runs/research-ui.md \
  --input "Research the dashboard UX and write the final report to the declared output file."
~~~

GitHub PR state is authoritative for terminal lifecycle: a merged PR reconciles its managed job to `COMPLETED`; a closed, unmerged PR reconciles to `CANCELLED` and cannot launch queued work. The dashboard exposes `/api/jobs` and shows repository-wide managed PR state beside each durable Agents Relay job state so stale markers are visible instead of being mistaken for current truth.

For work that was completed outside the relay but must be represented truthfully in durable history, use `npx agents-relay record --task-id <id> --summary <summary> --commit <sha>`. Recorded tasks use the `orchestrator` adapter and terminal `SUCCEEDED` state; they do not pretend a shell/model worker executed the work. This is a repair/backfill mechanism—normal work should be submitted before execution. Managed jobs also retain the GitHub PR body as the job description for dashboard display.
