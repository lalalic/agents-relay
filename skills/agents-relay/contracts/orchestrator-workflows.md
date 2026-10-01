# Agents Relay Orchestrator Workflows

## Job context capture

Before `job create`, the orchestrator converts the relevant discussion into a standalone Markdown objective. Prefer `--objective-file`; if a diagram materially clarifies workflow/state/architecture/dependencies, put Mermaid first. The objective must be sufficient for a fresh orchestrator/agent to complete the Job without access to the original conversation. Creating the Job is the context-compaction boundary: important decisions must be copied into durable Job context before work is delegated.

This contract defines orchestrator-owned exception workflows that sit above normal Agents Relay task/job execution.

## Normal managed Job start workflow

For a normal managed Job, `job create` or `job adopt` establishes durable Job/PR state only. Unless the user explicitly requested **create-only / no execution**, the orchestrator must immediately start the Job by invoking the first-class Planner command for that exact Job:

```text
job create|adopt
  -> agents-relay plan --repo <owner/repo> --pr <number> --id <job_id>
  -> durable plan-N
  -> Planner next_tasks
  -> Relay materializes Tasks
  -> normal routing, execution, and reconciliation
```

The initial decomposition for a normal managed Job belongs to that durable Planner round. The orchestrator must not hand-author the initial child Task batch as a substitute for `agents-relay plan`, and it must not leave a newly created executable Job with zero Plans and zero Tasks. If the Planner command fails, the Job is blocked at startup and the orchestrator must report the failure rather than silently inventing Tasks.

This rule applies regardless of whether the Job uses `fixed` or `autonomous` execution mode; execution mode does not replace the required initial Planner invocation. Later replanning continues to follow Relay's normal Planner/reconciliation rules.

The explicit exception is the P0/self-job workflow below: a self job is synchronous orchestrator-owned execution, so it creates orchestrator-owned Tasks directly and terminalizes them in the same turn instead of invoking the normal initial Planner round.

## P0 / self job workflow

A **P0 job** (alias: **self job**) is executed directly by the current active orchestrator thread:

1. The orchestrator creates the durable job.
2. The orchestrator immediately creates the required orchestrator-owned task(s); do not leave the P0 job idle.
3. The current orchestrator thread starts executing those tasks immediately rather than delegating them to another worker. Creating an `adapter: orchestrator` Task is never a handoff: the exact creator owns it for this turn.
4. The orchestrator must terminalize every orchestrator-owned Task it created before ending the turn. It must not return to the user with one of its self-tasks left `QUEUED` or `RUNNING`; successful work uses `task complete` on that same durable Task.
5. P0/self jobs do not require the normal reviewer gate unless the user explicitly asks for review.
6. After implementation and local verification, the orchestrator merges the job itself and completes normal post-merge reconciliation.

`job create` still only creates durable job state; the P0 workflow requires the orchestrator to follow it immediately with task creation and execution.
