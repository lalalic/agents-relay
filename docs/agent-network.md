# Operational agent network

## Objective

Agents Relay extends durable PR-backed task orchestration with reusable registered agents that can be discovered, selected by an orchestrator, dispatched through constrained runtimes, and improved from durable observed evidence.

The design preserves the core invariant: GitHub durable state is authoritative; events are only observability/wake signals.

## Concept contract

**Agent != Skill != Adapter.**

- **Agent** owns a result/responsibility and has durable identity, boundaries, claimed capabilities, endpoint/runtime, availability, routing metadata, and evidence.
- **Skill** is a callable capability/behavior contract and is not a durable worker identity.
- **Adapter** is an execution runtime and does not itself own role/responsibility/evidence.

## What is shipped

- Shared repository/global durable registry backed by trusted GitHub registry-issue markers.
- Read compatibility for legacy trusted PR-scoped agent registrations.
- First-class `agent register|list|show|discover|eval|scores` CLI, with legacy registration/discovery aliases.
- Hard-filtered discovery for capabilities, runtime, endpoint kind, availability, labels, trust, regions, boundaries, and evidence-derived minimum scores.
- Explainable ranking using task evidence, capability scores, reliability/sample evidence, latency, cost, and controlled exploration.
- Explicit orchestrator final selection.
- Durable task selection via `--agent-id`.
- Registered dispatch through configured adapter, absolute command, or constrained HTTP endpoints.
- Launch-time revalidation of availability/capability/boundary/trust/region requirements.
- Automatic durable success/failure/timeout evidence from real registered-agent task attempts.
- Explicit representative suite observations through `agent eval`.
- Per-capability 0-100 scores from fresh evidence with confidence, sample counts, and staleness handling.
- Minimum capability-score constraints in discovery.
- No second operational database.

## Registry scope

Repository scope is default and reusable by every job in that repository. Global scope is explicit and requires `--registry-repo`; combined lookup is opt-in. Shared records win duplicate IDs over legacy PR-scoped compatibility records.

Trusted authorship and exact registry repository/scope markers define registry authority. Ambiguous trusted registries are errors.

## Routing lifecycle

1. Register/update reusable agent metadata.
2. Discover with hard task/security constraints.
3. Inspect explainable evidence/ranking.
4. Orchestrator selects the agent.
5. Submit a durable task with `--agent-id` and real task constraints.
6. Reconciler reloads/revalidates the registration at launch.
7. Dispatch through the registered endpoint without changing task lineage/lease/retry semantics.
8. Persist task result and one execution-scoped evidence observation.
9. Reconcile dependents/continuations.
10. Future discovery uses the new evidence.

`--explore` may intentionally place one unscored candidate behind the strongest observed candidate; it does not bypass hard filters.

## Evidence and scoring

Claims only determine declared fit. They never create observed quality scores.

Automatic task observations and explicit suite observations record capability context, result class, execution identity, time/version, latency, and cost when visible. Duplicate execution IDs are not counted twice.

Capability scores use fresh observed success rate. Default freshness is 90 days. Scores expose confidence and total/fresh/stale sample counts; stale-only capability evidence becomes unscored. Reliability, latency, and cost remain separate explainable dimensions.

## Dispatch security

- Adapter endpoint: must resolve to a configured adapter and match the registration's runtime adapter.
- Command endpoint: absolute executable only, no shell interpretation, restricted environment.
- HTTP endpoint: loopback HTTP is allowed; remote HTTP must be HTTPS and declare `authEnv`.
- Credentials are read locally at launch and never stored in registry/job/task markers.
- Offline agents and agents that no longer satisfy task constraints are rejected before launch.

These checks constrain dispatch; they are not a claim of arbitrary remote sandboxing.

## Explicit non-goals / future scope

Not shipped:

- public marketplace or public discovery;
- broad hosted/multi-tenant remote job API;
- unauthenticated remote control surface;
- autonomous final agent choice;
- general cross-owner private-data/credential routing;
- federated identity/trust policy enforcement;
- remote sandbox/isolation guarantees;
- billing/settlement/quotas;
- multiple active reconcilers without a distributed atomic lease.

Any future remote job/status service must start from a concrete authenticated identity/trust model and retain GitHub durable truth and the current secret-handling boundaries.

## Validation

Run:

~~~sh
npm test
npm run build
git diff --check
~~~
