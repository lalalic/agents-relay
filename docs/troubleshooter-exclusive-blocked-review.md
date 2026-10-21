# Troubleshooter-Exclusive Blocked Lifecycle Review

## Scope and Architecture Lens

Reviewed the lifecycle change in this checkout against `DESIGN-PRINCIPLES.md`,
the task/job contract, canonical workflow graphs, implementation, persistence,
and entry points.

- **Workflow decision:** ordinary dependency waits stay `DRAFT`, dispatchable
  work becomes `QUEUED`, and ordinary worker, platform, and semantic failures
  become `FAILED`. Only Troubleshooter tasks may enter `BLOCKED` and be
  authoritatively unblocked.
- **Graph ownership:** `task-lifecycle.mmd`, `authoritative-unblock.mmd`,
  `troubleshooter.mmd`, `task-resolution.mmd`, `blocker-resolution.mmd`, and
  `orchestrator-rescue.mmd` express the policy. TypeScript provides guards,
  persistence, migration, and selected effects.
- **Durable authority:** SQLite snapshots remain operational state; migration
  rewrites only legacy task snapshots and preserves append-only event history.
  Ordinary legacy `BLOCKED` tasks become `FAILED`, retaining unknown execution
  outcomes as unknown. No old blocked original is converted to success.
- **Entry-point parity:** CLI, dashboard, daemon, and blocker release paths no
  longer provide a direct ordinary-task unblock or arbitrary lifecycle state
  override. Troubleshooter unblock returns that same task to `QUEUED` through
  the authoritative graph.
- **Recovery safety:** unknown execution outcomes fail closed without automatic
  reroute. Exact-original retry requires a current Troubleshooter execution,
  a fresh resolution identity, and a still-`FAILED` original. Repeated recovery
  cannot reuse an earlier resolved record.
- **Dependency safety:** dependency waits remain `DRAFT`; only `DRAFT` dependents
  are released when their blocker resolves. Same-job dependency validation
  rejects missing, self, succeeded, and cancelled targets, so a legacy
  `same_job_dependency` cannot be treated as valid recovery evidence.

## Independent Review Findings

No remaining correctness or authority split was found in the reviewed paths.
The review added regression checks for invalid legacy same-job targets and
assertions that each post-unblock retry resolution is persisted with that
cycle's fresh Troubleshooter execution ID. Event-history migration remains
append-only, and unknown execution evidence is retained.

## Verification

- `npm run build` — passed.
- `npm run test:verification:l1` — passed, 34 tests.
- `npm run test:full` — passed, including the repository unit suite and L3
  replay suite (52 tests).
- Focused task-resolution and human-escalation replay — passed, 9 tests.
- `git diff --check` — passed before this report was added.

All test data uses isolated stores. No production E2E, Relay Job, Task, PR,
deployment, or push was created for this change.
