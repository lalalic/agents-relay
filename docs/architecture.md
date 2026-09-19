# Agents Relay architecture

## Goal

Provide a generic, shareable async agent job system where orchestrators can create durable objectives, delegate recoverable child tasks, optionally route those tasks through reusable registered agents, persist results/evidence, and continue dependents when durable state changes.

## Durable model

- **GitHub pull request** — durable top-level job container and audit surface.
- **Job marker comment** — durable job metadata and continuation state.
- **Task marker comments** — durable child-task state, lineage, leases, routing, selected agent, result, and recovery metadata.
- **Shared agent registry issue** — durable reusable agent registrations and their observed evidence. Repository scope is default; global scope is explicit.
- **Agents Relay daemon** — reconciler, scheduler, dispatcher, lease/recovery manager, continuation engine, and dashboard server.
- **Worker adapters** — execution runtimes such as shell, Codex, and ChatGPT.
- **Registered-agent endpoints** — constrained adapter, absolute-command, or HTTP dispatch targets selected through an agent registration.
- **Event adapter** — optional low-latency notification/wake channel; events never replace durable GitHub state.
- **Artifact references** — large/private outputs stay outside GitHub comments; durable records store summaries/references.

There is no second operational database. Local `--file` state exists only for explicit demo/test mode.

## Agent != Skill != Adapter

These are independent layers:

- **Agent** — durable result-owning identity/role. Registration describes name, role, responsibility, boundaries, claimed capabilities, endpoint/runtime, availability, routing metadata, and evidence.
- **Skill** — callable capability or behavior contract an agent or orchestrator may use. Skills are not worker identities and are not registry records.
- **Adapter** — execution runtime. A Codex/ChatGPT/shell adapter can execute many tasks and does not by itself own a responsibility or reputation.

Agent identity therefore remains stable even when its execution mechanism changes. Conversely, choosing an adapter does not mean a registered agent was chosen.

## Managed job workflow

For GitHub-backed work, PR creation/adoption and job management are first-class CLI operations:

1. `agents-relay job create` creates/reuses an open PR and guarantees exactly one trusted job marker.
2. `agents-relay job adopt` brings an existing unmanaged PR under the same contract.
3. `agents-relay job repair` repairs duplicate markers for the same job while rejecting conflicting job identity.
4. `submit`, `status`, `reconcile`, `retry`, `cancel`, and `serve` operate only after a managed job exists.
5. `record` is a repair/backfill path for work already completed outside the relay; normal work is submitted before execution.

The legacy `init` command remains for compatibility. `--file` is explicit local demo/test mode.

## Shared registry scope

A registered agent is reusable across jobs; it is not owned by a job PR.

### Repository scope

Repository scope is the default. The store locates one trusted registry issue in that repository, identified by an `agents-relay:agent-registry:v1` marker. Agent registrations are trusted `agents-relay:agent:v1` comments on that issue.

All jobs in the repository can read the same agents. Existing trusted PR-scoped agent markers remain a read-only compatibility source. Shared registry records take precedence for duplicate agent IDs, and updating/re-registering a legacy agent writes the current record to the shared registry without rewriting historical PR comments.

### Global scope

Global scope is opt-in. The caller must explicitly provide the GitHub repository that owns the global registry. `--scope both` intentionally reads repository then global scope; it does not silently widen trust.

A registry is accepted only when trusted authorship and marker repository/scope match. Ambiguous trusted registry markers are errors rather than guessed.

## Agent CLI

The first-class namespace is:

~~~text
agents-relay agent register
agents-relay agent list
agents-relay agent show
agents-relay agent discover
agents-relay agent eval
agents-relay agent scores
~~~

`agent-register` and `agent-discover` remain backwards-compatible aliases.

Registration is declarative. Claimed capabilities are eligibility/routing metadata only; they are never treated as observed proof.

## Discovery and routing

Discovery is intentionally two-stage.

### 1. Hard filters

Candidates must satisfy the requested:

- claimed capabilities;
- runtime;
- endpoint kind;
- availability (offline excluded by default);
- labels;
- trust domains;
- regions;
- required boundaries;
- optional minimum evidence-derived capability scores.

A missing/stale/unscored capability cannot satisfy a requested minimum score.

### 2. Explainable ranking

Eligible candidates are ordered using observable dimensions, including:

- task-kind success rate/sample count;
- per-capability evidence score;
- broader registered-agent outcome reliability/sample count;
- availability;
- mean observed latency;
- mean observed cost.

The candidate output includes reasons and evidence. No fake universal trust score is computed. `--explore` may promote at most one unscored candidate immediately behind the strongest observed candidate. Discovery does not make the final routing decision: the orchestrator chooses from the returned candidates.

## Selection and dispatch lifecycle

An orchestrator selects an agent and submits the durable task with `--agent-id` plus the task's capabilities and any required boundaries/trust domains/regions. The selected agent ID is stored on the task and remains through retries.

Immediately before each launch the reconciler reloads the registration and revalidates availability and task constraints. Dispatch then maps the registration to an execution runtime without conflating identity with adapter:

- **adapter endpoint** — target must match the registered runtime adapter and resolve to a configured worker adapter;
- **command endpoint** — target must be an absolute executable path, launches with `shell: false`, and receives only a restricted environment;
- **HTTP endpoint** — only HTTPS is accepted remotely; unauthenticated HTTP is allowed only for loopback. Non-loopback endpoints require an `authEnv` credential reference.

HTTP credentials are read from the local environment at launch and are not persisted. The HTTP payload contains job/task/parent/project/input/attempt context, not arbitrary local secrets.

The normal task contract still owns dependencies, state transitions, leases, timeouts, retries, thread/continuation state, terminal result, and recovery.

## Evidence lifecycle

Claimed capability and observed evidence remain separate.

For every terminal registered-agent attempt, the reconciler records one durable task observation when the execution ID is still current:

- success, failure, or timeout;
- job/task/execution ID and attempt;
- task kind and task capabilities;
- timestamp;
- runtime/model version;
- result/error summary;
- latency;
- cost when the worker result exposes it.

Execution ID deduplication prevents stale duplicate completions or reassignment races from double counting. A real retry has a different execution ID and is a distinct observation.

Representative suites are recorded separately by `agents-relay agent eval` with `source: suite`; automatic real-task observations use `source: task`. Both persist in the existing agent registry marker/store.

## Capability scoring and freshness

`agents-relay agent scores` derives scores from observations, never from claimed capabilities.

For each observed capability:

- score = successful **fresh** observations / all fresh observations, expressed 0-100;
- confidence = a sample-count confidence indicator;
- total, fresh, and stale sample counts are exposed;
- last observation and stale state are exposed;
- no fresh observations means the score is unscored (`null`), not zero.

The default freshness window is 90 days and can be overridden with `--stale-after-days`. Discovery can enforce one minimum for requested capabilities with `--min-score`, or per-capability thresholds with `--min-scores capability=N,...`.

Reliability, latency, cost, confidence, and freshness remain separate evidence dimensions.

## Reconciliation rule

Every wake-up means only: "the durable state may have changed." The daemon reloads GitHub state, derives desired actions, and reconciles actual execution state. It never advances a job solely because an event claimed something happened.

GitHub PR lifecycle is authoritative at reconciliation boundaries: merged forces the managed job to `COMPLETED`; closed-unmerged forces `CANCELLED` and prevents queued launches.

## State

Job states:

~~~text
OPEN -> RUNNING -> WAITING|BLOCKED -> COMPLETED|FAILED|CANCELLED
~~~

Task states:

~~~text
QUEUED -> READY -> RUNNING -> WAITING|BLOCKED -> SUCCEEDED|FAILED|CANCELLED
~~~

A task becomes READY when its dependencies have succeeded and any manual/approval gate is released.

## Continuations

Continuations are separate from worker adapters. v1 supports Codex-thread continuation plus generic command/webhook contracts. Hosted web chat continuation can rely on host integration, but recoverable durable state remains in the PR.

## Security boundaries

Current implementation intentionally limits the control surface:

- trusted GitHub authorship gates managed markers/registry state;
- cross-repository/global registry lookup is explicit;
- registry records contain routing metadata/evidence, not credentials or private prompts;
- command endpoints cannot use relative paths or shell interpretation;
- remote HTTP requires HTTPS and an environment-based credential reference;
- unauthenticated HTTP is loopback-only;
- registered-agent constraints are checked again at launch;
- events remain non-authoritative.

## Explicit future scope

The following are not implemented by this architecture and must not be described as current behavior:

- a broad hosted or unauthenticated remote job/control API;
- a public agent marketplace or public discovery service;
- autonomous final routing without orchestrator choice;
- general multi-owner identity/federated trust enforcement;
- private-data or credential-bearing cross-owner routing policy;
- sandbox/isolation guarantees for arbitrary remote agents;
- billing/accounting/quotas for third-party agents;
- distributed atomic leases for multiple active reconcilers per job.

A future remote service should be designed only after concrete identity/trust boundaries exist; it must not weaken the durable GitHub or endpoint security contracts above.

## Validation

For agent-network changes run:

~~~sh
npm test
npm run build
git diff --check
~~~

Tests cover registry scope/trust, CLI validation, discovery filters/ranking/exploration, dispatch security/lineage/retry behavior, durable outcome evidence, scoring/freshness/minimum scores, and existing job/task reconciliation behavior.
