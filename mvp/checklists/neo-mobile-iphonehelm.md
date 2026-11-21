# Neo Mobile MVP — 4 fast iPhoneHelm smoke checks

**Agent:** `neo-mobile-mvp-agent` (`mvp/agents/neo-mobile-mvp-agent.agent.md`)
**Status:** `NOT_RUN`. This defines **minimum validation of not-yet-implemented features**; no claimed implementation or PASS.

## Preconditions (not checklist items)

- Real paired physical iPhone 17, Neo Mobile app installed, iPhoneHelm Runner authenticated. No Simulator. One owned iPhoneHelm Session/lock; `device_busy` = `BLOCKED`, never steal another Session. Close the Session/Runner in `finally`.
- Real CLI-created test Job, with known repository, Job ID, Task ID and genuine start/terminal events; to check SSE, arrange a new real Task state change after the Jobs/Activities screen is visible. Do not write SQLite, inject synthetic events or fake a network response.
- In Chat, send `hello` only once in a test conversation; do not substitute APNs or a web thread for an assistant bubble.

## Minimum acceptance checklist

- [ ] **M01 — Jobs:** Open **Jobs** on the real iPhone; the CLI-created Job appears with the correct ID/title/state. Tap it successfully.
- [ ] **M02 — Activities:** In the selected Job, see genuine Task Activities containing a known Task's start and terminal event; event identities match the Job and Task.
- [ ] **M03 — SSE live update:** While viewing Jobs/Activities **without manual refresh**, trigger a real external CLI-owned Task transition and observe the updated status/activity on the phone automatically via SSE. A push notification, polling-only refresh or API status is not PASS.
- [ ] **M04 — Chat `hello`:** Open **Chat**, send `hello` once, and verify both the outgoing user bubble and the correlated assistant reply bubble in the same iPhone conversation. APNs-only or reply visible only on the web is FAIL.

**Pass:** M01–M04 all demonstrated on the physical iPhone with screenshots/snapshots and app build, fixture IDs and observed result. Individual `PASS | FAIL | BLOCKED | NOT_RUN`. A missing feature reached on a working device = `FAIL`, an unavailable device/fixture = `BLOCKED`.

**Excluded:** Review, cancel, Task editing, pagination, deep navigation, layout polish, complex chat flows, notifications and reconnection regression. This is a quick MVP, not complete Neo Mobile QA.
