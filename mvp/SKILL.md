---
name: relay-mvp
description: For "run relay mvp", execute the one-folder minimum 10-check smoke acceptance kit (native Relay CLI, Dashboard WebHelm, Neo Mobile iPhoneHelm). The 12-check CLI extended suite is opt-in only.
---

# Relay MVP — quick invocation

The canonical kit is this directory. Read `README.md`, both `checklists/*.md`, and both `agents/*.agent.md` before execution. The user saying `run relay mvp` means the **minimum** 3 CLI + 3 Dashboard + 4 Neo Mobile checks, not a full regression. Only explicit `--full`/"extended" request expands the CLI checks.

Dashboard excludes responsive and live/SSE; Mobile specifically tests Jobs, Activities, SSE and Chat `hello`. All PASS claims require genuine command/UI evidence; report missing functionality as FAIL, prerequisites as BLOCKED. This skill and files are inert for definition requests.
