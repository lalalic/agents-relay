# Rust2 PORTING API surface audit

> Generated with `node scripts/rust2-api-parity-audit.mjs --write`. Static candidate checks only: **do not upgrade a ledger row to PASS using this report alone**.

## Interpretation

This audit reads actual TypeScript exports, including exported class methods, and identifies plausible Rust declaration names. Missing names need investigation: Rust may implement them via a differently named method or adapter, so a missing direct match is **not** proof that an API is absent. Matched names are also not proof of matching signatures, effects or semantics.

The exported class properties and interface/type aliases need additional structural or semantic review even when a name looks similar. This is not signature checking.

A listed direct differential import only means a head-to-head test imports the compiled Node module; it does **not** show that every symbol or edge case is covered. A Rust module reference does **not** establish actual production wiring.

## Snapshot

| Metric | Count |
|---|---:|
| sourceCount | 2 |
| pendingSourceModules | 0 |
| pendingRuntimeExportSymbols | 0 |
| runtimeExportSymbols | 11 |
| directNameMatches | 11 |
| unmappedRuntimeSymbols | 0 |
| runtimeConstructorReviews | 0 |
| typeOrShapeReviewSymbols | 11 |
| filesWithUnmappedRuntime | 0 |
| filesWithoutDirectDiffImport | 1 |
| filesWithoutOtherRustReferences | 0 |

Source tree: `22fa4e525904`; Rust source tree: `1d4807b761f2`. Rust module rows in scope: 2. Full symbol details: [RUST2_API_PARITY_MATRIX.json](RUST2_API_PARITY_MATRIX.json).

## Pending source modules (not included in PORTING name-match counts)


## Per-file candidate surface (all 2 PORTING files)

| Node source | Runtime exports | Named Rust candidates | Unmapped runtime names | Direct diff imports | Other Rust refs |
|---|---:|---:|---:|---:|---:|
| `src/reconciler-runtime.ts` | 10 | 10 | 0 | 2 | 5 |
| `src/relayd.ts` | 1 | 1 | 0 | 0 | 6 |

## Priority review: unmapped exported runtime symbols


## Required next verification

For each file: inventory every runtime export and applicable type contract; map to the actual Rust signature/dispatch implementation; compare behavior on the same positive, negative, boundary and randomized fixtures; compare durable SQLite, files, Graph decisions, HTTP, events and restart/idempotency effects as applicable; test a real Rust entry point/caller. Only then consider ledger PASS.
