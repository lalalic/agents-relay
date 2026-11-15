# Native Rust Relay CLI action-by-action parity

Every CLI command and every parameter is checked and marked. The authoritative per-parameter data is in `docs/rust-cli-parameter-parity.csv` and `docs/rust-cli-parameter-parity.md`.
PASS means real Rust-native executable evidence; PARTIAL / MISSING / NODE_MISMATCH remain blockers. RETIRED requires a sourced Node-side deprecation.

| CLI command | PASS | PARTIAL | MISSING | RETIRED | Other | Current acceptance |
|---|---:|---:|---:|---:|---:|---|
| `agent-discover` | 0 | 8 | 1 | 0 | 0 | NOT COMPLETE |
| `agent-register` | 0 | 18 | 1 | 0 | 0 | NOT COMPLETE |
| `artifact validate` | 0 | 2 | 0 | 0 | 0 | NOT COMPLETE |
| `blocker add` | 0 | 0 | 7 | 0 | 0 | NOT COMPLETE |
| `blocker ensure` | 0 | 0 | 11 | 0 | 0 | NOT COMPLETE |
| `blocker resolve` | 0 | 0 | 3 | 0 | 0 | NOT COMPLETE |
| `blocker show` | 0 | 1 | 1 | 0 | 0 | NOT COMPLETE |
| `context resolve` | 0 | 0 | 7 | 0 | 0 | NOT COMPLETE |
| `escalation` | 0 | 0 | 9 | 0 | 0 | NOT COMPLETE |
| `global help` | 0 | 2 | 0 | 0 | 0 | NOT COMPLETE |
| `init` | 0 | 0 | 12 | 9 | 0 | NOT COMPLETE |
| `internal subprocess` | 0 | 0 | 0 | 0 | 2 | NOT COMPLETE |
| `job cancel` | 0 | 2 | 0 | 0 | 0 | NOT COMPLETE |
| `job create` | 0 | 12 | 16 | 13 | 0 | NOT COMPLETE |
| `job list` | 1 | 0 | 0 | 0 | 0 | PASS |
| `job merge` | 0 | 0 | 0 | 2 | 0 | RETIRED (Node already rejects legacy PR merge) |
| `job pause` | 0 | 2 | 0 | 0 | 0 | NOT COMPLETE |
| `job resume` | 0 | 2 | 0 | 0 | 0 | NOT COMPLETE |
| `job run` | 5 | 2 | 6 | 4 | 0 | NOT COMPLETE |
| `job show` | 2 | 0 | 0 | 0 | 0 | PASS |
| `job unblock` | 0 | 0 | 3 | 0 | 0 | NOT COMPLETE |
| `job update` | 0 | 11 | 9 | 9 | 0 | NOT COMPLETE |
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
| `review interactive abort` | 0 | 3 | 1 | 0 | 0 | NOT COMPLETE |
| `review interactive begin` | 0 | 0 | 3 | 0 | 0 | NOT COMPLETE |
| `review interactive fail` | 0 | 4 | 0 | 0 | 0 | NOT COMPLETE |
| `review interactive ready` | 0 | 0 | 3 | 0 | 0 | NOT COMPLETE |
| `review interactive wait` | 0 | 3 | 0 | 0 | 0 | NOT COMPLETE |
| `review job` | 0 | 1 | 2 | 0 | 0 | NOT COMPLETE |
| `review run` | 0 | 0 | 5 | 0 | 0 | NOT COMPLETE |
| `serve` | 0 | 0 | 17 | 0 | 0 | NOT COMPLETE |
| `status` | 1 | 1 | 0 | 0 | 0 | NOT COMPLETE |
| `task cancel` | 0 | 3 | 0 | 0 | 0 | NOT COMPLETE |
| `task classify` | 0 | 0 | 7 | 0 | 0 | NOT COMPLETE |
| `task comment` | 0 | 0 | 5 | 0 | 0 | NOT COMPLETE |
| `task comments` | 0 | 0 | 3 | 0 | 0 | NOT COMPLETE |
| `task complete` | 0 | 0 | 0 | 0 | 4 | NOT COMPLETE |
| `task context` | 0 | 0 | 4 | 0 | 0 | NOT COMPLETE |
| `task create` | 0 | 13 | 6 | 4 | 0 | NOT COMPLETE |
| `task escalate` | 0 | 0 | 6 | 0 | 0 | NOT COMPLETE |
| `task events` | 6 | 0 | 0 | 0 | 0 | PASS |
| `task list` | 2 | 0 | 0 | 0 | 0 | PASS |
| `task recover` | 0 | 0 | 9 | 0 | 0 | NOT COMPLETE |
| `task resume-troubleshooter` | 0 | 0 | 4 | 0 | 0 | NOT COMPLETE |
| `task retry` | 0 | 3 | 0 | 0 | 0 | NOT COMPLETE |
| `task revise` | 0 | 0 | 8 | 0 | 0 | NOT COMPLETE |
| `task show` | 3 | 0 | 0 | 0 | 0 | PASS |
| `task supersede` | 0 | 0 | 2 | 0 | 0 | NOT COMPLETE |
| `task unblock` | 0 | 4 | 1 | 0 | 0 | NOT COMPLETE |
| `task update` | 0 | 8 | 23 | 4 | 0 | NOT COMPLETE |
| `workflow action` | 0 | 6 | 8 | 0 | 0 | NOT COMPLETE |
| `workflow actions` | 1 | 0 | 0 | 0 | 0 | PASS |
| `workflow discover` | 1 | 0 | 0 | 0 | 0 | PASS |
| `workflow evaluate` | 4 | 0 | 0 | 0 | 0 | PASS |
| `workflow inspect` | 1 | 0 | 0 | 0 | 0 | PASS |
| `workflow trace` | 2 | 0 | 0 | 0 | 0 | PASS |
| `workflow verify` | 5 | 0 | 0 | 0 | 0 | PASS |
| `workflow where` | 1 | 0 | 0 | 0 | 0 | PASS |

## Full-parity gate

The command `python3 scripts/rust-cli-parity-audit.py --require-parity` must exit 0 before claiming complete Node CLI replacement. The audit is intentionally failing until all uncovered active commands and options are implemented or authoritatively retired.

The read-only workflow actions and status APIs do not grant Graph mutation permission. Node is used only as a differential reference, not as a production service or fallback.
