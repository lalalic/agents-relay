# Agents Relay

Agents Relay is a generic TypeScript runtime for durable asynchronous agent jobs coordinated through GitHub pull requests. GitHub PR comments are the source of truth; events only wake the reconciler and update the dashboard.

## Quick start

For GitHub-backed work, create or adopt the PR through Agents Relay itself. This guarantees the durable job marker exists before any managed task is submitted.

~~~sh
agents-relay job create --repo OWNER/REPO --head feat/example --base main \
  --id job-1 --title "Objective" --body "PR description"

agents-relay submit --repo OWNER/REPO --pr 12 --id job-1 \
  --task-id child --input "echo hello" --adapter shell

agents-relay reconcile --repo OWNER/REPO --pr 12 --id job-1
agents-relay status --repo OWNER/REPO --pr 12 --id job-1
~~~

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

V1 assumes one active runner/daemon per job. Use a distributed atomic lease before running multiple reconcilers. Do not put secrets, credentials, private prompts, or large private payloads in PR marker comments; store only summaries and artifact references.

Codex/model-backed tasks require --provider and --model (or equivalent routing metadata) before launch. See [docs/architecture.md](docs/architecture.md) and [SKILL.md](SKILL.md).

## Operational agent network

Agents Relay separates three concepts that must not be conflated:

- **Agent**: a durable, result-owning identity/role with responsibility, boundaries, claimed capabilities, endpoint/runtime, availability, and routing metadata.
- **Skill**: a callable capability or behavior contract an agent may use.
- **Adapter**: an execution runtime such as shell, Codex, ChatGPT, command, or HTTP.

Agent registrations are reusable across jobs. Repository scope is the default and stores registrations in one trusted registry issue for that GitHub repository. Global scope is explicit and requires `--registry-repo`; `--scope both` reads repository then global scope. Trusted legacy PR-scoped agent markers are read for compatibility, but new writes go to the shared registry.

Use the first-class agent CLI (legacy `agent-register` and `agent-discover` remain aliases):

~~~sh
agents-relay agent register --repo OWNER/REPO   --agent-id reviewer --name Reviewer --role review   --responsibility "Review changes" --capabilities code-review,testing   --boundaries "no-secrets|repo-only"   --endpoint-kind adapter --endpoint codex --runtime codex   --trust-domains internal --regions ca

agents-relay agent list --repo OWNER/REPO
agents-relay agent show reviewer --repo OWNER/REPO

agents-relay agent discover --repo OWNER/REPO   --capabilities code-review,testing --trust-domains internal   --regions ca --task-kind review --min-score 70 --explore
~~~

Discovery applies hard capability/runtime/endpoint/security/trust/region/availability filters first; offline agents are excluded by default. It then returns an ordered, explainable candidate set using task-specific observations, per-capability scores, broader outcome reliability, sample counts, freshness, latency, and cost. `--explore` may promote at most one unscored candidate behind the strongest observed candidate. The orchestrator still makes the final selection.

Submit work through an explicitly selected registration with `--agent-id`. Dispatch revalidates that agent immediately before launch and preserves the durable task's lineage, lease, retry, continuation, and selected agent identity:

~~~sh
agents-relay submit --repo OWNER/REPO --pr 12 --id job-1   --task-id review-1 --agent-id reviewer   --capabilities code-review,testing   --required-boundaries "no-secrets|repo-only"   --trust-domains internal --regions ca   --input "Review the current PR and report blocking issues."

agents-relay reconcile --repo OWNER/REPO --pr 12 --id job-1
~~~

Registered endpoint kinds are deliberately constrained. Adapter endpoints resolve only to configured local adapters. Command endpoints must be absolute executable paths and run without shell interpretation in a restricted environment. HTTP endpoints may use unauthenticated plain HTTP only on loopback; remote endpoints require HTTPS and an `authEnv` credential reference, with the secret read from the local environment rather than persisted in GitHub.

Real registered-agent executions automatically append durable outcome observations (success/failure/timeout, task/capability context, execution/attempt identity, version, timestamp, latency, and observable cost). Representative suites can add separate evidence explicitly:

~~~sh
agents-relay agent eval reviewer --repo OWNER/REPO   --suite review-regression --capabilities code-review,testing   --outcome success --latency-ms 820 --version model-v1

agents-relay agent scores reviewer --repo OWNER/REPO
~~~

Per-capability scores are 0-100 success rates over **fresh observed evidence only**, with confidence plus total/fresh/stale sample counts. The default freshness window is 90 days and can be changed with `--stale-after-days`. Claimed capabilities never create a score. Reliability, latency, and cost remain separate evidence dimensions rather than a universal trust score.

The implementation does **not** provide a public marketplace or broad remote control plane. Hosted multi-tenant identity/trust, private-data or credential-bearing routing across owners, billing, isolation, public discovery, and a general authenticated job service remain future scope. See [docs/architecture.md](docs/architecture.md) and [docs/agent-network.md](docs/agent-network.md).

### ChatGPT workers through MacBridge

Use the chatgpt adapter to make a relay task create a real ChatGPT web conversation through the local MacBridge runtime. The returned ChatGPT conversation_id is stored as the task threadId, so lineage is durable and a retry continues the same conversation.

Managed Codex and ChatGPT worker prompts automatically receive the durable PR URL plus job/task/parent/project context before the original task input. The stored task input is not rewritten.

Each ChatGPT task owns its own conversation. Retries reuse that task's conversation; sibling tasks never share a conversation merely because they use the same adapter. When the job reaches COMPLETED, or GitHub reports the PR merged, Agents Relay deletes every ChatGPT task conversation through MacBridge. The durable threadId remains in the task marker with threadDeletedAt for audit history. Failed deletion records threadCleanupError and is retried on later reconciliation without reopening the terminal job.

~~~sh
agents-relay submit --repo OWNER/REPO --pr 5 --id job-1 \
  --task-id research-ui --adapter chatgpt \
  --capabilities model,chatgpt,macbridge \
  --provider openai --model gpt-5-6-pro --reasoning high \
  --chatgpt-project g-p-EXACT_PROJECT_ID \
  --input "Research the dashboard UX and return implementation guidance."
~~~

The adapter calls MacBridge's loopback-only /experimental/chatgpt/conversation endpoint. Configure it with --macbridge-url and --macbridge-token-file, or AGENTS_RELAY_MACBRIDGE_URL / AGENTS_RELAY_MACBRIDGE_TOKEN_FILE. By default it uses loopback port MAC_DEV_BRIDGE_HTTP_PORT (or 8788) and the MacBridge menu app token file under ~/Library/Application Support/MacDeveloperBridge/http-token. Secrets are read locally and are never stored in PR markers.

GitHub PR state is authoritative for terminal lifecycle: a merged PR reconciles its managed job to `COMPLETED`; a closed, unmerged PR reconciles to `CANCELLED` and cannot launch queued work. The dashboard exposes `/api/jobs` and shows repository-wide managed PR state beside each durable Agents Relay job state so stale markers are visible instead of being mistaken for current truth.

For work that was completed outside the relay but must be represented truthfully in durable history, use `agents-relay record --task-id <id> --summary <summary> --commit <sha>`. Recorded tasks use the `orchestrator` adapter and terminal `SUCCEEDED` state; they do not pretend a shell/model worker executed the work. This is a repair/backfill mechanism—normal work should be submitted before execution. Managed jobs also retain the GitHub PR body as the job description for dashboard display.
