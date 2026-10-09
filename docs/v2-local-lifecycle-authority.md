# V2 local lifecycle authority — migration and validation

## Objective

SQLite/RelayStore is authoritative for Job, Task, Plan, Review, Execution,
Lease, and Recovery. Canonical `workflow/*.mmd` graphs alone decide transitions.
EventBus is a wake-up/observability channel, not a second database. GitHub is
an optional audit-only adapter. No GitHub read, write, or acknowledgement can drive a local lifecycle transition.

This change does **not** migrate old GitHub-marker Jobs; existing Job ID strings
remain valid, but only Jobs established in the local registry are discovered.
Do not change or run the separate E2E worktree when validating this branch.

## Audited dependencies and phases

| Phase | Former path | V2 authority boundary | Validation |
| --- | --- | --- | --- |
| 1. Registry | GitHub PR/Comments discovery | Read-only SQLite `job_snapshot` inventory | offline CLI/list/daemon |
| 2. Mutations | GitHub store/hydrate/projections | `LocalAuthorityDurableStore`, atomic Job/Task/Plan updates | duplicate/stale/concurrent writes |
| 3. Scheduling | GitHub scan and rate-limit gates | `RepositoryWorkerPool` requires local inventory | offline reconcile and limit tests |
| 4. Review/recovery | PR snapshot refresh on wake | existing review, troubleshooter, job/task graphs + SQLite state | offline review creation, approval, recovery |
| 5. External effects | asynchronous lifecycle marker projection | local Git merge delivery and independent GitHub audit | merge receipt and publish isolation |
| 6. CLI/API | GitHub Job marker reads/writes | immutable jobId SQLite Store, optional PR binding | isolated CLI/temp HOME |
| 7. Documentation | GitHub described as lifecycle source | V2 README/Design Principles, V1 marked historical | source and architecture audit |

### Authority boundaries

- CLI, dashboard, daemon, pool, and Reconciler consume the **same** locally
  persisted Job/Task state. PR body/comments cannot recover or overwrite it.
- EventBus wake-ups must not cause a GitHub PR/Comments discovery sweep.
- Review, Troubleshooter, retries, task dependencies, and Job terminalization
  remain Graph-driven; they only use SQLite state.
- All GitHub PR states, head SHA, close/merge facts, webhook deliveries and publication
  status are **audit-only**; they never trigger Job/Task/Review/Planner/Schedule
  transitions or wake reconciliation. Confirmed external merge does not mean Job
  COMPLETED. Only local Git delivery with a verified receipt can do that.
- Immutable `job.id` selects the authoritative SQLite DB for daemon control,
  targeted worker events, startup recovery, and schedule ticks. `prNumber=0` is
  a normal local Job; a positive PR number is optional external metadata.
- Schedule slots use an atomic SQLite `BEGIN IMMEDIATE` claim informed by the
  Scheduled-run Graph, and a guarded completion; competing processes cannot
  claim the same slot twice.
- CLI `job create --repo ... --id ... --objective ...` requires no GitHub login
  or PR. Local job stores use `job-<SHA-256(jobId)>.db`; older PR-bound SQLite
  filenames remain readable through registry discovery.
- SQLite registry scans must never open writable stores because writable-store
  initialization includes in-flight outbox recovery checks.
- In-flight external-effect claims retain a bounded two-minute recovery window
  across concurrent SQLite connections; aged claims can be retried after crash.
  External audit/projection retries must not wake the local Graph.
- Existing V1 `GitHubStore` and `ProjectedDurableStore` remain isolated for
  compatibility/tests, but **must not** be the daemon/managed CLI authority
  and must not be used for lifecycle discovery or recovery.

## Acceptance evidence

Run from this branch's isolated worktree:

```sh
npm ci --no-audit --no-fund
npm run build
node --test test/local-authority.test.js
node --test --test-concurrency=1 test/*.test.js
git diff --check
```

The local-authority test suite exercises GitHub API outage stubs, terminal state
durability, concurrent Job/Task/Plan mutations, stale snapshot defense,
ReadOnly registry scanning, external audit isolation, local no-PR schedule claim and recovery, offline review
creation/approval, and automatic Troubleshooter creation.

Independent code review must inspect the **uncommitted diff**, identify
concurrency or architecture regressions, and repeat after any changes.
Nothing is pushed or merged until all tests and independent review pass.

## Deployment boundary

These changes are local source only. No production daemon or service is
restarted; the running E2E checkout stays on its own branch. Rollout and
production restart belong to an explicit later deployment step after review.


## `--no-github`: local-only execution and Git delivery

In local-only mode SQLite is authoritative, EventBus wakes the Graph Engine, and no GitHub authentication, API, GraphQL, PR discovery, or remote push/merge is performed. Planner, Worker, Review, Troubleshooter, recovery, and scheduling remain local. A local Git repository is still supported.

A code Job must configure a source branch and an integration branch explicitly. Both are local full Git refs (`refs/heads/...`). An example from inside the intended Git repository:

```bash
npx agents-relay job create --repo local/project --id local-101 \
  --objective 'Implement and locally integrate the change' \
  --local-merge-source refs/heads/feature/local-101 \
  --local-merge-target refs/heads/integration/local-101

npx agents-relay --no-github reconcile --repo local/project --id local-101 \
  --project-path "$PWD" --events none
```

When the integration target is **checked out**, the target worktree must be clean. Delivery uses normal Git `merge --no-ff`, keeping its HEAD, index and files coherent; conflicts are aborted and recorded for retry. When the target is **not checked out**, delivery uses `merge-tree`, `commit-tree` and atomic compare-and-swap `update-ref`. No delivery step touches the separate running E2E worktree. A merge failure or conflict leaves the Job ACTIVE, persists the error, and applies a bounded retry delay. The successful merge commit SHA is persisted as `job.localMerge.mergedCommitSha` and only then may the Graph transition to COMPLETED. A subsequent reconcile or daemon restart must not create another merge commit. Review approval does not substitute for this delivery.

Jobs whose outputs are non-code artifacts (for example a `file` output) may complete locally without a merge; Jobs producing `task_pr` code outputs without configured local merge refs remain ACTIVE. Reconfigure with both `--local-merge-source` and `--local-merge-target` via `job update`.

With GitHub enabled or disabled, review head identity comes exclusively from the local source branch commit SHA, or the current local Git HEAD when no source ref is configured. A new source commit invalidates the old review and requires another review before merge. GitHub OPEN/MERGED/CLOSED and head facts are SQLite audit records only: they never start, stop, complete, cancel, or wake a Job/Task, and never gate local Task/Planner/Review dispatch.

`--no-github` is a standalone mode. `reconcile` executes locally rather than only emitting a daemon wake event; normal mode retains event-triggered daemon reconciliation. The `--events none` flag can be used for a completely isolated local CLI workflow.

## GitHub-enabled package publish events

A verified GitHub `issue_comment` publication marker from `github-actions[bot]` is
correlated to the local Job by repository and PR number. SQLite stores the
`package.published` / `package.publish_failed` delivery history keyed by
`(job_id, delivery_id)` and the latest package version, registry, SHA and failure
stage. Replayed webhook deliveries cannot duplicate the durable record; older
GitHub comment timestamps cannot roll back the latest status. This is a local
release fact and **does not** make GitHub a Job/Task lifecycle authority.

The Dashboard reads publication status directly from SQLite. It shows the
latest published version and an outstanding publish-failure indicator, even
when the Job's PR state is not currently `MERGED`. EventBus publication event
IDs are deterministic per Job and delivery, permitting at-least-once webhook
retries without changing event identity. GitHub publish events never create or mutate Jobs or Tasks, wake reconciliation, or trigger Troubleshooter. They are audit records only. No production daemon,
service, or running E2E checkout is restarted as part of these source changes.


All GitHub events (including PR changes and package publishing) are observational. GitHub input cannot transition lifecycle Graphs, seed review SHA, invoke remote merge effects, or affect runtime-state derivation. Local Git integration and authoritative SQLite Job/Task state are the only lifecycle facts.
