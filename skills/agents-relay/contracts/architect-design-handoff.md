# Architect Design Handoff Contract — Job-native Markdown

When the Relay Planner decides an architecture Task is needed, use a **visible Agency Architect** role through a durable Relay Task. Agency supplies expertise, not a separate runtime. **The Job is the durable handoff record; do not require a repository design file, `spec.md`, or `plan.md` for this handoff.** This contract adds no Job field or lifecycle state.

## Data ownership

- `Job.objective` owns the original user goal, constraints and acceptance criteria, plus a clearly delimited **Architecture Design** Markdown section appended after design review. Do not rewrite or weaken the original user-intent sections.
- `Architect Task.input` states the design questions and expected content **before execution**; it is not a mutable design-output field.
- `Architect Task.result` records the Architect's full design in Markdown and its self-evaluation/evidence. This preserves Agent attribution and history inside the Job, but Planner context summaries may be truncated; inspect the full durable result with `job show` when needed.
- `Job.description` is not the selected destination: although present in the Job type, it is not writable through the current `job create` / `job update` CLI. Avoid adding schema or runtime changes just to use it.

## Planner to Architect

Planner autonomously determines whether design is necessary. If so, create the durable Architect Task using an actually visible/resolvable Agency-derived project Agent. Define the relevant Job requirements, known decisions, interface/data/trust boundaries, alternatives, failure handling, and specific **Markdown design acceptance criteria**. No design-document path is required; don't invent an Agent or spawn it outside Relay. The Task still uses whichever existing Relay Task output form the runtime supports; that mechanical output is **not** the canonical architecture handoff.

## Architect produces and self-reviews design

The Architect's Task Result must contain a complete `## Architecture Design` Markdown deliverable, with requirement traceability, selected approach and rationale, major interfaces/contracts, trade-offs, assumptions, risks and error/recovery behavior, verification strategy, and unresolved decisions. Self-evaluate against the Job objective, repair actionable omissions, then complete the Task using the supported Relay protocol. Do not claim the Task is complete based on a short summary or a file reference.

## Planner validates and records in Job

In the subsequent Plan round, retrieve the durable Architect Task result via the execution-bound Relay CLI (`plan context` for Task identity; `job show --id JOB_ID` for the **full** result if the context summary is bounded). Check completeness and consistency against the **original** Job goal, constraints and acceptance criteria. Do not plan dependent implementation if the design is missing, contradictory or unverified; request design correction/recovery instead.

On acceptance, read the **latest** Job objective, preserve its original sections verbatim, and append or update one identifiable `## Architecture Design` Markdown section containing the approved design, source Architect Task ID, and revision/context. Persist through the existing `job update --id JOB_ID --objective-file PATH|-` interface (stdin is allowed); read back with `job show` to confirm the full content was retained. Never silently overwrite concurrent Job changes or duplicate design sections; if latest state differs or the update cannot be verified, stop and reconcile. The accepted design is then accessible to the next Planner round and eventual independent Final Reviewer through the Job itself. An architecture elaboration does not by itself authorize scope changes: material changes to user intent or acceptance criteria require clarification and preflight again.

## Next Job / cross-repository reuse

A new Job never inherits a predecessor's objective automatically. Its creating Orchestrator explicitly retrieves the upstream Job with `job show --id UPSTREAM_ID`, selects relevant **Architecture Design** sections and their provenance, and includes that Markdown in the new Job objective before the normal Specify/Clarify/preflight quality gate. Never assume a file path or previous thread remains accessible across repositories. The upstream Job remains the provenance source; the downstream Job owns its own scoped acceptance criteria.

Skip the Architect handoff for simple Jobs that don't need design. The existing Relay Graph/SQLite, Task result semantics and immutable-head Final Review remain unchanged.
