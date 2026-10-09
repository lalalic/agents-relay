# E2E-008 — Async browser-worker transport handoff

## Objective

Run an async browser worker whose submission transport exits before business completion.

## PASS

- transport exit alone is neither Task success nor failure
- Task remains active until a correlated authoritative terminal event
- no duplicate worker launch while the async execution is live
- final terminal event controls durable outcome
