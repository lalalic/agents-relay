# Agents Relay

Agents Relay is a generic TypeScript runtime for durable asynchronous agent jobs coordinated through GitHub pull requests. GitHub PR comments are the source of truth; events only wake the reconciler and update the dashboard.

## Quick start

```sh
npm install
npm run build
node dist/cli.js init --file .agents-relay.json --title "Dogfood" --id demo
node dist/cli.js submit --file .agents-relay.json --id hello --input "echo hello" --adapter shell
node dist/cli.js reconcile --file .agents-relay.json
node dist/cli.js serve --file .agents-relay.json
```

Open http://localhost:8787. For GitHub, provide a small `GitHubClient` using `fetch` and `GITHUB_TOKEN`, then construct `GitHubStore(owner/repo, pullRequestNumber)`; the marker format is intentionally public and append-friendly.

Codex/model-backed tasks require `--provider` and `--model` (or equivalent routing metadata) before launch. See [docs/architecture.md](docs/architecture.md) and [docs/SKILL.md](docs/SKILL.md).
