# Agents Relay — source policy

Relay is a generic, independently deployable durable Agent runtime and Skill.
Follow global agent rules. Use the installed `agents-relay` Skill for operator
workflows; this file governs development of Relay itself.

## Architecture and ownership

- [DESIGN-PRINCIPLES.md](DESIGN-PRINCIPLES.md) is the architecture authority.
  Apply its relevant Architecture Lens **before** changing behavior; carry
  the applicable constraints into Task inputs and independent Final Review.
- Canonical `workflow/*.mmd` graphs own workflow decisions; Rust actions
  implement their selected effects and persistence mechanics. Every entry
  point converges on the same semantics. Keep stable graph names.
- SQLite owns durable lifecycle state; events are wakes and evidence, not
  an alternative state store. Workers and daemon processes are replaceable.
  Local Git completion is independent of optional post-completion origin
  delivery. Preserve historical records and exact execution fencing.
- Rust is the only backend (`rust/src/`). Do not restore Node/TypeScript
  servers, browser Workers, WebHelm pools, parallel schedulers or a mirrored
  test suite. Model execution uses configured Codex providers; Script
  execution uses declared Shortcuts. Keep caller-specific Harness,
  preview and provider effects outside generic Relay.
- Use standard library and small dependencies. All disposable subprocesses
  use the shared owned-process lifecycle, including cancellation, timeout,
  retry and parent death; never clean by process name.

## Job, Agent and prompt contracts

- [Task/Job Contract](skills/agents-relay/contracts/task-job-contract.md)
  owns creation, immutable Git-root identity, lineage, task sizing and
  lifecycle. [Preflight](skills/agents-relay/contracts/job-create-preflight.md)
  and [Orchestrator workflows](skills/agents-relay/contracts/orchestrator-workflows.md)
  own creation authorization and P0/ordinary workflows. Declared Project
  Runs use the validated runner and Coordinator; ordinary Jobs do not
  acquire a gratuitous DAG. Do not persist preflight attestation.
- [Agent Definition Contract](skills/agents-relay/contracts/agent-contract.md)
  owns Agent inheritance, Contracts, Contexts, required Skill names and
  advisory routing hints. Use the shared resolver and Prompt Builder;
  see [prompt assembly](docs/agent-prompt-builder.md). Job Tasks compose
  Worker Contracts, not implicit Worker inheritance. Project Context is
  explicitly Agent-owned; Implementation and Planner declare it.
  Do not assume generic Workers, Reviewers or DAG Stages receive AGENTS.md.
- Keep role-specific behavior in Agent definitions, mandatory principles
  and invariants in Contracts, operational procedures in Skills, and
  project-wide engineering policy here. Workflow decisions remain Graph-owned.
  Preserve independent review isolation. Resolve concrete paths at execution
  time from configured roots, not from a client or transport pool.
- Use the execution-bound native CLI for Task/Plan facts and lifecycle
  operations. See [execution boundary](skills/agents-relay/contracts/execution-boundary.md)
  and [event contract](skills/agents-relay/contracts/event-contract.md).
  Submission, process exit and preview receipts are not completion.

## Integration boundaries

- [Escalation](workflow/escalation.mmd) selects recovery; execute only the
  trusted deployment-configured `AGENTS_RELAY_ESCALATION_COMMAND`.
  No implicit Neo dependency or shell interpretation of Task content.
- [Interactive Review](docs/interactive-task-host-contract.md) owns durable
  execution-bound decisions. Hosts own Preview generation/notification.
  Keep events host-neutral and historical source labels unchanged.

## Verification and delivery

- Isolate `AGENTS_RELAY_STORE_DIR` for repository tests and child CLIs.
  Never mutate production Jobs. Verify graph branches/bindings (L1),
  role/provider evidence (L2), deterministic ingress, reconciliation and
  SQLite recovery (L3), and actual Prompt/Harness assembly (L4) as applicable.
  Retain negative, restart, dedupe and false-completion cases. Report
  real provider/browser gates as NOT_RUN when unexecuted.
- Dashboard UI, HTTP/SSE, runtime status or publication changes must pass
  `scripts/test-dashboard-browser.sh` before review/merge/release using
  real Chrome, pinned playwright-core and isolated native fixtures.
- Keep the dashboard framework-free. Preserve live API filters, ordering
  before pagination, accessible explicit Refresh semantics, client-side
  filtering between refreshes, and the newest-20 display limit. Mobile:
  one Search/Status/Repository/Refresh row without Reset, borderless
  accessible header icons, durable status coloring, native selects and
  visible focus; check 320–430 CSS pixels without horizontal overflow.
- Use `node scripts/release-native.mjs` for native deployment; report
  verified release SHA/version/registry or actual failure stage via
  `scripts/report-publication.mjs` or the shared authenticated publication
  Action. Verify the durable receipt; never invent Job IDs or report
  staging as installation. Relay owns Git-ancestry publication correlation.

Record durable lessons in the owning Agent, Contract, Graph or test;
remove obsolete guidance rather than accumulating incident history.
