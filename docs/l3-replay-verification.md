# L3 production-ingress replay: evidence and limitations

Run from the repository root after building:

```sh
npm run test:verification:l3
node test/verification/l3-replay.mjs test/verification/l3-scenarios/stale-duplicate.json /tmp/relay-l3-stale
node test/verification/l3-replay.mjs test/verification/l3-scenarios/broken-premature-completion.json /tmp/relay-l3-negative
```

Each replay creates a disposable `AGENTS_RELAY_STORE_DIR`, dispatches canonical
messages through `MemoryEventBus` into the production `Reconciler`, and reads
actual state from an isolated SQLite `SQLiteRelayStore`. `report.json` and
`report.md` retain ordered before/after task transitions; the CLI returns a
nonzero status on a failed assertion. An expected negative scenario must fail.
The test command compiles production runtime code and is part of `npm test`.

The simulated agent provider and Git operations do not contact external
services. Events are delivered through the production event handler using an
in-memory bus, **not** a live NATS transport. Task execution starts in a
seeded running generation. The no-adapter reconciler exercises ingress,
SQLite persistence and dependency release but not a full provider dispatch.
`job.merge.*` steps in this replay are *direct mock receipts* persisted in
SQLite; they are not production merge effects or event-bus merge receipts.
Do not cite these steps as proof that merge retries or reason receipt work.

Known gaps before claiming complete L3: real scheduler-launched workers,
reviewer changes/revision/re-review, reviewer completion stall, troubleshooter
escalation and authenticated unblock, merge failure with durable reason and
retry through the actual effect, and full autonomous planner completion gates.
A successful suite is evidence for tested edges only, not complete Job 481.

The root cause for the prior review failure is missing scheduler-driven
end-to-end lifecycle evidence. The fixture and SQLite-based assertions repair
part of that gap without modifying production daemon or workflow policy.
