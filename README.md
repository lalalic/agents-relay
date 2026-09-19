# Agents Relay

Agents Relay is a generic TypeScript runtime for durable asynchronous agent jobs coordinated through GitHub pull requests. GitHub PR comments are the source of truth; events only wake the reconciler and update the dashboard.

## Quick start

```sh
npm install
npm run build
node dist/cli.js init --file .agents-relay.json --title "Dogfood" --id demo
node dist/cli.js submit --file .agents-relay.json --task-id hello --input "echo hello" --adapter shell
node dist/cli.js reconcile --file .agents-relay.json
node dist/relayd.js --file .agents-relay.json
```

Open http://localhost:8787. The marker format is intentionally public and append-friendly; the CLI uses `GitHubStore` with the authenticated `gh` client in operational mode.

Operational CLI commands use GitHub PR comments by default and authenticate through the installed `gh` CLI, so no token is copied into the process. For example:

```sh
agents-relay init --repo OWNER/REPO --pr 1 --id job-1 --title "Objective"
agents-relay submit --repo OWNER/REPO --pr 1 --id job-1 --task-id child --input "echo hello" --adapter shell --capabilities shell
agents-relay reconcile --repo OWNER/REPO --pr 1 --id job-1
agents-relay status --repo OWNER/REPO --pr 1 --id job-1
```

`reconcile` leases and launches ready tasks without waiting inside the runtime scheduler; the CLI waits only long enough for its launched workers to persist results. `agents-relayd` (or the equivalent `agents-relay serve`) is the watchdog/dashboard mode and can use `--events nats --subject-prefix PREFIX` for optional wakeups. See [docs/service.md](docs/service.md). `--file PATH` is explicit local demo/test mode only.

V1 assumes one active runner/daemon per job. Use a distributed atomic lease before running multiple reconcilers. Do not put secrets, credentials, private prompts, or large private payloads in PR marker comments; store only summaries and artifact references.

Codex/model-backed tasks require `--provider` and `--model` (or equivalent routing metadata) before launch. See [docs/architecture.md](docs/architecture.md) and [SKILL.md](SKILL.md).

The minimal agent-network surface is machine-driven registration and discovery. `agent-register` persists an agent identity, responsibility boundary, claimed capabilities, endpoint/runtime, availability, and routing metadata in a trusted PR marker; `agent-discover` applies hard filters and returns evidence-backed candidates. Adapters remain runtimes, not agent identities. See [docs/architecture.md](docs/architecture.md) for the constrained future remote submission contract.

### ChatGPT workers through MacBridge

Use the `chatgpt` adapter to make a relay task create a real ChatGPT web conversation through the local MacBridge runtime. The returned ChatGPT `conversation_id` is stored as the task `threadId`, so lineage is durable and a retry continues the same conversation.

```sh
agents-relay submit --repo OWNER/REPO --pr 5 --id job-1 \
  --task-id research-ui --adapter chatgpt \
  --capabilities model,chatgpt,macbridge \
  --provider openai --model gpt-5-6-pro --reasoning high \
  --chatgpt-project g-p-EXACT_PROJECT_ID \
  --input "Research the dashboard UX and return implementation guidance."
```

The adapter calls MacBridge's loopback-only `/experimental/chatgpt/conversation` endpoint. Configure it with `--macbridge-url` and `--macbridge-token-file`, or `AGENTS_RELAY_MACBRIDGE_URL` / `AGENTS_RELAY_MACBRIDGE_TOKEN_FILE`. By default it uses loopback port `MAC_DEV_BRIDGE_HTTP_PORT` (or `8788`) and the MacBridge menu app token file under `~/Library/Application Support/MacDeveloperBridge/http-token`. Secrets are read locally and are never stored in PR markers.
