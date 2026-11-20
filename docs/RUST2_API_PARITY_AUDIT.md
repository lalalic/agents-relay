# Rust2 PORTING API surface audit

> Generated with `node scripts/rust2-api-parity-audit.mjs --write`. Static candidate checks only: **do not upgrade a ledger row to PASS using this report alone**.

## Interpretation

This audit reads actual TypeScript exports, including exported class methods, and identifies plausible Rust declaration names. Missing names need investigation: Rust may implement them via a differently named method or adapter, so a missing direct match is **not** proof that an API is absent. Matched names are also not proof of matching signatures, effects or semantics.

The exported class properties and interface/type aliases need additional structural or semantic review even when a name looks similar. This is not signature checking.

A listed direct differential import only means a head-to-head test imports the compiled Node module; it does **not** show that every symbol or edge case is covered. A Rust module reference does **not** establish actual production wiring.

## Snapshot

| Metric | Count |
|---|---:|
| sourceCount | 12 |
| pendingSourceModules | 0 |
| pendingRuntimeExportSymbols | 0 |
| runtimeExportSymbols | 112 |
| directNameMatches | 108 |
| unmappedRuntimeSymbols | 0 |
| runtimeConstructorReviews | 4 |
| typeOrShapeReviewSymbols | 71 |
| filesWithUnmappedRuntime | 0 |
| filesWithoutDirectDiffImport | 2 |
| filesWithoutOtherRustReferences | 0 |

Source tree: `3eb0afe0968e`; Rust source tree: `6c0a8379cc2e`. Rust module rows in scope: 12. Full symbol details: [RUST2_API_PARITY_MATRIX.json](RUST2_API_PARITY_MATRIX.json).

## Pending source modules (not included in PORTING name-match counts)


## Per-file candidate surface (all 12 PORTING files)

| Node source | Runtime exports | Named Rust candidates | Unmapped runtime names | Direct diff imports | Other Rust refs |
|---|---:|---:|---:|---:|---:|
| `src/browser-worker-runtime.ts` | 2 | 2 | 0 | 1 | 2 |
| `src/cli-artifact.ts` | 2 | 2 | 0 | 4 | 1 |
| `src/cli-coordinator.ts` | 1 | 1 | 0 | 1 | 3 |
| `src/cli-foreground.ts` | 2 | 2 | 0 | 1 | 1 |
| `src/cli.ts` | 6 | 6 | 0 | 4 | 5 |
| `src/dashboard.ts` | 1 | 1 | 0 | 0 | 3 |
| `src/interactive-invocation.ts` | 12 | 11 | 0 | 1 | 5 |
| `src/planner-runtime.ts` | 7 | 7 | 0 | 4 | 5 |
| `src/planner.ts` | 22 | 20 | 0 | 3 | 13 |
| `src/reconciler-runtime.ts` | 10 | 10 | 0 | 2 | 5 |
| `src/relay-store.ts` | 46 | 45 | 0 | 14 | 29 |
| `src/relayd.ts` | 1 | 1 | 0 | 0 | 6 |

## Priority review: unmapped exported runtime symbols


## Required next verification

For each file: inventory every runtime export and applicable type contract; map to the actual Rust signature/dispatch implementation; compare behavior on the same positive, negative, boundary and randomized fixtures; compare durable SQLite, files, Graph decisions, HTTP, events and restart/idempotency effects as applicable; test a real Rust entry point/caller. Only then consider ledger PASS.
