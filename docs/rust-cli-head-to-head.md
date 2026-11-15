# Rust CLI head-to-head action summary

Authoritative detailed per-option checklist: `docs/rust-cli-parameter-parity.md`. Source-backed CSV: `docs/rust-cli-parameter-parity.csv`.

Only verified real Rust execution may be PASS. Every Node CLI option has an explicit status; unimplemented production actions remain MISSING.

| CLI command | PASS | PARTIAL | MISSING | RETIRED | Other | Current acceptance |
|---|---:|---:|---:|---:|---:|---|
| `agent-discover` | 0 | 0 | 9 | 0 | 0 | NOT COMPLETE |
| `agent-register` | 0 | 0 | 19 | 0 | 0 | NOT COMPLETE |
| `artifact validate` | 0 | 0 | 2 | 0 | 0 | NOT COMPLETE |
| `blocker add` | 0 | 0 | 7 | 0 | 0 | NOT COMPLETE |
| `blocker ensure` | 0 | 0 | 11 | 0 | 0 | NOT COMPLETE |
| `blocker resolve` | 0 | 0 | 3 | 0 | 0 | NOT COMPLETE |
| `blocker show` | 0 | 0 | 2 | 0 | 0 | NOT COMPLETE |
| `context resolve` | 0 | 0 | 7 | 0 | 0 | NOT COMPLETE |
| `escalation` | 0 | 0 | 9 | 0 | 0 | NOT COMPLETE |
| `global help` | 2 | 0 | 0 | 0 | 0 | COMPLETE |
| `init` | 0 | 0 | 12 | 9 | 0 | NOT COMPLETE |
| `internal subprocess` | 0 | 0 | 0 | 0 | 2 | NOT COMPLETE |
| `job cancel` | 0 | 0 | 2 | 0 | 0 | NOT COMPLETE |
| `job create` | 0 | 2 | 26 | 13 | 0 | NOT COMPLETE |
| `job list` | 1 | 0 | 0 | 0 | 0 | COMPLETE |
| `job merge` | 0 | 0 | 0 | 2 | 0 | RETIRED with Node source evidence |
| `job pause` | 0 | 0 | 2 | 0 | 0 | NOT COMPLETE |
| `job resume` | 0 | 0 | 2 | 0 | 0 | NOT COMPLETE |
| `job run` | 5 | 2 | 6 | 4 | 0 | NOT COMPLETE |
| `job show` | 2 | 0 | 0 | 0 | 0 | COMPLETE |
| `job unblock` | 0 | 0 | 3 | 0 | 0 | NOT COMPLETE |
| `job update` | 0 | 2 | 18 | 9 | 0 | NOT COMPLETE |
| `migrate-local-repositories` | 0 | 0 | 2 | 0 | 0 | NOT COMPLETE |
| `plan` | 0 | 0 | 11 | 0 | 0 | NOT COMPLETE |
| `plan apply` | 0 | 0 | 5 | 0 | 0 | NOT COMPLETE |
| `plan context` | 0 | 0 | 4 | 0 | 0 | NOT COMPLETE |
| `projection conflicts` | 0 | 0 | 2 | 0 | 0 | NOT COMPLETE |
| `projection resolve` | 0 | 0 | 5 | 0 | 0 | NOT COMPLETE |
| `prompt` | 0 | 0 | 7 | 0 | 0 | NOT COMPLETE |
| `reconcile` | 0 | 0 | 11 | 0 | 0 | NOT COMPLETE |
| `record` | 0 | 0 | 7 | 0 | 0 | NOT COMPLETE |
| `review interactive` | 0 | 0 | 4 | 0 | 0 | NOT COMPLETE |
| `review interactive abort` | 0 | 0 | 4 | 0 | 0 | NOT COMPLETE |
| `review interactive begin` | 0 | 0 | 3 | 0 | 0 | NOT COMPLETE |
| `review interactive fail` | 0 | 0 | 4 | 0 | 0 | NOT COMPLETE |
| `review interactive ready` | 0 | 0 | 3 | 0 | 0 | NOT COMPLETE |
| `review interactive wait` | 0 | 0 | 3 | 0 | 0 | NOT COMPLETE |
| `review job` | 0 | 0 | 3 | 0 | 0 | NOT COMPLETE |
| `review run` | 0 | 0 | 5 | 0 | 0 | NOT COMPLETE |
| `serve` | 0 | 0 | 17 | 0 | 0 | NOT COMPLETE |
| `status` | 1 | 1 | 0 | 0 | 0 | PARTIAL (local RuntimeSummary passed; remote --host not supported) |
| `task cancel` | 0 | 1 | 2 | 0 | 0 | NOT COMPLETE |
| `task classify` | 0 | 0 | 7 | 0 | 0 | NOT COMPLETE |
| `task comment` | 0 | 0 | 5 | 0 | 0 | NOT COMPLETE |
| `task comments` | 0 | 0 | 3 | 0 | 0 | NOT COMPLETE |
| `task complete` | 0 | 0 | 0 | 0 | 4 | NOT COMPLETE |
| `task context` | 0 | 0 | 4 | 0 | 0 | NOT COMPLETE |
| `task create` | 0 | 11 | 8 | 4 | 0 | NOT COMPLETE |
| `task escalate` | 0 | 0 | 6 | 0 | 0 | NOT COMPLETE |
| `task events` | 6 | 0 | 0 | 0 | 0 | COMPLETE |
| `task list` | 2 | 0 | 0 | 0 | 0 | COMPLETE |
| `task recover` | 0 | 0 | 9 | 0 | 0 | NOT COMPLETE |
| `task resume-troubleshooter` | 0 | 0 | 4 | 0 | 0 | NOT COMPLETE |
| `task retry` | 0 | 1 | 2 | 0 | 0 | NOT COMPLETE |
| `task revise` | 0 | 0 | 8 | 0 | 0 | NOT COMPLETE |
| `task show` | 3 | 0 | 0 | 0 | 0 | COMPLETE |
| `task supersede` | 0 | 0 | 2 | 0 | 0 | NOT COMPLETE |
| `task unblock` | 0 | 0 | 5 | 0 | 0 | NOT COMPLETE |
| `task update` | 0 | 0 | 31 | 4 | 0 | NOT COMPLETE |
| `workflow action` | 0 | 0 | 4 | 0 | 0 | NOT COMPLETE |
| `workflow actions` | 0 | 0 | 1 | 0 | 0 | NOT COMPLETE |
| `workflow discover` | 0 | 0 | 1 | 0 | 0 | NOT COMPLETE |
| `workflow evaluate` | 0 | 0 | 4 | 0 | 0 | NOT COMPLETE |
| `workflow inspect` | 0 | 0 | 1 | 0 | 0 | NOT COMPLETE |
| `workflow trace` | 0 | 0 | 2 | 0 | 0 | NOT COMPLETE |
| `workflow verify` | 0 | 0 | 5 | 0 | 0 | NOT COMPLETE |
| `workflow where` | 0 | 0 | 1 | 0 | 0 | NOT COMPLETE |

## Mandatory end state

Run python3 scripts/rust-cli-parity-audit.py --require-parity. It MUST exit 0 before declaring that every CLI and parameter is Rust-equivalent or explicitly retired. It currently intentionally fails because missing ports remain.

Checked production examples: native Rust job run --foreground on Calculator Job 7, native job list/show, task list/show/events, real independent verifier, wrong repo failure. No Node runtime fallback.

For any retired item, require a Node source statement that its entry is actually deprecated or removed. The legacy job merge command is retired because Node already rejects it in favor of Graph-owned local merge.
