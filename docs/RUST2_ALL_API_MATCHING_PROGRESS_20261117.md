# Rust2 all-API matching — autonomous progress checkpoint

## Scope and baseline

User objective: continue autonomously until **every Node public runtime export is matched by a correct Rust implementation and tested**. Do not game the static audit by adding no-op names, unjustified reexports or stub functions. Node TypeScript source is authoritative. Rust is isolated in a dedicated worktree; no production cutover, remote push, live restart, managed Relay Job, Codex CLI, or additional worker ownership.

Root `/Users/chengli/Workspace/agents-relay` branch `rust2` is unchanged at `66ae671`. Original tag `rust2-head-to-head-milestone-20261117` points to `5ed23b1`. This task worktree is `/Users/chengli/Workspace/.worktrees/orchestrator/rust2-all-apis-20261117` on `hotfix/rust2-all-apis-20261117`. The baseline static report listed **98 unmatched runtime names** in 45 files (734 runtime exports, 107 PORTING modules).

## Completed implementation commits in isolated worktree

1. `7387ae9` native public facade ports: SQLite Store/Browser Pool owned close, Watchdog, OwnedProcess termination reason, scoped LocalManagedStore, Planner Context, WorkerAdapter identities (Z/Script/typed timeout), WebHelm readiness preflight, browser-worker pool singleton, public Worker/Model/Execution routing delegations. The route façade drops the internal-only facts/workerRequirements/routing top-level fields; no unverified audit receipt is fabricated.
2. `9d0957e` scoped `createJobIdRegistryResolver`, public Planner TaskSpec and Command/Agent Planner adapter entrypoints, Planner prompt construction delegated to native shared builder. Command planner uses injected owned runner. Agent Planner has not been independently compared end-to-end with Node's live provider/role resolver.

**Current static audit: 98 → 74 unmatched names, 30 files.** These are name correspondence candidates, not a complete per-API behavioral guarantee. All 107 PORTING source modules remain PORTING until their whole contract, wiring, negative/recovery tests, and durable effects have passed.

Focused evidence: `rust/tests/head_to_head_webhelm_preflight.mjs` verifies 49 real Node owned-process calls; `head_to_head_route_facades.mjs` verifies 105 deterministic Node/Rust Worker/Model/Execution route fixtures (normalizing unstable audit IDs/timestamps); `head_to_head_planner_public_ports.mjs` verifies 152 public Planner cases using harmless disposable shell scripts only. `rust/tests/native_port_api_facades.rs`: 12/12 native tests, including unified SQLite Job ID scope and Planner Agent fail-before-launch. Audit test+source-size: 6/6; `cargo check --all-targets`, `npm run build` and `rust2-checklist-verify` passed during these tranches. **No full `cargo test --all-targets`, `npm run test:full`, or all 178+ Head-to-Head suites have been run since the modifications. They are mandatory before merging.**

## Architecture and continuing work

- Graph `workflow/*.mmd` owns decisions. Rust API actions use existing Graph/SQLite effects; never invent a second lifecycle state machine. SQLite alone is durable operational truth; EventBus is observation/wake. Do not mistake HTTP/browser/process receipts for Task completion. Existing test directories must isolate `AGENTS_RELAY_STORE_DIR`; no production stores. No Codex CLI executions.
- Address remaining API names by auditing each Node method's actual signature/behavior, porting into appropriate Rust module/traits (new SRP module for large existing Rust files), adding both direct Node/Rust negative/positive tests and native SQLite/Graph tests, and rerunning matrix. Focus `task-actions`, Planner Runtime, Reconciler, CLI/Daemon, cross-Job Blocker persistence, optional GitHub GraphQL/adapters, usage app-server reader and external routing.
- Do not label 0 unmatched unless the generator truly verifies all and full runtime tests support the claim. Static direct-name match does NOT certify semantics. Preserve ability to report known coverage limits.
- When source implementation is committed, regenerate `node scripts/rust2-api-parity-audit.mjs --write --check --json` so source/Rust tree hashes match `HEAD:src`/`HEAD:rust/src`. Commit report separately from source. Update this checkpoint with evidence.
- Run full Rust Native (`cd rust && cargo test --all-targets -- --test-threads=1`), Node (`npm run test:full`, L3), full Node/Rust (`node --test --test-concurrency=1 rust/tests/head_to_head*.mjs`), L1/L2/Cross-A, npm build/pack, checklists and audits. Use real exit codes. Merge only FF into clean `rust2` after approval conditions/evidence, preserve PWA and original milestone tag, cleanup worktree only when fully done.
