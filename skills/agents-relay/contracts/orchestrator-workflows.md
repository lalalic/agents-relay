# Agents Relay Orchestrator Workflows

## Job context capture

Before `job create`, the orchestrator converts the relevant discussion into a standalone Markdown objective. Prefer `--objective-file`; if a diagram materially clarifies workflow/state/architecture/dependencies, put Mermaid first. The objective must be sufficient for a fresh orchestrator/agent to complete the Job without access to the original conversation. Creating the Job is the context-compaction boundary: important decisions must be copied into durable Job context before work is delegated.

This contract defines orchestrator-owned exception workflows that sit above normal Agents Relay task/job execution.

## P0 / self job workflow

A **P0 job** (alias: **self job**) is executed directly by the current active orchestrator thread:

1. The orchestrator creates the durable job.
2. The orchestrator immediately creates the required orchestrator-owned task(s); do not leave the P0 job idle.
3. The current orchestrator thread starts executing those tasks immediately rather than delegating them to another worker. Creating an `adapter: orchestrator` Task is never a handoff: the exact creator owns it for this turn.
4. The orchestrator must terminalize every orchestrator-owned Task it created before ending the turn. It must not return to the user with one of its self-tasks left `QUEUED` or `RUNNING`; successful work uses `task complete` on that same durable Task.
5. P0/self jobs do not require the normal reviewer gate unless the user explicitly asks for review.
6. After implementation and local verification, the orchestrator merges the job itself and completes normal post-merge reconciliation.

`job create` still only creates durable job state; the P0 workflow requires the orchestrator to follow it immediately with task creation and execution.
