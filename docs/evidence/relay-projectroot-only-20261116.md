# Relay Job root-only contract — 2026-11-16

## Authority and scope

Every new Job belongs to exactly one independent local Git repository. Durable identity is `job.repository` (local Git root basename) plus canonical immutable `job.projectRoot`; there is no `job.projectPath` or nested-monorepo Job routing.

The runtime callback previously named `projectPathForJob` is now `cwdForJob(job, task)` and resolves execution cwd: canonical Git root or a managed isolated Git worktree. `cwdForTask` does the same at the DAG task boundary. Agent preference lookup uses `agentPreferenceRootForJob` (canonical root, no worktree creation). None of these runtime paths is persisted as a Job field.

Coordinator's persisted `graphStartContext.projectPath` is replaced by `graphStartContext.projectRoot`. CLI/daemon control rejects obsolete `job create`, `job update`, `job run`, and Blocker `--project-path`/`projectPath` bindings. Independent `context resolve` and standalone `review run` still accept path parameters, unrelated to Job identity.

## Live SQLite one-time migration

Source: `~/.agents-relay/relay.sqlite` (`job_snapshot` JSON, SQLite WAL-safe online backup).

- Verified 466 Jobs, all terminal (`COMPLETED` or `CANCELLED`) when migrating.
- Removed top-level `projectPath` from exactly 139 terminal Job snapshots.
- Renamed nested Coordinator `graphStartContext.projectPath` to `projectRoot` in exactly 17 terminal snapshots.
- Verified JSON structural equality for every Job to its pre-migration copy after applying only those two allowed transformations; all Task data, Job states and timestamps were preserved.
- Verified post-migration counts: top-level old field 0, Coordinator old field 0, total Jobs 466.
- Full backup: `~/.agents-relay/backups/relay-pre-remove-job-projectpath-20261116-1794880810.sqlite`; SHA-256 `ee2caf1a522074e3fd52243f34635e22bf3ab3f34cd13695b906b0a0a2b917c6`; backup SQLite `integrity_check = ok`.

## Source and verification

Isolated source worktree only; no production daemon/PM2 restart, no Rust `rust2` edit or build, no remote push, no PR.

- `npm run build` + TypeScript `--noEmit`: PASS.
- `npm run test:verification:l1`: 58 pass / 0 fail.
- `npm run test:verification:l2`: 11 pass / 1 intentional skip / 0 fail.
- `npm run test:verification:l3`: 90 pass / 1 intentional skip / 0 fail (91 total). Includes 5 Coordinator/Review/Request Changes scenarios, isolated SQLite-daemon/CLI and optional origin push/retry E2E.
- Focused local-Git Job identity / Coordinator / CLI startup E2E: 9 pass.
- Standalone real Coordinator idempotency and foreground CLI without deprecated `--project-path`: 2 pass.

Note: Existing unrelated historical `test/workspace.test.js` expectations about remote `owner/repo` identity and macOS `/var` symlinks predate the local basename contract; that entire legacy test file is not the L1–L3 gate. The removed nested-path unit was replaced with a test requiring an independent repository root.
