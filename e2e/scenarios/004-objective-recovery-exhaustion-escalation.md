# E2E-004 — Troubleshooter failure and autonomous recovery to completion

## Objective

An intentional implementation failure creates the first Troubleshooter. Its first attempt is deliberately failed. Relay MUST retry/reroute that SAME recovery Task within a bounded retry budget, recover the exact original implementation Task, and ultimately reach Job `COMPLETED`, after review, local merge, and enabled GitHub PR projection. No human intervention is permitted.

## PASS

- original implementation Task eventually `SUCCEEDED` on attempt 2 or later
- exactly one Troubleshooter Task, `SUCCEEDED` on attempt 2 or later; no recursive Troubleshooter
- no recovery budget exhaustion, no human escalation
- review `approved` when enabled and local Git merge `succeeded`
- Job `COMPLETED` (not merely `ACTIVE/FAILED`)
- projected external PR is `MERGED` when GitHub is enabled

## FAIL

- failed Troubleshooter remains terminal without automatic recovery
- recovery budget exhausted for this injected recoverable failure
- a second recursive Troubleshooter is created
- original Task is replaced rather than recovered
- Job stays `ACTIVE/FAILED` or completes without review/local merge
- GitHub projection remains unmerged past bounded convergence window

<!-- PLANNER-CONTRACT:START -->
## Mandatory Planner contract

Create the original implementation Task with the first-failure guard. Allow the normal Troubleshooter and retry path. Do not set `--test-injection`: the scripted original/Troubleshooter failure protocol defines this scenario.

The Planner must encode this in the **structured `next_tasks` response**. The worker must not create its own replacement Task or manufacture failure events. The E2E controller judges only runtime evidence.
<!-- PLANNER-CONTRACT:END -->
