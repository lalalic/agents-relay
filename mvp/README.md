# Relay MVP — quick smoke validation kit

**Invocation in a new ChatGPT/Neo thread:** `run relay mvp`.

This directory is the **single source of truth** for the quick MVP. It is intentionally a *minimum path*, not a complete regression suite. The phrase is a ChatGPT request, **not a shell command**.

## Default quick MVP: 10 checks

| Phase | Driver | Minimum PASS path | Checks |
| --- | --- | --- | --- |
| Relay CLI | Node.js → native Rust `agents-relay` CLI + isolated test daemon | create/show/list Job → execute real Script A→B→C → terminal CLI readback | 3 |
| Dashboard | `dashboard-mvp-agent` using WebHelm Chrome | Jobs → one Task/Activity → JEL | 3 |
| Neo Mobile | `neo-mobile-mvp-agent` using iPhoneHelm on physical iPhone | Jobs → Activities → SSE auto update → Chat `hello` response bubble | 4 |
| **Total** | | | **10** |

CLI `--full` retains the earlier **12 CLI-only checks** as an *optional extended suite*, not part of the default `run relay mvp` pass criteria. Other features (Dashboard responsive/live updates; Mobile Review/cancel/etc.) are outside the minimum scope.

## Instructions for the next autonomous ChatGPT thread

1. After the usual single Neo bootstrap, read this file, `mvp/SKILL.md`, the two checklists, and the two named Agent definitions. Discover current WebHelm/iPhoneHelm skills and authoritative CLI help. Do not repeat the bootstrap. No additional questions when enough information is available.
2. Preflight: find native CLI and daemon binaries, confirm an isolated test store/port, authenticated Dashboard URL/build and authorized iPhone/Runner. Do not change live Relay settings, production Jobs, user Chrome tabs or others' phone Sessions.
3. **CLI smoke:** execute `node mvp/cli-mvp-e2e.mjs --keep` from repository root. Only `01 Create-only Job`, `05 Real Script A→B→C` and `08 Job COMPLETED Readback` execute by default; `01` also verifies list/readback. Save the printed evidence directory, JSON report, CLI transcript and daemon log. Never import Relay internals or write SQLite. If running extended checks was *explicitly* requested, use `--full` instead.
4. **Dashboard smoke:** follow `mvp/agents/dashboard-mvp-agent.agent.md` and `mvp/checklists/dashboard-webhelm.md`. Use a real test-owned Job **visible to the targeted Dashboard**; the isolated CLI suite's temporary store is not automatically visible there. Use WebHelm for D01–D03; capture real browser evidence. No responsive or live update tests.
5. **Mobile smoke:** follow `mvp/agents/neo-mobile-mvp-agent.agent.md` and `mvp/checklists/neo-mobile-iphonehelm.md`. Use a real test-owned Job reachable by the phone, and a genuine CLI-driven state transition for SSE. Observe M01–M04 via iPhoneHelm on the paired physical device. Verify the actual `hello` assistant bubble; never infer from APNs alone.
6. Record 10 results in `mvp/runs/<timestamp>/results.json` with concise `summary.md`: each `PASS | FAIL | BLOCKED | NOT_RUN`, fixture identity, build, actual UI/CLI proof, first failure and cleanup. `OVERALL PASS` requires **10/10** observed. Missing dependency = `BLOCKED`; observed missing feature = `FAIL`. Continue independent safe phases when practical.
7. Clean up only the resources you own. The MVP request is **testing only**: do not silently fix code, rebuild, merge, deploy, upgrade or run a broad regression; report the blocker and minimal next action.

## Evidence integrity

- CLI controls and assertions must use public CLI commands; Git/filesystem may verify actual artifacts. No Relay internal imports, direct HTTP/SQLite or fabricated events.
- Browser and phone require real, visible interactions through their Helm tools. Do not mark PASS on an HTTP 200, a notification, a successful installation or screenshot from an unrelated session.
- No external user data or credentials in evidence. `mvp/runs/` is ignored by Git.

**Definitions only: do not run tests unless the user explicitly says `run relay mvp`.**
