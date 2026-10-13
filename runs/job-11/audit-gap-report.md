# Job #11 — objective-only CLI and projection lifecycle gap audit

## Scope and evidence

- Job: `j-7-lalalic-agents-relay-11`, Task `19`, execution `50d7b97b-3998-4144-9f81-95de4de0bdb0`.
- Planner's pinned baseline: `1f600a30c1cd6076e046743cae2ec0de34aaa26e`; **actual inspected repository HEAD**: `093f002b73f093410bf0d47f318f43620c3691e5`. Current main includes later unrelated changes. No existing user file was overwritten.
- Architecture authority: `DESIGN-PRINCIPLES.md`, especially graph policy, stateless actions, and SQLite vs GitHub separation.
- This is an audit, not the broad implementation. Root cause **not applicable** to this audit; individual regressions below are separately evidenced.

## Confirmed gaps

1. **Normal create CLI still exposes Git/transport parameters.** `src/cli-help.ts:61-67` documents `--head`, `--base`, `--pr` and `--idempotency-key` in ordinary `job create`; `src/cli.ts` and `src/relayd-control.ts:59-84` still forward those into `ensureManagedGitHubJob` (`src/cli-job-create.ts`). Required: objective-oriented public creation surface; preserve explicit legacy adoption/migration via separate entry point. Boundary: CLI input contract + `job.create` effect, with compatibility tests.
2. **Initial create-and-plan is not atomic.** `src/cli-job-create.ts` persists the new Job with `local.store.saveJob(job)` before `src/relayd-control.ts:88-101` calls `reconciler.planJob`. A planner failure can leave a durable Job without its initial plan. Required: plan externally before the short final SQLite atomic commit, or stage unpublished intent with exact rollback guarantees, while preserving concurrent idempotency. Boundary: job-bootstrap graph and atomic SQLite job+plan commit, not a long-running SQLite transaction.
3. **Creation contract conflates normal and legacy PR binding.** `ensureManagedGitHubJob` continues to accept direct `head`, `base`, `prNumber`, `localMergeSource/Target` as ordinary options (`src/cli-job-create.ts:14-25,49-76`). Preserve explicit adoption but remove from default interface. Required tests: distinct identical objectives, idempotency only by explicit request identity, and legacy record adoption.

## Already implemented / partially satisfied (not automatically complete)

- **Stable source branch:** `src/workspace.ts:184-205` computes a deterministic `refs/heads/relay/job-<id>-<hash>` and pins the target `refs/heads/main`. `prepareLocalJobExecutionWorktree` reuses configured branch/worktree. Confirmed implementation exists; integration coverage and automatic binding in all code paths still need verification.
- **Local merge guardrails:** `src/local-git-merge.ts` enforces explicit local refs, clean target checkout and checked SHA before merge. Existence confirmed, but full Job #9 artifact/merge receipt regression matrix is not established by this audit.
- **SQLite authority and external projection:** `src/relay-store.ts` uses SQLite WAL/atomic mutations and a durable projection outbox; `src/projection-outbox.ts` owns projection persistence. This conforms to the architectural separation in principle. Review exact create-after-first-commit, terminal-outbox and restart ordering before marking complete.
- **Persistent execution and comment context:** `src/task-context.ts`, `src/task-comments.ts`, `src/local-authority-store.ts` preserve execution-scoped reads and append-only comments. These are newer improvements, not substitutes for Job #11 acceptance.
- **Planner orchestration:** `src/manual-plan.ts` supports durable rounds. It does not itself make the *original create+initial-plan intent* atomic.

## Unverified acceptance areas requiring targeted regression checks

- Jobs #8–#10 comparison: confirm atomic initial-plan requirements, local/no-PR Task outputs/merge receipts, and dashboard order against their specific tests and prior acceptance artifacts. Do not re-create these Jobs.
- Code vs non-code tasks: ensure no implicit Git branch/worktree for non-code Jobs.
- PR projection: creation after first meaningful commit, retry across service restart, state-independent failure behavior, no-fake-PR evidence for already-merged work, and pending effects after terminal Job completion.
- GitHub disabled: verify zero GitHub requests, successful local completion, and migration of legacy PR bindings.
- Release acceptance: main merge receipt, remote push, npm publication, running `@latest` PM2 version. These are separate gates and cannot be inferred from passing unit tests.

## Recommended ordered Task boundaries

1. **Public creation semantics and atomic initial Plan** — design graph-owned bootstrap transition; implement short SQLite final commit and compatibility migration. Tests for failure and concurrent duplicate/different requests.
2. **Git provisioning and artifact completion gates** — audit/repair worktree and sourceRef provisioning, code/no-code routes, dirty/uncommitted Task rejection and merge receipts with PR/no-PR.
3. **Projection-only GitHub collaboration** — PR creation timing, persistent outbox/restart/terminal handling, explicit no-GitHub and merged-no-diff evidence.
4. **Cross-cutting acceptance tests** — canonical graph ownership, dashboard order, Jobs #8–#10 regressions and failure injection.
5. **Immutable review → Relay-owned merge** — run review and verify actual main commit/merge receipt.
6. **Post-merge publish and live verification** — remote main, npm package version, PM2 `@latest`, runtime behavior.

No broad production change was made during this audit. Keep the original Job ID and create dependent implementation/verification Tasks through the existing planner/graph; do not manually force success.

## Validation performed

- `git rev-parse HEAD` → `093f002b73f093410bf0d47f318f43620c3691e5`.
- `node dist/cli.js task context --repo lalalic/agents-relay --id j-7-lalalic-agents-relay-11 --task-id 19 --execution-id 50d7b97b-3998-4144-9f81-95de4de0bdb0` → authoritative Task context loaded, matching execution ID, output path `runs/job-11/audit-gap-report.md`.
- Source inspection: `DESIGN-PRINCIPLES.md`, `src/cli-job-create.ts`, `src/relayd-control.ts`, `src/cli-help.ts`, `src/workspace.ts`, `src/local-git-merge.ts`, `src/manual-plan.ts`, `src/relay-store.ts`. No full-suite tests run as no production implementation was changed.
