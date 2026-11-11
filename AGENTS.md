# Working on Agents Relay

Agents Relay is a generic, shareable async-agent runtime and skill.

## Architecture contract

Read DESIGN-PRINCIPLES.md before planning, implementation, or final review of
architecture-sensitive work.

## Principles

- V2 SQLite Relay Store is the sole authoritative Job/Plan/Task/Review/Execution/Lease/Recovery state. GitHub only executes external PR/commit/review/merge effects; events are wake-ups/observability, never standalone durable truth.
- Reconcile desired durable state into ephemeral worker executions.
- One top-level objective maps to one local Job (which may reference one external PR); child Tasks/Plans/Review state remain in local SQLite.
- `job create` without `--initial-plan` is create-only. For a normal executable Job, prefer `job create --initial-plan`; this creates the first durable Planner round and hands subsequent execution to Relay. A zero-task Job created without `--initial-plan` remains idle.
- Agents may submit child tasks; task lineage is explicit.
- Any component that creates or manages jobs/tasks must follow `skills/agents-relay/contracts/task-job-contract.md`; task producers choose `storySize`, not raw timeout milliseconds.
- Workers are replaceable and recoverable. Results and state must survive worker or daemon death.
- Keep provider/model routing separate from roles and capabilities. The optional Agent `skills`, `model`, and `reasoning` frontmatter fields are advisory only; follow `skills/agents-relay/contracts/agent-contract.md`. Do not turn hints into enforced Skill requirements, Router choices, or Task constraints.
- Prefer standard library and small dependencies. SQLite is canonical lifecycle state, not a cache of GitHub comments. Do not hydrate/recover lifecycle from PR body/comments, or enqueue lifecycle projection writes. The outbox may hold only idempotent external PR actions.
- TypeScript must use explicit types and avoid `any`.
- UI must remain usable without a frontend framework unless a framework becomes necessary.
- Tests must cover state transitions, parser/serialization, reconciliation, and recovery-sensitive logic.
- Repository test commands must isolate `AGENTS_RELAY_STORE_DIR`; tests and child CLIs must never use the canonical user store under `~/.agents-relay/stores`.
- Every disposable subprocess launched by Relay must use the shared owned-process lifecycle so direct exit, cancellation, timeout, retry, and parent death clean the exact process group without process-name matching.

## Workflow authority classification

Before implementing any feature or bug fix, apply the task-relevant
Architecture Lens from DESIGN-PRINCIPLES.md. Do not start with a procedural
code change and classify it afterward.

- **Graph** owns workflow policy: legal transitions, branching, eligibility, ordering, and decisions about **when**, **whether**, or **what happens next**. If existing workflow behavior changes, inspect the canonical `workflow/*.mmd` graphs first and change the owning graph when that policy belongs there.
- **Action / effect** performs a concrete mutation or external side effect already selected by a graph. It may validate inputs and report success/failure, but it must not make a second workflow decision.
- **TypeScript code** owns non-policy mechanics: facts, pure calculations, parsing/serialization, persistence primitives, leases/claims, I/O adapters, runtime projections, and concrete guard/action implementations.
- Do not duplicate graph-owned policy in CLI, dashboard, reconciler, webhook, daemon, API, helper, or runtime code.
- For the same intent, every entry point must converge on the same graph/action semantics.
- Final Review must verify the applicable Design Principles, not only code correctness.
- Canonical workflow graph filenames and identities do not use `v1`/`v2`/etc suffixes. Git history is the version history; keep one stable current graph name.

## Execution context ownership

- The shared execution-context resolver owns discovery of project instructions, skills, visible agents, and runtime capabilities.
- Precedence is project-local > parent directories within the configured workspace > explicitly configured shared roots > global `~/.agents` > Relay built-ins. Agent and Shortcut resolution use the same source layers; concrete paths are resolved at execution time, not persisted in task records. Relay never infers shared roots from a specific client or source checkout.
- Agents Relay owns durable orchestration, lineage, leases/retries, lifecycle events, and review gates.
- Workers consume the resolved context. Nested workers delegate only by creating durable Relay child tasks; they must not directly spawn arbitrary child agents.

- Implementation quality instructions must be applied during shared worker prompt assembly, including unnamed normal workers, rather than relying only on a named implementation agent contract. Preserve independent reviewer and specialist-review isolation, and test the immutable prompt snapshots across adapters.

## Escalation and Interactive Review integration

- The canonical `workflow/escalation.mmd` owns escalation branching. Relay's CLI
  launches **only** the executor named by the trusted deployment environment
  `AGENTS_RELAY_ESCALATION_COMMAND`: an absolute executable path or a JSON
  argv array (absolute executable + fixed subcommand arguments). There is no
  built-in Neo CLI dependency, no shell evaluation of Task content, and no
  implicit fallback to an unconfigured provider.
- The executor receives a private `--handoff-file`, optional
  `--on-needs-user-file`, and optional `--cwd`; it must return exactly one JSON
  result with `status: resolved|failed|needs_user` and a nonempty `summary`.
  Missing executors, invalid output, and nonzero exit are technical failures,
  **never** successful recovery or proof of a human-only blocker. Neo may be a
  deployment-selected executor; that choice is outside Relay's source.
- Relay's `review.interactive.begin/wait/ready/fail/abort` owns durable
  invocation, execution binding, review transition and decision acceptance.
  It emits host-neutral `task.interactive_waiting` with
  `source.component: interactive-review`. Do not add Markcut, Neo Mobile,
  video/preview generation, UI, or notification policy to Relay. A host owns
  those effects and must bind its decision to the current invocation, execution
  and current Task execution identity. A delivery receipt never counts as approval.
- Keep recorded historical event source labels unchanged; genericize newly
  emitted events without rewriting persisted review or Job history.

## DAG and Shortcut execution

An `agentGraph` creates runtime Agent Tasks under one Coordinator Task. Each child
uses the ordinary Task lifecycle and either the Script or Model executor; the
Coordinator is not a Worker/lease/retry layer. New Shortcut Jobs only differ
by their explicit CLI activation. Do not add independent DAG failure/recovery
state, model-only revision Tasks, or Shortcut-only Task schedulers. Preserve
legacy in-flight direct Shortcut checkpoints until they complete.

## Verification levels

Use L1 Graph branch and binding verification, L2 role/provider evidence, and L3 deterministic production-ingress/reconciliation/SQLite tests. Do not reference the retired standalone E2E runner or deleted `e2e/` directory. L1 and deterministic L3 passing do not imply a physical UI or provider integration was run; report those gates as `NOT_RUN` until independently verified. Keep negative, restart/dedupe, and false-completion coverage.

Dashboard Jobs search is read-only over the SQLite inventory. Keep UI parameters aligned with the documented `/api/jobs` contract, apply all filters and ordering before server pagination, and verify explicit Refresh reaches the backend with the active conditions.
Jobs filter input, select changes, and Job navigation must only update the client-side list; only the explicit list Refresh button queries `/api/jobs` after initial load. Jobs Refresh and selected Job Refresh must keep stable accessible labels and unchanged request behavior, even when presented as icons. Cap displayed Jobs to the newest 20.
Mobile Jobs and Job detail header controls use borderless icon-only buttons with accessible labels; the status-colored Job details icon reflects the current durable lifecycle state, not connection health. Preserve native select controls and keyboard focus styles.
On mobile Jobs screens, keep Search, Status, Repository, and Refresh in one row without a Reset control. Verify at 320–430 CSS pixels and ensure the page has no horizontal overflow.

## Operational workflows

P0/self-job behavior is defined by `skills/agents-relay/contracts/orchestrator-workflows.md`. Task/job semantics are defined by `skills/agents-relay/contracts/task-job-contract.md`. These are Agents Relay orchestration contracts, not global agent policy.

## Browser Worker Pool safety (ChatGPT / Z.ai)

- Relay Graph/SQLite owns Task transitions. The Browser Worker Pool owns only capacity, FIFO admission, provider health, session leases and recovery effects; it never authors Task success from an HTTP or browser receipt.
- Treat a platform submission as **uncertain** after the browser send may have happened. Never automatically resend or release the occupied Slot until the original execution is reconciled. A verified pre-submission rejection may route to another eligible worker.
- Retain each browser Slot until a correlated terminal event; keep a durable original Thread URL for the dashboard and test any recovery Turn in the same thread and execution. Bound automated recovery attempts.
- WebHelm owns browser groups and stale-tab reclaim. Pool-owned browser activation is only a keepalive and never a Task progress signal. Only independently observed new assistant output or correlated worker events may extend inactivity deadlines.
- Use an isolated SQLite store and caller-owned WebHelm Session in tests. Always stop test-owned Sessions; never stop all Sessions or modify the public WebHelm runtime/extension for Pool policy.

## Browser Worker Pool Graph and live tests

- `workflow/browser-worker-pool.mmd` owns Browser Pool resource decisions, separate from the Relay Task Graph. Keep production bindings in `src/browser-worker-pool-graph.ts` through the shared dispatcher facade; do not make direct graph-evaluate calls in production.
- Pool timeout renewal requires new assistant output and a correlated Relay `task.progress`; a page spinner, lease keepalive, or a submitted recovery Turn can never renew the Task deadline.
- Browser Pool regressions require deterministic negative/healing cases and, for releases that alter WebHelm lifecycle, opt-in real ChatGPT/Z.ai browser tests as described in `docs/BROWSER_WORKER_POOL.md`. Do not count fake CLI tests as real site E2E or interrupt unrelated Sessions.


## Prompt delivery boundary

Planner, Reviewer, Troubleshooter, and Workers use one Graph-selected
`buildRelayWorkPrompt` Action, shared with the read-only `agents-relay prompt`
CLI. Its five logical sections are Role (immutable merged Agent), Bootstrap
(adapter-specific), Contracts (independently pinned files), Contexts (only
relevant project instruction paths), and Task (execution identity only).
Task intent/state is retrieved through the matching Relay CLI (`task context`
or `plan context`), not GitHub/PR projections or backend internals.
L4 verifies each supported role/adapter combination, readable references, and internally pinned Agent snapshots. Generated prompts do not display SHA256 digests or a Relay Skill file path.
A browser submission receipt alone cannot finalize a Task.
See `docs/agent-prompt-builder.md`.
