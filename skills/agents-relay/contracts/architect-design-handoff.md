# Architect Design Handoff Contract

When the Relay Planner decides an architecture Task is needed, use a **visible Agency Architect role** through a durable Relay Task. The Agency library provides expertise, not a separate execution runtime. This contract does not create a new role, Job field, or lifecycle state.

## Planner to Architect: input contract

Before dispatch, specify in the Architect Task input:

- Which Job requirements and accepted user decisions the design must satisfy.
- The interface, system-boundary, security, consistency, recovery, and other decisions that need design, including trade-offs and validation expectations.
- The **exact tracked Markdown design deliverable path**. For an authorized Spec Kit feature with valid prerequisites, prefer `specs/<feature>/plan.md`, with optional `research.md`, `data-model.md` and `contracts/`. Otherwise use a project-approved design path such as `docs/architecture/<feature>.md`. Never create an unsolicited Spec Kit tree.
- Acceptance criteria for the design itself. An absent/unresolvable Architect role is a blocker, not a reason to invent one.

## Architect to Planner: durable result contract

The Architect owns the design, writes the agreed file in the authorized managed checkout, and includes requirement traceability, design decisions and rationale, contracts and boundaries, alternatives/trade-offs, failure modes, validation approach, and unresolved decisions.

The Architect must **read back and self-review** the file against the Job/Task criteria, fix actionable gaps, and make it durable with the supported Relay Task completion/delivery path. The Task Result names each project-relative design artifact path, relevant version/commit evidence, important decisions and validation performed. A summary without the tracked artifact, or an uncommitted/unreadable document, is not a completed design handoff.

## Planner acceptance: inspect before implementation

In a later Plan round, the Planner retrieves the **completed Architect Task Result** from the execution-bound Relay `plan context` and **reads the actual design file** at its applicable version/checkout. Confirm the file exists and is accessible, matches the reported version/evidence, covers the material Job criteria, and respects settled user constraints.

If the handoff is missing, stale, contradictory, or incomplete, ask for design correction/recovery; do not fabricate design or schedule implementation as though the prerequisite passed. When verified, derive implementation Tasks with explicit design-file **path/revision references**, applicable decisions, acceptance checks and correct dependencies. Architect's design file is the technical design authority; the Relay Plan and Task DAG are the execution authority. Do not copy the design into Job objective or use Spec Kit `tasks.md` as a second Relay Task store.

Skip this handoff entirely for simple Jobs that do not need architecture work. Normal Relay Graph/SQLite and independent Final Review remain unchanged.
