# Rust EventBus durability and production restart — 2026-11-22

## Scope

Production Neo Master runs a single PM2 agents-relay/daemon native Rust binary on 127.0.0.1:8787. SQLite is the canonical Job/Task/Review/Lease state. Actual production-positive evidence was read from ProjectRunner Jobs 713 and 715. Negative/adversarial regression tests use their own temporary native daemon, NATS broker and SQLite, not the production Broker or user Jobs. No malicious events were injected into live user Jobs.

## E1 — scoped PASS

- Job713 Builder2219 genuinely FAILED, later retried the same Task and SUCCEEDED. Job715 Reviewer2230 genuinely SUCCEEDED and all its terminal execution/lease fields were cleared.
- Job715 Reviewer activity history contains two same-execution source task.completed observations, but the durable workflow_event_outbox has exactly ONE corresponding published terminal key, no duplicate Graph completion. Workflow outbox: 313 committed rows, 313 unique keys, 313 published, zero pending, SQLite quick_check=ok.
- The legacy event_receipt table is empty; do NOT misrepresent it as the native Model EventBus receipt store. Authoritative Graph/SQLite Task state and committed workflow_event_outbox provide actual live evidence.
- Seven native Rust regression binaries: 38 PASS / 0 FAIL:
  - native_real_nats_transport 6/6: authenticated test Broker, wrong-token and insecure-secret rejection, cross-Job subject/body binding, actual native daemon ingress and reconnection/re-authenticate after Broker restart, no resend of PUB.
  - native_sqlite_write_host 18/18: exact SQLite CAS, reject Model premature finish before started, fake Task/Source, duplicate start, changed-payload same-event-ID collision, duplicate terminal, verified single start/progress/finish outbox and single audit.
  - native_durable_transition_sqlite 2/2; native_graph_outbox_batch 4/4; native_host_review_ingress 1/1; native_review_generation_fence 4/4; native_projectrunner_final_review_leases 3/3.
- Production positive snapshots, actual Task activity, exact source ID comparison, durable outbox audit and complete test log: mvp/runs/20261122T1308-gate-e1-production/.

E1 scoped PASS does NOT mean a forged event was deliberately published into production NATS. Real production Broker disruption/transport security remains Gate E3.

## E2 — terminal/restart subcase PASS; full E2 OPEN

- Read-only preflight showed zero active current-owner RUNNING Model Workers, zero Codex OS processes, zero pending outbox. Three unrelated historic retired Node owner leases were untouched.
- Made WAL-consistent, quick_check=ok backup at ~/.agents-relay/backups/rust2-20261122-e2-postterminal-restart.sqlite with all 505 Jobs.
- Restarted the sole PM2 Rust daemon. The native daemon returned HTTP 200 on /api/status, /api/jobs and /. Exact production Job713 and Job715 complete JSON snapshots were byte-identical by SHA-256 before vs after, including historical Job713 Reviewer terminal metadata (no unsafe edit). Total 505 Jobs and all 313 published outbox rows unchanged, with zero pending or duplicate replay.
- Real Neo ProjectRunner command to reopen the exact Job715 private Run after restart returned Job715 COMPLETED and reused:true, creating no new Job or outbox row.
- One first test-script comparator incorrectly compared JSON-loaded lists to Python tuples. This yielded a false assertion before any Relay state changed. Backup-vs-live SQLite raw snapshots proved there was NO diff, the comparator was corrected, and both complete stored Job JSON SHA-256 were verified identical. This is NOT a Relay regression.

Still OPEN: interrupt a controlled test-owned RUNNING, QUEUED and interactive human-review-wait native Task and prove exact fencing/restart behavior. These are not implied by the terminal case. Full production Broker interruption, multi-Node fencing and rollback are also separate gates.

Evidence: mvp/runs/20261122T1308-gate-e1-production/before-native-restart.json and after-native-restart.json, full Job/Task event snapshots, original WAL backup and native regression log.
