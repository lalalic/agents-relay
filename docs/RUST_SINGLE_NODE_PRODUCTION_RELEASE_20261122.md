# Native Rust Relay — approved single-node production release

**Decision date:** November 22, 2026.

**Release status:** APPROVED / PRODUCTION-READY for the EXISTING single-node Neo Master deployment with Rust as the ONLY writable Relay owner. The user explicitly accepted this deployed configuration as product-ready. This does not imply certified multi-node high availability, automatic failover, rollback, or full systemwide Gate G acceptance.

## Accepted production profile

- One online PM2 process named agents-relay/daemon, running the native Rust agents-relayd-rust binary on localhost port 8787. Node.js relayd is retired from the live owner path and must not run as a concurrent writer.
- SQLite WAL remains the sole authoritative Job, Task, Plan, Review, Execution, Lease and Recovery state. Canonical Graphs choose lifecycle transitions; NATS/EventBus is authenticated transport and wake/observation, never an alternative lifecycle database.
- Neo Master is the accepted site. No unverified three-node owner takeover on home98 or Worknode is asserted.
- Untracked Neo test-only Git projects and mvp/runs proof files are retained rather than silently deleted as disposable artifacts.

## Release acceptance evidence

- ProjectRunner: four MVPs all PASS and eight of eight scoped ProjectRunner requirements PASS. Real completed Jobs 683, 685, 692 and 693; real Calculator recovery Job 713 with independent Chrome QA and approved Reviewer; clean post-fix Job 715 with five of five successful Tasks and all terminal execution/lease fields null.
- Real iPhone/Neo Mobile: Jobs, Activities, SSE, chat reply MVP four of four PASS. Real human review Request Changes and Approve plus Codex correction were exercised using test-only Jobs against the live Rust Relay.
- Running-owner restart: real ProjectRunner Job 717 interrupted a RUNNING Script with a guarded daemon restart after a WAL-consistent backup, terminated the old owned process, recovered via genuine Codex Troubleshooter, retried the SAME durable Task with a NEW execution, completed the three-node source-owned A to B to C DAG and reached COMPLETED after independent Final Reviewer approved. All six Tasks succeeded, no stale live leases.
- EventBus: the first Planner event legitimately blocked 15 later Outbox publications. Rust fix 84a7d18 passed adversarial validation and true NATS FIFO tests. After a production WAL backup and sole-owner restart, the 15 original immutable event IDs published; 335 unique Outbox rows, all published, zero pending, no Job 717 snapshot change, SQLite quick_check=ok.
- Native Rust tests: 112 of 112 library tests PASS serialized, 24 of 24 SQLite/real NATS tests PASS; 51 additional recovery/ownership/Graph/Dashboard safety tests PASS; native E1 authenticated transport and SQLite adversarial batch 38 of 38 PASS.

Detailed evidence: docs/RUST2_PROJECTRUNNER_PROD_20261122.md, docs/RUST2_GATE_E1_E2_PRODUCTION_20261122.md, and docs/RUST2_FULL_E2E_CHECKLIST.md. Historical evidence is preserved locally in ignored mvp/runs audit folders; unverified claims are not promoted to passes.

## Explicit limitations and operating policy

- Production-ready is scoped to the already-validated **single-node** profile. Pending work includes a full QUEUED and interactive-review-wait restart matrix, production Broker outage scenarios, multi-node ownership/fencing, rollback drill, comprehensive Browser Worker Gate C and other broader global Gates. These are normal hardening items, NOT reason to restart Node as a parallel producer.
- The generic HTTP productionReady=false status means complete Gate G readiness is still unsigned. It is not a single-node release-approval bit; do not globally flip it true for an arbitrary deployment.
- Pre-patch Job 713 Reviewer contains a historical stale terminal lease marker; this is not an active worker. Duplicate history observations bearing the same event ID can occur across NATS replay, although the committed Graph and Outbox do not complete a Task twice. Preserve and resolve as separate maintenance work.
- Keep exactly one Rust writer. Monitor PM2 ownership, API health, SQLite integrity, pending Outbox and new Reviewer terminal leases. Take an online SQLite WAL-consistent backup before future daemon changes. Node rollback must be a separately authorized, fenced operation, NOT automatic concurrent restart.

**Release disposition:** Native Rust remains live; Node relayd remains retired. Single-node production accepted, full multi-node/rollback certification remains open.
