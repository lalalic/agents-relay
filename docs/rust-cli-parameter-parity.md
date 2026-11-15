# Node to Rust Relay CLI: per-parameter parity checklist

Source: Node cli-help.ts and all src/cli*.ts flag literals. Every listed parameter has a current mark. PASS requires actual executable E2E evidence. Rust-only CLI options are documented separately.

Actions/groups: 66; individual parameter cells: 458.
Counts: INTERNAL_NOT_USER=2, MISSING=197, NODE_MISMATCH=4, PARTIAL=175, PASS=35, RETIRED=45.

Full machine-readable checklist: docs/rust-cli-parameter-parity.csv

## CLI-by-CLI verification

### agent-discover

Overall: PARTIAL. MISSING=1, PARTIAL=8.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--availability` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--capabilities` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--explore` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--runtime` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--task-kind` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--trust-domain` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### agent-register

Overall: PARTIAL. MISSING=1, PARTIAL=18.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--adapter` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--agent-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--availability` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--boundaries` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--capabilities` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--endpoint` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--endpoint-kind` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--labels` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--model` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--name` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--provider` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--regions` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--responsibility` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--role` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--runtime` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--trust-domains` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### artifact validate

Overall: PARTIAL. PARTIAL=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--artifact` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--schema` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### blocker add

Overall: MISSING. MISSING=7.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--dependent-job` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--dependent-pr` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--dependent-repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--dependent-task` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--resolution` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### blocker ensure

Overall: MISSING. MISSING=11.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--authorized` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--dependent-task` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--objective-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--origin` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--reason` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--request-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--resolution` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--target-repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--title` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### blocker resolve

Overall: MISSING. MISSING=3.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--resolution` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### blocker show

Overall: PARTIAL. MISSING=1, PARTIAL=1.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### context resolve

Overall: PARTIAL. PARTIAL=7.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--agents` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--global-root` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--project-path` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--role` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--shared-root` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--skills` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--workspace-root` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### escalation

Overall: PARTIAL. MISSING=9.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--blocked-on` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--blocked-on-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--context` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--context-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--cwd` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--intent` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--intent-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--on-needs-user` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--on-needs-user-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### global help

Overall: MISSING. PARTIAL=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--help` | PARTIAL | Rust help routes work, but exact Node per-command help content is not equivalent |
| `-h` | PARTIAL | Rust help routes work, but exact Node per-command help content is not equivalent |

### init

Overall: MISSING. MISSING=12, RETIRED=9.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--continue-kind` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--continue-target` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--cron` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--execution-mode` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--missed-run-policy` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--mode` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--no-auto-merge` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--no-review` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--objective` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--pr` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--priority` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--project-root` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--schedule` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--schedule-concurrency` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--schedule-cron` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--schedule-next-run` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--schedule-timezone` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--title` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### job cancel

Overall: PARTIAL. PARTIAL=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### job create

Overall: PARTIAL. MISSING=1, PARTIAL=27, RETIRED=13.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--auto-merge` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--base` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--body` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--coordinator-graph` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--coordinator-graph-file` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--coordinator-input` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--coordinator-input-file` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--coordinator-output-path` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--coordinator-project-root` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--coordinator-shared-root` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--coordinator-workspace-root` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--creator-thread-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--cron` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--execution-mode` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--github-repo` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--head` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--idempotency-key` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--implementation-thread-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--initial-plan` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--missed-run-policy` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--mode` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--no-auto-merge` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--no-github` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--no-review` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--objective` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--objective-file` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--priority` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--project-path` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--project-root` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--review` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--reviewer-thread-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--schedule` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--schedule-concurrency` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--schedule-cron` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--schedule-next-run` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--schedule-timezone` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--start` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--tag` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--title` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### job list

Overall: PARTIAL. PASS=1.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--repo` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |

### job merge

Overall: RETIRED. RETIRED=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | RETIRED | Node CLI throws legacy merge error; Graph owns local merge |
| `--repo` | RETIRED | Node CLI throws legacy merge error; Graph owns local merge |

### job pause

Overall: PARTIAL. PARTIAL=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### job resume

Overall: PARTIAL. PARTIAL=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### job run

Overall: PARTIAL. MISSING=6, PARTIAL=2, PASS=5, RETIRED=4.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--codex` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--concurrency` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |
| `--event-json` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--foreground` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |
| `--global-root` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |
| `--lease-ms` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--legacy-shortcut-runtime` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--mode` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--no-github` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--owner` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--project-path` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |
| `--shared-root` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--shortcut-local` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--task-id` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |
| `--workspace-root` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### job show

Overall: PARTIAL. PASS=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |
| `--repo` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |

### job unblock

Overall: PARTIAL. PARTIAL=3.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--reason` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### job update

Overall: PARTIAL. MISSING=9, PARTIAL=11, RETIRED=9.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--auto-merge` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--continue-input` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--continue-kind` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--continue-target` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--creator-thread-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--cron` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--execution-mode` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--implementation-thread-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--local-merge-source` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--local-merge-target` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--missed-run-policy` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--mode` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--no-auto-merge` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--no-review` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--objective` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--objective-file` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--priority` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--project-path` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--review` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--reviewer-thread-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--schedule` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--schedule-concurrency` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--schedule-cron` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--schedule-next-run` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--schedule-timezone` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--tag` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--title` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### migrate-local-repositories

Overall: MISSING. MISSING=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--database` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--mapping` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### plan

Overall: MISSING. MISSING=11.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--codex` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--execution-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--force-restate` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--no-github` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--plan-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--planner-command` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--prompt` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--prompt-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### plan apply

Overall: PARTIAL. PARTIAL=5.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--execution-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--file` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--plan-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### plan context

Overall: PARTIAL. PARTIAL=4.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--execution-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--plan-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### projection conflicts

Overall: PARTIAL. PARTIAL=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### projection resolve

Overall: MISSING. MISSING=5.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--action` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--note` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--projection-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### prompt

Overall: PARTIAL. MISSING=2, PARTIAL=5.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--adapter` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--eval-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--output` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--plan-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--task-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### reconcile

Overall: PARTIAL. MISSING=11.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--events` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--host` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--lease-ms` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--nats-url` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--owner` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--port` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--subject-prefix` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--thread-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### record

Overall: MISSING. MISSING=7.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--commit` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--project` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--summary` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### review interactive

Overall: MISSING. MISSING=4.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--execution-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--path` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### review interactive abort

Overall: PARTIAL. MISSING=1, PARTIAL=3.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--execution-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--reason` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### review interactive begin

Overall: MISSING. MISSING=3.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--execution-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### review interactive fail

Overall: PARTIAL. PARTIAL=4.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--execution-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--reason` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--task-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### review interactive ready

Overall: MISSING. MISSING=3.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--execution-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### review interactive wait

Overall: PARTIAL. PARTIAL=3.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--execution-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--task-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### review job

Overall: PARTIAL. MISSING=2, PARTIAL=1.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--thread-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### review run

Overall: MISSING. MISSING=5.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--agents` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--output` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--project-path` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--prompt` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--prompt-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### serve

Overall: PARTIAL. MISSING=17.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--codex` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--events` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--github-webhook-secret` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--interval` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--lease-ms` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--nats-url` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--owner` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--planner-command` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--port` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--projection-ms` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--refresh-ms` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--subject-prefix` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--thread-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--usage-window-days` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### status

Overall: PARTIAL. PARTIAL=1, PASS=1.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--host` | PARTIAL | Localhost E2E PASS; remote host not supported yet |
| `--port` | PASS | Rust Dashboard native HTTP status on random port E2E |

### task cancel

Overall: PARTIAL. PARTIAL=3.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--task-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### task classify

Overall: MISSING. MISSING=7.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--classification` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--evidence` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--evidence-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--reason` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--reason-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--target-task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### task comment

Overall: MISSING. MISSING=5.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--message` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--message-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### task comments

Overall: MISSING. MISSING=3.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### task complete

Overall: MISSING. NODE_MISMATCH=4.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--execution-id` | NODE_MISMATCH | Node help advertises Task complete, but runtime action validator omits it |
| `--id` | NODE_MISMATCH | Node help advertises Task complete, but runtime action validator omits it |
| `--repo` | NODE_MISMATCH | Node help advertises Task complete, but runtime action validator omits it |
| `--task-id` | NODE_MISMATCH | Node help advertises Task complete, but runtime action validator omits it |

### task context

Overall: MISSING. MISSING=4.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--execution-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### task create

Overall: PARTIAL. MISSING=6, PARTIAL=13, RETIRED=4.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--agent` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--agent-graph` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--agent-graph-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--attachments` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--content-only` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--dependency-validity` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--deps` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--draft` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--idempotency-key` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--input` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--input-file` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--no-content-only` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--output` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--output-path` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--parent` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--priority` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--shortcut-execution` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--shortcut-local` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--store-dir` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--story-size` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--title` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### task escalate

Overall: MISSING. MISSING=6.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--context` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--required-action` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--resolution-condition` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### task events

Overall: PARTIAL. PASS=6.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--after` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |
| `--id` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |
| `--limit` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |
| `--order` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |
| `--repo` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |
| `--task-id` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |

### task list

Overall: PARTIAL. PASS=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |
| `--repo` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |

### task recover

Overall: MISSING. MISSING=9.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--evidence` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--exclude-current-route` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--failure-kind` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--reason` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--recovery-task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--reroute` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### task resume-troubleshooter

Overall: MISSING. MISSING=4.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--response` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### task retry

Overall: PARTIAL. PARTIAL=3.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--task-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### task revise

Overall: MISSING. MISSING=8.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--execution-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--findings-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--head-sha` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--request-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--review-task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### task show

Overall: PARTIAL. PASS=3.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |
| `--repo` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |
| `--task-id` | PASS | Real Rust-only Calculator Job 7 and read-only CLI smoke on 2026-11-15 |

### task supersede

Overall: MISSING. MISSING=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--reason` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### task unblock

Overall: PARTIAL. MISSING=1, PARTIAL=4.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--reason` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--response` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### task update

Overall: PARTIAL. PARTIAL=31, RETIRED=4.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--adapter` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--agent` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--agent-graph` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--agent-graph-file` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--attachments` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--capabilities` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--chatgpt-project` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--chatgpt-tab-close-policy` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--clear-routing` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--content-only` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--cwd` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--dependency-validity` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--deps` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--draft` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--input` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--input-file` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--max-attempts` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--model` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--no-content-only` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--parent` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--priority` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--profile` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--project` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--provider` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--queue` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--reasoning` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--shortcut-execution` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--shortcut-local` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--store-dir` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--story-size` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--task-id` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--timeout` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--title` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |

### workflow action

Overall: PARTIAL. MISSING=8, PARTIAL=6.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--action` | PARTIAL | Native Rust workflow action delegates Task retry/cancel/unblock to canonical Graph Task CLI (isolated E2E); other Actions and live ingress remain unported |
| `--context` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--evidence` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--exclude-current-route` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--failure-kind` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | PARTIAL | Native Rust workflow action delegates Task retry/cancel/unblock to canonical Graph Task CLI (isolated E2E); other Actions and live ingress remain unported |
| `--reason` | PARTIAL | Native Rust workflow action delegates Task retry/cancel/unblock to canonical Graph Task CLI (isolated E2E); other Actions and live ingress remain unported |
| `--recovery-task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | PARTIAL | Native Rust workflow action delegates Task retry/cancel/unblock to canonical Graph Task CLI (isolated E2E); other Actions and live ingress remain unported |
| `--required-action` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--reroute` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--resolution-condition` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--response` | PARTIAL | Native Rust workflow action delegates Task retry/cancel/unblock to canonical Graph Task CLI (isolated E2E); other Actions and live ingress remain unported |
| `--task-id` | PARTIAL | Native Rust workflow action delegates Task retry/cancel/unblock to canonical Graph Task CLI (isolated E2E); other Actions and live ingress remain unported |

### workflow actions

Overall: PARTIAL. PASS=1.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `(none)` | PASS | Node vs native Rust differential E2E (19 Graphs, Graph events, action trace and authoritative predicates) |

### workflow discover

Overall: PARTIAL. PASS=1.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `(none)` | PASS | Node vs native Rust differential E2E (19 Graphs, Graph events, action trace and authoritative predicates) |

### workflow evaluate

Overall: PARTIAL. PASS=4.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--event` | PASS | Node vs native Rust differential E2E (19 Graphs, Graph events, action trace and authoritative predicates) |
| `--facts` | PASS | Node vs native Rust differential E2E (19 Graphs, Graph events, action trace and authoritative predicates) |
| `--graph` | PASS | Node vs native Rust differential E2E (19 Graphs, Graph events, action trace and authoritative predicates) |
| `--state` | PASS | Node vs native Rust differential E2E (19 Graphs, Graph events, action trace and authoritative predicates) |

### workflow inspect

Overall: PARTIAL. PASS=1.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--graph` | PASS | Node vs native Rust differential E2E (19 Graphs, Graph events, action trace and authoritative predicates) |

### workflow trace

Overall: PARTIAL. PASS=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--attempt-key` | PASS | Node vs native Rust differential E2E (19 Graphs, Graph events, action trace and authoritative predicates) |
| `--sqlite` | PASS | Node vs native Rust differential E2E (19 Graphs, Graph events, action trace and authoritative predicates) |

### workflow verify

Overall: PARTIAL. PASS=5.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--condition` | PASS | Node vs native Rust differential E2E (19 Graphs, Graph events, action trace and authoritative predicates) |
| `--execution` | PASS | Node vs native Rust differential E2E (19 Graphs, Graph events, action trace and authoritative predicates) |
| `--job` | PASS | Node vs native Rust differential E2E (19 Graphs, Graph events, action trace and authoritative predicates) |
| `--sqlite` | PASS | Node vs native Rust differential E2E (19 Graphs, Graph events, action trace and authoritative predicates) |
| `--task` | PASS | Node vs native Rust differential E2E (19 Graphs, Graph events, action trace and authoritative predicates) |

### workflow where

Overall: PARTIAL. PASS=1.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | PASS | Node vs native Rust differential E2E (19 Graphs, Graph events, action trace and authoritative predicates) |

## Exit gate

Every command and parameter must have a verified PASS or explicit documented RETIRED decision. Missing and partial items block claims of parity. SOURCE_ONLY flags require confirmed owner classification. Node is only a differential reference; no production Node fallback.
