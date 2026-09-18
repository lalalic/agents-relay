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
