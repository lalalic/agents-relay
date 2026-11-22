# Neo Mobile MVP — 4 fast iPhoneHelm smoke checks

**Agent:** `neo-mobile-mvp-agent` (`mvp/agents/neo-mobile-mvp-agent.agent.md`)
**Status (2026-11-22): `PASS 4/4` on physical iPhone 17 using authenticated iPhoneHelm and live Rust Relay (no Simulator).** Evidence: real UI snapshots of Jobs 705/706; selected Job 705 Task 2192 activities including real started/progress/completed; new CLI-created Job 707 in the Jobs screen changed `Idle → Queued` without manual refresh while the authentic native Rust Script ran; one `hello` entered/sent in Neo Mobile yielded a new user bubble and a new `Hello. How can I help?` assistant bubble. Test Job 707 was cancelled after evidence; Task 2199 had genuinely succeeded. iPhoneHelm Sessions were closed by the CLI. This is the four-check MVP only, not real-human Review/Cancel QA.

## Preconditions (not checklist items)

- Real paired physical iPhone 17, Neo Mobile app installed, iPhoneHelm Runner authenticated. No Simulator. One owned iPhoneHelm Session/lock; `device_busy` = `BLOCKED`, never steal another Session. Close the Session/Runner in `finally`.
- Real CLI-created test Job, with known repository, Job ID, Task ID and genuine start/terminal events; to check SSE, arrange a new real Task state change after the Jobs/Activities screen is visible. Do not write SQLite, inject synthetic events or fake a network response.
- In Chat, send `hello` only once in a test conversation; do not substitute APNs or a web thread for an assistant bubble.

## Minimum acceptance checklist

- [x] **M01 — Jobs:** Open **Jobs** on the real iPhone; the CLI-created Job appears with the correct ID/title/state. Tap it successfully.
- [x] **M02 — Activities:** In the selected Job, see genuine Task Activities containing a known Task's start and terminal event; event identities match the Job and Task.
- [x] **M03 — SSE live update:** While viewing Jobs/Activities **without manual refresh**, trigger a real external CLI-owned Task transition and observe the updated status/activity on the phone automatically via SSE. A push notification, polling-only refresh or API status is not PASS.
- [x] **M04 — Chat `hello`:** Open **Chat**, send `hello` once, and verify both the outgoing user bubble and the correlated assistant reply bubble in the same iPhone conversation. APNs-only or reply visible only on the web is FAIL.

**Pass:** M01–M04 all demonstrated on the physical iPhone with screenshots/snapshots and app build, fixture IDs and observed result. Individual `PASS | FAIL | BLOCKED | NOT_RUN`. A missing feature reached on a working device = `FAIL`, an unavailable device/fixture = `BLOCKED`.

**Excluded:** Review, cancel, Task editing, pagination, deep navigation, layout polish, complex chat flows, notifications and reconnection regression. This is a quick MVP, not complete Neo Mobile QA.
