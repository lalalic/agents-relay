# Agents Relay — Rust runtime

Agents Relay is a native **Rust** CLI and daemon for durable, local Git-backed agent Jobs. **Rust is the sole backend implementation**. Workflow decisions come from [`workflow/*.mmd`](workflow/), while SQLite is the authority for Jobs, Tasks, Plans, Reviews, execution identities and recovery. EventBus messages are notifications and wake-ups, not durable Job truth.

Worker liveness is process/thread-based rather than deadline-based; see
[Worker process lifecycle](docs/WORKER_PROCESS_LIFECYCLE.md).

The canonical rules are [`AGENTS.md`](AGENTS.md), [`DESIGN-PRINCIPLES.md`](DESIGN-PRINCIPLES.md) and [`skills/agents-relay/SKILL.md`](skills/agents-relay/SKILL.md).

## Code layout

| Path | Purpose |
|---|---|
| [`rust/src/`](rust/src/) | Only Relay backend: native CLI, daemon, Graph actions, SQLite and adapters |
| [`rust/tests/`](rust/tests/) | Native Rust integration and regression tests; isolated test fixtures |
| [`rust/runtime/script-worker-runner.mjs`](rust/runtime/script-worker-runner.mjs) | Minimal JS bridge for executing a user-supplied Script Agent; **not** a second Relay backend |
| [`workflow/`](workflow/) | Canonical Mermaid workflow policies |
| [`dashboard/`](dashboard/) | Static HTML/CSS/JS PWA assets, served by the Rust daemon |
| [`skills/`](skills/) and [`agents/`](agents/) | Agent contracts, skills and prompts |
| [`mvp/`](mvp/) | Optional CLI/real-device acceptance harnesses targeting the Rust runtime |
| [`docs/`](docs/) | Operational/reference documents; historical porting notes are not the current build instructions |

There is **no** top-level TypeScript `src/`, Node `test/`, `dist/` distribution, npm `package.json`, or npm publish pipeline. Prior implementation and head-to-head test evidence remains available through Git history, rather than a maintained second runtime. The JavaScript frontend and Script Agent bridge are intentionally retained; they do not own Relay orchestration or durable state.

## Build

Requires Rust/Cargo and a compatible C toolchain for `rusqlite`.

```sh
cd rust
cargo build --locked --bins
cargo test --locked --lib
cargo test --locked --test native_sqlite_write_host
cargo test --locked --test native_dashboard_pwa
```

Binaries from this repository are `rust/target/debug/agents-relay-rust` and `rust/target/debug/agents-relayd-rust`. Production launchers may expose them as `agents-relay` and `agents-relayd`; **do not install** a similarly named npm binary.

## CLI and lifecycle

```sh
# Local Git root is the Job identity; --repo is a local basename, not GitHub owner/repo.
agents-relay job create --repo my-project --project-root /absolute/path/to/my-project \
  --title "Implement objective" --objective-file objective.md --initial-plan
agents-relay job list
agents-relay job show --id JOB_ID
agents-relay task list --id JOB_ID --repo my-project
```

Create-only Jobs (without `--initial-plan`) remain DRAFT until activated. DAG Jobs can provide `--coordinator-graph-file` and activate via `job run --id JOB_ID --task-id TASK_ID`. Planner, Workers, Troubleshooter, Final Reviewer and local Merge use one durable task lifecycle. Use `agents-relay --help` and the [skill](skills/agents-relay/SKILL.md) for command contracts.

PR/GitHub CLI switches and PR identity are removed, with no historical-compatibility shim. Local Git merges complete independently of network availability. Optional, verified fast-forward delivery to `origin/main` occurs only after the Job is completed and cannot reopen a Job.

## Daemon / Dashboard / Neo Mobile

```sh
agents-relayd --live-store-dir "$HOME/.agents-relay/stores" \
  --port 8787 --concurrency 4 --interval 300000
```

Use deployment-specific EventBus/worker options as needed. The Rust daemon serves the Dashboard at `/`, read-only inventory via `/api/jobs`, Job details `/api/job?id=JOB_ID`, events `/api/events`, and scoped Neo Mobile endpoints under `/api/mobile/`. Use `skills/agents-relay/bin/services.mjs status` for PM2 service inspection (Node in that file is just a management-script tool, not the daemon).

**Production SQLite schema:** `local-git-id-v2`. The `source_registry` table contains `job_id`, `source_file`, `repository`; no `pr_number`. Existing `single-sqlite-staging-v1` stores require a **one-time offline migration** from [`rust/sql/upgrade_local_job_registry_v2.sql`](rust/sql/upgrade_local_job_registry_v2.sql). Stop the daemon and all SQLite writers, back up the database with SQLite's backup API (including WAL), run the migration, validate integrity/foreign keys and then start the Rust daemon. There is no runtime fallback to the old schema.

## Testing and release

[`.github/workflows/rust.yml`](.github/workflows/rust.yml) checks the Rust-only tracked layout, Cargo build and selected native Rust regressions on GitHub. Local tests must use disposable stores; **never** target the canonical `~/.agents-relay/stores` for acceptance tests. Native L1/L3 success does not imply physical iPhone, WebHelm or external provider E2E; record those separately.

Commit to `main` only after native checks. Deployment of a source commit into the live PM2 service is **separate** from making the Git commit; it requires an explicit executable rollout with backups and verification. Do not restart an active production daemon merely to test a source-only change.
