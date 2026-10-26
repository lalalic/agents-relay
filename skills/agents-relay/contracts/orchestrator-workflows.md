# Agents Relay Orchestrator Workflows

## Job context capture

Before `job create`, the orchestrator converts the relevant discussion into a standalone Markdown objective. Prefer `--objective-file`; if a diagram materially clarifies workflow/state/architecture/dependencies, put Mermaid first. The objective must be sufficient for a fresh orchestrator/agent to complete the Job without access to the original conversation. Creating the Job is the context-compaction boundary: important decisions must be copied into durable Job context before work is delegated.

This contract defines orchestrator-owned exception workflows that sit above normal Agents Relay task/job execution.

## Normal managed Job start workflow

For a normal managed Job, the preferred bootstrap is one command:

```text
job create --initial-plan
  -> durable plan-N
  -> Planner next_tasks
  -> Relay materializes Tasks
  -> normal routing, execution, and reconciliation
```

Without `--initial-plan`, `job create` remains create-only and establishes durable Job/PR state without execution. `agents-relay plan` remains available for an existing create-only/adopted Job. Unless the user explicitly requested **create-only / no execution**, the orchestrator should use `job create --initial-plan` rather than issuing two separate commands.

The initial decomposition belongs to that durable Planner round. The orchestrator must not hand-author the initial child Task batch as a substitute. If initial planning fails, the create command fails visibly after preserving the durable Job/Plan evidence; the orchestrator must not silently invent Tasks. Every Job follows this same objective-driven lifecycle. After a completed implementation batch, Relay automatically creates subsequent Plan rounds until the latest successful Plan reports `objective_status: satisfied`; there is no fixed/autonomous execution mode or Job scheduling.

## P0 / self job workflow

For a self Job owned by the current XChat thread, resolve the current thread ID
before creating the Job. If it cannot be retrieved reliably, ask the user for
the thread ID before proceeding. Set `creatorThreadId`,
`implementationThreadId`, and `reviewerThreadId` to that same thread ID at
creation, using the corresponding `--creator-thread-id`,
`--implementation-thread-id`, and `--reviewer-thread-id` options. Do not infer
the thread ID from an unrelated worker, execution, or previous conversation.

P0/self work is ordinary durable Relay work. The orchestrator may choose normal
Task requirements, but every newly created work Task is executable by a
worker/model route selected by Execution Router. Relay has no privileged
orchestrator-worker lifecycle, and new Task creation rejects
`adapter: orchestrator`. P0/self jobs do not require the normal reviewer gate
unless the user explicitly asks for review; Relay-owned merge and completion
lifecycle remain in their canonical graphs.

Legacy recovery: existing `adapter: orchestrator` work Tasks may be repaired only
through the canonical rescue graph. The repair converts only never-started QUEUED records in place to declarative worker requirements and lets Execution Router select the route. A legacy RUNNING record with an unknown outcome is quarantined as BLOCKED instead of replayed; only explicit durable external-completion verification may complete it without execution. Process reclamation is attempted only after the record is proven eligible for this legacy path, so normal live workers are never touched by the migration scan.

`job create --initial-plan` remains the normal way to create durable planning
state and hand subsequent execution to Relay.

## Merge completion vs deployment evidence

For a managed Job, the canonical Job lifecycle Graph owns completion. A satisfied Plan, successful implementation evidence, applicable SHA-bound review, and a verified local merge/delivery receipt are required. Remote GitHub `pr.merged` facts are audit-only and never independently complete a local Job. Deployment code must not invent another completion gate after durable Job completion.

Post-merge publication and deployment activity is separate from Job lifecycle. Events or evidence such as `package.published`, published version metadata, service restart, and deployment verification may be attached after the Job is already `COMPLETED`; they must not hold the Job open, reopen it, or redefine completion. If post-merge deployment needs remediation, record that as separate deployment/recovery work rather than mutating the completed implementation Job lifecycle.

A PR closed without merge follows the same graph-owned rule through `pr.closed -> CANCELLED`.
