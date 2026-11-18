# Rust2 Head-to-Head parity milestone — 2026-11-17

## Reproducible baseline

- Verified `rust2` source baseline: `f71d53c` (`docs(rust2): refresh verified PORTING API coverage matrix`), with the PWA Dashboard, native Dashboard API, and serial Rust migration merged.
- Differential suites: **177 passed / 0 failed**, Node/Rust, exit code 0; deterministic and isolated Node/Rust fixtures.
- Native Rust `cargo test --all-targets -- --test-threads=1`: **345 passed / 0 failed**, exit code 0.
- Node `npm run test:full`: **1,220 passed / 0 failed** on the main suite; L3: **90 passed / 1 skipped / 0 failed**; exit code 0.
- Verification: L1 58/58, L2 11 pass / 1 skip, Cross-A 10/10. Source and audit check 5/5.
- HEAD migration ledger: **117 PASS, 107 PORTING, 0 PENDING, 4 EXCLUDED** (228 total). All 224 in-scope Node source files have Rust files; file existence alone is not full behavioral equivalence.
- Static API inventory: 734 runtime export symbols; 595 direct Rust symbol-name candidates, **122 unmatched names**, 17 constructor reviews, 286 type/shape reviews. Matching names do not establish API parity. Details in `docs/RUST2_API_PARITY_MATRIX.json` and `docs/RUST2_API_PARITY_AUDIT.md`.

## Milestone boundaries

This milestone records a tested **subset**, not complete API parity or live production cutover. Missing/renamed exports, runtime wiring and unverified negative/recovery behavior remain `PORTING` until independently verified. SQLite is the only lifecycle authority; Graph owns workflow policy, EventBus observations never prove completion. Do not mark all `PORTING` rows PASS from a successful aggregate test alone.

No production restart, deploy or remote push was performed. Subsequent changes should add differential evidence and rerun regressions before upgrading module status.
