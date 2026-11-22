# Dashboard MVP — 3 fast WebHelm smoke checks

**Agent:** `dashboard-mvp-agent` (`mvp/agents/dashboard-mvp-agent.agent.md`)
**Status (2026-11-22): `PASS 3/3` on actual managed Google Chrome using WebHelm Session against native Rust `http://127.0.0.1:8787/`.** D01: Job 705 visible and `COMPLETED`; D02: selected Task 2192 `SUCCEEDED`, real activity `task.started`, `task.progress`, `task.completed` present; D03: JEL dialog rendered Graph tasks 2190/2191/2192/2197 and `l3-c01-middle`, then `#graph-dialog-close` closed it (`open:false`, `display:none`). WebHelm Sessions were caller-owned and cleaned. This is the three-check MVP, not full responsive/auth/SSE browser certification.

## Preconditions (not checklist items)

- A running, authenticated Dashboard URL and build/SHA.
- A known *test-owned*, real CLI-created Job (`jobId`, repository, Task IDs, state) that has genuine Tasks and Events; prefer the simplest completed Job or A→B→C fixture. The temporary isolated CLI runner's Job is **not** accessible to a different live Dashboard unless explicitly connected; never assume it is.
- One owned WebHelm Chrome Session. Use actual UI interactions and screenshots/snapshots; release Session in `finally`. Read the installed WebHelm Skill first. Do not touch unrelated Jobs/tabs.

## Minimum acceptance checklist

- [x] **D01 — Open + Jobs:** Open the authenticated Dashboard, see **Jobs**, find the known Job with correct ID/title/status. No blank screen, stuck loading or error.
- [x] **D02 — Task + Activities:** Select that Job, open one real Task and verify its title/state, then see at least one real Task Activity/Event belonging to that Job.
- [x] **D03 — JEL:** Open **View JEL chart**, verify a visible graph containing the selected Job's Task, and close it normally.

**Pass:** D01–D03 are all actually observed in Chrome with screenshot/snapshot evidence. Store build, Job ID, actual/expected and first failure. Individual `PASS | FAIL | BLOCKED | NOT_RUN` only. Missing fixture = `BLOCKED`.

**Excluded:** responsive/mobile CSS, live updates/SSE, daemon restart/reconnection, performance, filters/search permutations, all-task coverage, keyboard/accessibility sweep, PWA installation, Router settings and production writes. Manual refresh is permitted as needed to view the fixture but is not a separate MVP gate.
