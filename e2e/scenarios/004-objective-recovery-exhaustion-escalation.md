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
