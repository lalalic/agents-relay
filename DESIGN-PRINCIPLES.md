# Agents Relay V2 Design Principles

This document is the canonical architecture contract for Agents Relay V2.
README and AGENTS may summarize or translate it into execution rules, but they
must not maintain an independent copy of these principles.

## Principles

### 1. Workflow lives in Graph

Workflow policy belongs in the canonical Mermaid workflow graphs. Legal
transitions, eligibility, ordering, branching, and decisions about when,
whether, or what happens next are graph-owned.

### 2. Actions are stateless effects

An action/effect performs a concrete mutation or side effect already selected
by a graph. It may validate inputs and report success/failure, but it must not
keep hidden workflow state or independently choose the next workflow step.

### 3. Graph outcomes select Actions

TypeScript runtime code provides facts, persistence, locking/claims, adapters,
I/O, and primitive guards/effects. It must not reproduce graph-owned policy as
a second procedural state machine.

### 4. Same intent, same semantics regardless of entry point

CLI, dashboard, scheduler, webhook, daemon, and API entry points must converge
on the same authoritative graph/action semantics. Entry points may translate
inputs, but they must not implement their own workflow policy.

### 5. Operational truth and collaboration projection are distinct

RelayStore/SQLite owns operational execution truth. GitHub is an external collaboration adapter only (PR creation, review, merge,
commit), never a lifecycle discovery, reconciliation, or recovery authority.
Events wake the local Graph Engine; they are not a second durable database.

### 6. Execution flow and semantic ownership are distinct

Workflow graphs and Task dependencies describe execution flow. The Task tree
describes semantic ownership of durable outcomes. Do not use one relationship
as a substitute for the other.

## Architecture Lens

For architecture-sensitive work, planning must answer only the questions that
materially apply:

1. What workflow decision changes?
2. Which canonical graph owns that decision?
3. Which action/effect performs the selected mutation or side effect?
4. Where does the durable state live?
5. Does any TypeScript, CLI, dashboard, scheduler, webhook, daemon, or API path
   duplicate graph authority?
6. Do all entry points for the same intent converge on the same semantics?
7. Is execution flow being confused with semantic Task ownership?

If a question does not apply, omit it rather than copying the whole lens into
every Task.

## Planning contract

The Planner must identify the relevant principles before it emits an
architecture-sensitive Task. Put the resulting task-specific Architecture Lens
answers or constraints in that Task's durable input. Do not duplicate the full
principles document into Task text.

## Review contract

Final Review must verify the implementation against the relevant principles and
the durable Job objective. In particular, review must detect:

- a workflow decision implemented outside its canonical graph;
- an action/effect that owns hidden workflow state or independently decides the
  next step;
- procedural code that duplicates graph authority;
- divergent semantics between entry points for the same intent;
- operational state persisted in the wrong authority layer; or
- Task dependencies used as a substitute for semantic Task ownership, or vice
  versa.

The shared reviewer agent is resolved through project execution context. For
Agents Relay work, AGENTS.md requires the reviewer to consume this document;
the reviewer contract therefore does not need a second copy of these rules.

## Change discipline

When a deliberate exception to a principle is necessary, record the specific
principle, why the exception is required, and evidence that the normal design
cannot satisfy the objective. Git history is the version history for this
contract; do not create parallel V1/V2-suffixed copies.
