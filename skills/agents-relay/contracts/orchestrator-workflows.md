# Agents Relay Orchestrator Workflows

This contract defines orchestrator-owned exception workflows that sit above normal Agents Relay task/job execution.

## Hotfix workflow

A hotfix is a fast path for a live blocking problem:

1. The current active orchestrator thread patches the live/runtime target directly.
2. It immediately reproduces the failure and verifies the fix against the live runtime.
3. Once verified, the same logical fix is applied to canonical `main`, tested, committed, and pushed.
4. The orchestrator completes the normal post-merge/publish reconciliation and cleanup.

Do not create a blocking job/PR before fixing the live runtime. Keep the hotfix minimal and do not leave the live patch as the only durable implementation.
