# Agents Relay Orchestrator Workflows

## Job context capture

Before `job create`, the orchestrator converts the relevant discussion into a standalone Markdown objective. Prefer `--objective-file`; if a diagram materially clarifies workflow/state/architecture/dependencies, put Mermaid first. The objective must be sufficient for a fresh orchestrator/agent to complete the Job without access to the original conversation. Creating the Job is the context-compaction boundary: important decisions must be copied into durable Job context before work is delegated.

This contract defines orchestrator-owned exception workflows that sit above normal Agents Relay task/job execution.

## Hotfix workflow

A hotfix is a fast path for a live blocking problem:

1. The current active orchestrator thread patches the live/runtime target directly.
2. It immediately reproduces the failure and verifies the fix against the live runtime.
3. Once verified, the same logical fix is applied to canonical `main`, tested, committed, and pushed.
4. The orchestrator completes the normal post-merge/publish reconciliation and cleanup.

Do not create a blocking job/PR before fixing the live runtime. Keep the hotfix minimal and do not leave the live patch as the only durable implementation.

## P0 / self job workflow

A **P0 job** (alias: **self job**) is executed directly by the current active orchestrator thread:

1. The orchestrator creates the durable job.
2. The orchestrator immediately creates the required orchestrator-owned task(s); do not leave the P0 job idle.
3. The current orchestrator thread starts executing those tasks immediately rather than delegating them to another worker.
4. P0/self jobs do not require the normal reviewer gate unless the user explicitly asks for review.
5. After implementation and local verification, the orchestrator merges the job itself and completes normal post-merge reconciliation.

`job create` still only creates durable job state; the P0 workflow requires the orchestrator to follow it immediately with task creation and execution.
