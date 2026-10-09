# E2E-009 — Async browser-worker handoff

Trigger an async browser worker submission whose transport exits before business completion.

Expected: Task remains active until the correlated authoritative terminal event; transport exit alone is not success/failure; no duplicate launches.
