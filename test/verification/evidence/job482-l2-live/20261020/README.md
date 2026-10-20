# Job482 contradictory MCP evidence — live L2

Run date: 2026-10-20 (America/Toronto). Both runs used the explicit `RELAY_L2_LIVE=1` installed-Codex path, random isolated Job/Task/Execution identities, temporary private work directories, and isolated SQLite stores. Neither run touched Job 481, Job 482, the production store, NATS, or a user thread.

## Reviewer

- Scenario: `contradictory-mcp`; report: [`reviewer.json`](./reviewer.json).
- Outcome: **PASS**. The live Reviewer returned `changes-required` with immutable head `job482-contradictory-mcp`.
- Production Relay ingress replay persisted the Reviewer Task as `SUCCEEDED` and Review outcome as `changes_required`.
- Artifacts: prompt, unedited MCP event stream, and ingress SQLite under [`reviewer-fixture/`](./reviewer-fixture).

## Troubleshooter and escalation loop

- Scenario: `contradictory-mcp`; report: [`troubleshooter.json`](./troubleshooter.json).
- Outcome: **PASS**. The live Troubleshooter identified the stale `connected=true`/`permissions=true` claim against authoritative `connected=false`/`permissions=false`, selected `escalation_gate`, and did not claim recovery.
- The model-selected recommendation was replayed through production Graph/SQLite mutations: one new escalation, an identical duplicate returning the same ID, SQLite restart replay, authorized human response, and graph-owned exact-original recovery. Original and recovery Tasks were `QUEUED` with cleared execution identities; this evidence does not assert a new worker PASS.
- Durable escalation ID: `6890cfde-162c-4624-afa7-490612812ae0`. Original and recovery Tasks each retained two typed append-only comments.
- Artifacts: prompt, unedited MCP event stream, Relay SQLite, escalation SQLite under [`troubleshooter-fixture/`](./troubleshooter-fixture).

The harness also has a non-live regression for this full loop in `test/verification/l2/job482-escalation.test.mjs`.
