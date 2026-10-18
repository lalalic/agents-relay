# Planner CLI Actions — proposed contract

This is the desired agent-callable action contract, **not** a claim that these commands are implemented. Keep CLI, service, dashboard and scheduler on the same Graph/Core validation path.

## Available today

- `agents-relay plan --repo … --pr … --id … [--prompt|--prompt-file]` starts/reuses a planning round through Relay Core; it does not accept a task tree produced by an agent.
- `agents-relay task create` creates **one** durable Task (not an atomic plan tree).
- `agents-relay task update`, `task list`, `task show`, `task retry`, `task recover`/Troubleshooter recovery, and `reconcile` expose individual task and orchestration operations.
- The model-backed Planner currently emits JSON which Relay validates then materializes; it cannot itself inspect/repair the result of an agent-initiated CLI plan commit.

## Required agent-callable actions

1. `plan show --repo … --id … --plan-id …`: read immutable round context, state, errors, prior proposals, and head revision. Read-only.
2. `plan validate --repo … --id … --plan-id … --file tree.json`: return structured path-specific violations of task schema, dependency DAG, scope, failed-task resolution, objective coverage and current revision; no side effects.
3. `plan apply --repo … --id … --plan-id … --file tree.json --request-id … --expected-revision …`: atomically validate and commit the *entire* task tree and plan result in SQLite; return persisted task IDs, revision, and explicit error codes. Same request ID must be idempotent; optimistic concurrency rejects stale revisions. Never partially create tasks.
4. `plan status --repo … --id … --plan-id …`: report running/waiting/committed/failed state, lease/owner, last validation error and resumable action. Can be covered by `plan show` if identical.
5. `plan resume --repo … --id … --plan-id …`: reclaim an already-authorized pending round when no active execution exists; do not spawn a new round or bypass the Graph. Must recover even for a fixed-mode Job without enabling autonomous new rounds.

## Agent loop

Inspect objective and durable Graph → propose bounded next batch → `plan validate` → correct field errors → `plan apply` → if revision conflict, refresh and re-plan → verify committed IDs → finish current Plan. Validation errors do **not** create failed Plan rounds or new Task IDs. Limit attempts and detect no-progress loops; return a durable failure reason on exhaustion.

**Authority:** Graph owns transitions and allowed dependencies; Core owns validation and atomic SQLite mutations; CLI only invokes Core; Agent may propose and retry but cannot override policy or mark objective satisfied without evidence. `changes-required` is a successful Reviewer verdict that normally drives revision, not `task.failed`.

## Minimum regression scenarios

- Invalid missing resolution, invalid dependency/cycle and malformed title: reject without partial writes, agent corrects within same `plan-N`.
- CLI response lost after committed write: retry same request ID returns same task IDs and no duplicate tasks.
- Concurrent/stale proposal: revision conflict returns actionable code, not silent overwrite.
- Planner overlaps a Worker: pending Plan obtains an execution opportunity when resources clear (also for fixed jobs).
- Deterministic L3 multi-failure: Planner decomposes remaining acceptance work into independent recovery Tasks; completion and review follow real events, not synthetic status writes.
