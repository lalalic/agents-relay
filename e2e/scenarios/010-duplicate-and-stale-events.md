# E2E-010 — Duplicate wake/webhook and stale execution event

Inject duplicate wake/synchronize signals and a delayed terminal event from an older execution.

Expected: exactly one authoritative transition for the current attempt; stale execution events are ignored; no concurrent duplicate start.
