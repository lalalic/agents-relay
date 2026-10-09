# E2E-001 — Happy path / bootstrap

Purpose: prove a normal Job can finish without lifecycle intervention after bootstrap.

Bootstrap: one `job create --initial-plan` on a fresh local source branch.

Expected: Plan succeeds → implementation worker succeeds → authoritative terminal event → independent immutable-head review succeeds → local merge succeeds → Job `COMPLETED`.

Forbidden after bootstrap: manual plan, retry, reconcile, unblock, review, merge, or state mutation.
