# Rust Relay native backend — staged acceptance

The production authority remains the ordinary Agents Relay SQLite Store and
canonical `workflow/*.mmd` Graphs. This native implementation is a **single-node,
explicitly isolated pilot**, not a replacement for the installed Node.js daemon.

## Currently demonstrated

- A Rust-native daemon starts a durable DAG Coordinator, materializes ready
  Script/Model Agent Tasks atomically, runs real supervised OS Workers, forwards
  verified predecessor output, and completes the Coordinator only after all
  children succeed. A Coordinator is not incorrectly counted as a physical
  Worker execution slot.
- Script and Model Workers receive immutable execution-bound input in a private
  request file. Model routing must be explicit and match the trusted adapter.
- Approved human Review resumes the **same Task** only after the host decision
  is accepted in the durable Review ledger; a forged `approved` Task field is
  rejected before Worker claim. `changes_requested` does not auto-approve,
  auto-revise or bypass Preview.
- Live production Task input and output paths, host credentials, and the normal
  user SQLite authority are inaccessible to the staged daemon by design.

Run `npm run test:rust` for Rust tests, the Graph/Store parity checks, real
worker processes, isolated DAG execution, Review gate and recovery E2E.
`npm run test:l3:dag` verifies the existing TypeScript DAG lifecycle.

## Before replacing the production service

The Rust daemon still needs the **real host interactive Review request and
semantic `changes_requested` re-preview path**, normal Model Router/runtime
provider integration, fully equivalent recovery and Troubleshooter, Final
Review/JEL completion/Merge, operational event delivery, and an authorized
production rollout/rollback mechanism. It currently serializes physical Workers
within a Job; concurrent fork/join production parity remains to be proven.

Do **not** point this isolated daemon at `~/.agents-relay/stores`, stop the
Node.js daemon, or treat synthetic Review test receipts as real Neo Mobile
approval. The actual Vlog Job must continue on its existing service until
those production gates are independently passed.
