# Verification strategy

Use disposable `AGENTS_RELAY_STORE_DIR` for tests and child CLIs. Never target production Jobs. Run focused native Cargo tests in `rust/` for the affected behavior, then the repository CI/release gates as applicable; inspect `.github/workflows/rust.yml` and `rust/tests/` for current coverage.

| Layer | Evidence |
| --- | --- |
| L1 | graph branches, registered symbols, guards/actions and negative paths |
| L2 | role/provider contract and actual execution evidence |
| L3 | deterministic ingress, persistence, SQLite restart/reconciliation, dedupe and no false completion |
| L4 | actual Prompt/Harness assembly, role context and declared Skill selection |

Dashboard UI/HTTP/SSE/runtime status/publication changes require `scripts/test-dashboard-browser.sh` with real Chrome and isolated native fixtures. Use the native MVP Skill for production smoke acceptance only when authorized. Provider/browser/device gates are NOT_RUN if not executed; isolated tests do not certify live deployment. Mandatory pre-release gates cannot be deferred. Live-only checks require an explicit post-release acceptance handoff.

Use `node scripts/release-native.mjs` only for an authorized reviewed release. See [service](service.md) and root README for the verified native release procedure.
