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

The initial decomposition belongs to that durable Planner round. The orchestrator must not hand-author the initial child Task batch as a substitute. If initial planning fails, the create command fails visibly after preserving the durable Job/Plan evidence; the orchestrator must not silently invent Tasks. This applies regardless of whether the Job uses `fixed` or `autonomous` execution mode. Later replanning continues to follow Relay's normal Planner/reconciliation rules.

## P0 / self job workflow

A **P0 job** (alias: **self job**) is executed directly by the current active orchestrator thread:

1. The orchestrator creates the durable job.
2. The orchestrator immediately creates the required orchestrator-owned task(s); do not leave the P0 job idle.
3. The current orchestrator thread starts executing those tasks immediately rather than delegating them to another worker. Creating an `adapter: orchestrator` Task is never a handoff: the exact creator owns it for this turn.
4. The orchestrator must terminalize every orchestrator-owned Task it created before ending the turn. It must not return to the user with one of its self-tasks left `QUEUED` or `RUNNING`; successful work uses `task complete` on that same durable Task.
5. P0/self jobs do not require the normal reviewer gate unless the user explicitly asks for review.
6. After implementation and local verification, the orchestrator merges the job itself and completes normal post-merge reconciliation.

Recovery exception: reconciliation may rescue only a `QUEUED` work Task with `adapter: orchestrator` that has no execution identity and is at least 30 minutes past `createdAt`. It converts that Task in place to a normal ChatGPT-routable Task, preserving its durable intent and Task identity while clearing stale routing state. `RUNNING` and terminal Tasks are not rescued. This is a stale-task safety net, not an asynchronous handoff mechanism for newly created self-work.

`job create` still only creates durable job state; the P0 workflow requires the orchestrator to follow it immediately with task creation and execution.

## Merge completion vs deployment evidence

For a normal one-shot managed Job, the canonical Job lifecycle graph owns completion: a durable `pr.merged` fact transitions the Job to `COMPLETED`. Reconciler and deployment code must not invent a second completion gate after merge.

Post-merge publication and deployment activity is separate from Job lifecycle. Events or evidence such as `package.published`, published version metadata, service restart, and deployment verification may be attached after the Job is already `COMPLETED`; they must not hold the Job open, reopen it, or redefine completion. If post-merge deployment needs remediation, record that as separate deployment/recovery work rather than mutating the completed implementation Job lifecycle.

A PR closed without merge follows the same graph-owned rule through `pr.closed -> CANCELLED`.
