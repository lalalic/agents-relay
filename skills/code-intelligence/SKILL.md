---
name: code-intelligence
description: Reduce code discovery cost for design, planning, implementation and review using project knowledge, ripgrep, CodeGraph and AST search. Use when locating code, tracing impact or checking structural patterns; skip unnecessary exploration for known small edits.
---

# Code Intelligence

Find sufficient evidence with the fewest source reads. Respect the task, project rules, runtime contracts and acceptance criteria; never sacrifice correctness to save tokens.

## Start from project knowledge

Use the assigned checkout and `git rev-parse --show-toplevel` to identify its root. Start with its `AGENTS.md` when present (reuse it if already loaded); follow only relevant current design references, typically in `docs/`. Project documents define intended ownership, interfaces and invariants; source and tests establish actual behavior. If they disagree, investigate the relevant code and report the discrepancy; do not invent a design. For a known local edit, use the known path directly. For non-code work, skip code search.

## Choose one sufficient search

| Need | First choice |
| --- | --- |
| Filename, identifier, error, literal, config | `rg` |
| Definition, caller/callee chain, dependency or change impact | CodeGraph |
| Exact syntax, repeated API calls or structural migration | `ast-grep` |
| Design intent, module ownership or constraints | `AGENTS.md` and referenced docs |
| Actual implementation or review evidence | Targeted source, Git diff and tests |

Do not run all tools by default. Search narrow paths, return filenames or compact symbol results first, then read necessary ranges. Typical query budgets: 10–20 symbols or 80–150 lines. Refine overbroad results; expand scope when evidence or acceptance requires it. Avoid recursive source dumps, generated/vendor/build directories, historical documents, unrelated repos and repeated unchanged reads. Keep full coverage for cross-cutting invariants; a truncated result is not proof of absence.

## CLI usage

Use installed tools; no installs, external uploads or persistent service setup inside a task. On missing tools or unsupported syntax use `rg`, `git grep`, `git show`, `git diff` and bounded reads. Use actual paths and symbols, not the examples literally. Work from the assigned checkout.

**ripgrep** — cheap direct lookup:

```sh
rg --files rust/src | rg 'rout'
rg -l 'route_model' rust/src
rg -n -C 3 'route_model' rust/src/router.rs
```

**CodeGraph** — relations, not bulk source. Set `root` to the assigned Git root. Use only that checkout's own local `.codegraph/` index; never reuse another worktree's database. Disable telemetry for every invocation (`export CODEGRAPH_TELEMETRY=0`). Check `codegraph status --strict "$root"`. If stale, and cache writes are permitted, run `codegraph sync --quiet "$root"` then recheck. If missing, initialize only when relationship queries justify the cost and the checkout permits local cache writes: `codegraph init --local-only --yes "$root"`. Verify the cache is Git-ignored and the index is current; do not commit caches or change tracked ignore/config files. Do not initialize or sync in immutable/read-only review checkouts. Fall back if index identity, coverage or freshness is uncertain.

```sh
codegraph query route_model --limit 10 --path "$root"
codegraph callers route_model --file rust/src/router.rs --limit 20 --path "$root"
codegraph context 'trace worker routing' --max-nodes 12 --no-code --path "$root"
codegraph impact route_model --depth 1 --path "$root"
```

**AST search** — exact structure (quote metavariables):

```sh
ast-grep run --lang rust --pattern '$EXPR.unwrap()' rust/src
```

Limit search to relevant paths; inspect matches before rewriting. Only authorized implementation may edit. Macros, dynamic dispatch, generated code and parser gaps can escape either graph or AST search; verify relevant source and tests. Do not equate a missing match with proof of absence.

## Role workflow

- **Design / Planner:** read relevant project design first. Locate canonical implementation, existing helpers, affected callers and tests. Pass a compact map in existing Task input: paths/symbols, important relations, design constraints and acceptance evidence. No separate indexing or discovery Task for a simple change.
- **Implementation:** reuse the map, confirm it in the assigned checkout, trace affected callers before edits, reuse shared code, and search sibling paths when required. Refresh the index after edits only if further graph queries need it. Inspect diff and run required tests; maintain affected current design docs.
- **Reviewer:** independently read the objective, current design and immutable target diff. Treat previous maps as hints. Verify exact source (`git show "$target:$file"` with bounded ranges) and test/negative-case evidence. Use graph/AST results only from a verified exact target; use immutable Git reads otherwise. Do not edit, approve from summaries or omit material requirements to save tokens.

## Measure only when needed

Report relevant paths, tests and limitations in existing outputs; no extra artifacts or metrics Tasks. Compare matched objective, target, model/reasoning and acceptance gates in a controlled benchmark. Measure input/output tokens, source-read bytes, tool calls, index time and total elapsed time; distinguish cold and warm indexes. Never claim unmeasured savings.

CLI references: [ripgrep](https://github.com/BurntSushi/ripgrep), [CodeGraph](https://github.com/colbymchenry/codegraph), [ast-grep](https://ast-grep.github.io/reference/cli/run).
