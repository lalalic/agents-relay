# Agents Relay — project knowledge entry

Relay is a generic, independently deployable native Rust durable Agent runtime.
This file governs development of Relay itself; the `agents-relay` Skill and its
Contracts govern runtime operations. Follow global engineering rules.

## Select project knowledge

Design, Planner, Implementation and Reviewer start with this file in the
assigned project/review checkout. Read only the references needed for the
objective. Apply the Design Principles and Architecture Lens below to architecture-sensitive
work. Never bulk-load `docs/`, old specs or source. Use the `code-intelligence` Skill for targeted source navigation when
available. Use Git history for prior designs/evidence, not current instructions.

| Change area | Read on demand |
| --- | --- |
| Architecture, integration boundaries | [Architecture](docs/architecture.md), [Harness independence](docs/harness-independence.md) |
| Job, Plan, Task, DAG, review, delivery | [Objective-driven Jobs](docs/objective-driven-jobs.md) |
| Graph, guards, actions, state | [Workflow engine](docs/workflow-engine.md) |
| Agent, Contract, Context, prompt | [Prompt builder](docs/agent-prompt-builder.md) |
| Model, profile, quota, routing | [Execution Router](docs/worker-model-routers.md) |
| Process, thread, cancellation | [Worker lifecycle](docs/WORKER_PROCESS_LIFECYCLE.md) |
| Failure, unblock, escalation | [Recovery](docs/unblock-resolution-workflow.md) |
| Preview, human decisions | [Interactive review](docs/interactive-task-host-contract.md) |
| Dashboard, API, SSE, PWA | [Dashboard](docs/DASHBOARD_PWA.md) |
| Runtime diagnostics, service, release | [Observability](docs/structured-observability.md), [Service](docs/service.md) |
| Testing | [Verification](docs/testing-strategy.md) |
| Feedback | [Feedback](docs/feedback-intake.md) |

## Design Principles

1. **Graph owns workflow:** canonical `workflow/*.mmd` determines transitions,
   eligibility, ordering and branching. Keep stable graph names.
2. **Actions are stateless effects:** execute only the selected mutation or side
   effect; validate inputs and return receipts, never decide the next step.
3. **Rust supplies primitives:** facts, persistence, locking, guards, adapters
   and I/O; no second procedural workflow engine. Use small dependencies and
   shared owned-process lifecycle; never clean processes by name.
4. **Same intent, same semantics:** CLI, Dashboard, scheduler, webhook, daemon
   and API converge on shared graph/action semantics, Router and Prompt Builder.
5. **SQLite owns durable truth:** events are wakes/evidence; UI and remote Git
   are not lifecycle authorities. Local Final Review and merge can complete
   without network or PRs. Optional remote delivery is non-force, independently
   retried, and never reopens Jobs or creates recovery Tasks. Preserve fencing.
6. **Flow is not ownership:** dependencies order execution; Task parentage
   records semantic ownership. Neither substitutes for the other.
7. **Harness independence:** caller-specific paths, providers, previews and
   product rules stay outside generic Relay, behind configured interfaces.
   Rust is the only backend; no Node backend, browser Worker pool or parallel
   scheduler. Relay must not require Neo-specific defaults.

## Architecture Lens

For architecture-sensitive changes, identify only applicable answers:

- Which workflow decision changes, and which graph owns it?
- Which guard/action/effect implements it, and where do durable facts live?
- Do all entry points converge without duplicated policy?
- Are dependency flow and semantic ownership kept separate?
- Does any caller-specific dependency cross the generic runtime boundary?

Design and Planner carry only relevant constraints into durable Task inputs.
Implementation preserves them; independent Review verifies them against the
immutable target. A deliberate exception requires the specific principle,
reason and evidence that the normal design cannot satisfy the objective.

Keep project facts in `docs/`, role behavior in Agents, mandatory runtime
obligations in Contracts and procedures in Skills. Never duplicate schemas.
Consult the [Agent Definition Contract](skills/agents-relay/contracts/agent-contract.md),
[Task/Job Contract](skills/agents-relay/contracts/task-job-contract.md) or other
applicable runtime Contract only when changing that interface.

## Role handoff

- Design: establish current ownership, interfaces, constraints and alternatives
  from the relevant references; preserve approved design in the existing Job
  handoff. Planner must include this AGENTS.md entry in any Architect Task input
  (explicitly direct the Architect to read it from the assigned project root).
- Planner: complete proportionate research and technical design before
  assignment; pass verified relevant files/symbols, decisions, internal steps
  and acceptance evidence requirements in Task input. Delegate specialist design
  only when needed.
- Implementation: start with the Planner's Code Map, verify against actual
  source, reuse canonical code, implement narrowly, test and self-review;
  update affected current docs.
- Reviewer: independently inspect the immutable target and applicable current
  design/acceptance constraints; do not edit artifacts or trust a summary as proof.

## Verification and delivery

Use isolated `AGENTS_RELAY_STORE_DIR`; never mutate production Jobs in tests.
Apply L1–L4 and required negative/restart/dedupe coverage as applicable; see
[verification](docs/testing-strategy.md). Dashboard/HTTP/SSE/runtime status or
publication changes require `scripts/test-dashboard-browser.sh`. Report real
provider/device/browser gates as NOT_RUN when unexecuted. For authorized native
publication use `node scripts/publish-native.mjs` and verify the durable release
receipt; use `node scripts/live-native.mjs` separately for deployment. Record
reusable lessons in their owning current document, graph or test rather than
appending incident history.
