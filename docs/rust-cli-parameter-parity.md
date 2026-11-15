# Node to Rust Relay CLI: per-parameter parity checklist

Source: Node cli-help.ts and all src/cli*.ts flag literals. Every listed parameter has a current mark. PASS requires actual executable E2E evidence. Rust-only CLI options are documented separately.

Actions/groups: 66; individual parameter cells: 448.
Counts: INTERNAL_NOT_USER=2, MISSING=357, NODE_MISMATCH=4, PARTIAL=22, PASS=18, RETIRED=45.

Full machine-readable checklist: docs/rust-cli-parameter-parity.csv

## CLI-by-CLI verification

### agent-discover

Overall: MISSING. MISSING=9.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--availability` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--capabilities` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--explore` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--runtime` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-kind` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--trust-domain` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### agent-register

Overall: MISSING. MISSING=19.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--adapter` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--agent-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--availability` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--boundaries` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--capabilities` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--endpoint` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--endpoint-kind` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--labels` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--model` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--name` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--provider` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--regions` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--responsibility` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--role` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--runtime` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--trust-domains` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### artifact validate

Overall: MISSING. MISSING=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--artifact` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--schema` | MISSING | Unimplemented or no verified Rust-native parameter parity |

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

Overall: MISSING. MISSING=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### context resolve

Overall: MISSING. MISSING=7.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--agents` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--global-root` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--project-path` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--role` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--shared-root` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--skills` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--workspace-root` | MISSING | Unimplemented or no verified Rust-native parameter parity |

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

Overall: MISSING. MISSING=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### job create

Overall: PARTIAL. MISSING=26, PARTIAL=2, RETIRED=13.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--auto-merge` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--base` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--body` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--coordinator-graph` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--coordinator-graph-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--coordinator-input` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--coordinator-input-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--coordinator-output-path` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--coordinator-project-root` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--coordinator-shared-root` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--coordinator-workspace-root` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--creator-thread-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--cron` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--execution-mode` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--github-repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--head` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--idempotency-key` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--implementation-thread-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--initial-plan` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--missed-run-policy` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--mode` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--no-auto-merge` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--no-github` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--no-review` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--objective` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--objective-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--priority` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--project-path` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--project-root` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--review` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--reviewer-thread-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--schedule` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--schedule-concurrency` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--schedule-cron` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--schedule-next-run` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--schedule-timezone` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--start` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--tag` | MISSING | Unimplemented or no verified Rust-native parameter parity |
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

Overall: MISSING. MISSING=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### job resume

Overall: MISSING. MISSING=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |

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

Overall: MISSING. MISSING=3.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--reason` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### job update

Overall: PARTIAL. MISSING=18, PARTIAL=2, RETIRED=9.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--auto-merge` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--continue-input` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--continue-kind` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--continue-target` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--creator-thread-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--cron` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--execution-mode` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--implementation-thread-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--local-merge-source` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--local-merge-target` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--missed-run-policy` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--mode` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--no-auto-merge` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--no-review` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--objective` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--objective-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--priority` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--project-path` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--review` | MISSING | Unimplemented or no verified Rust-native parameter parity |
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

Overall: MISSING. MISSING=5.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--execution-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--plan-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### plan context

Overall: MISSING. MISSING=4.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--execution-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--plan-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### projection conflicts

Overall: MISSING. MISSING=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |

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

Overall: MISSING. MISSING=7.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--adapter` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--eval-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--output` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--plan-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

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

Overall: MISSING. MISSING=4.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--execution-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--reason` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### review interactive begin

Overall: MISSING. MISSING=3.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--execution-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### review interactive fail

Overall: MISSING. MISSING=4.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--execution-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--reason` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### review interactive ready

Overall: MISSING. MISSING=3.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--execution-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### review interactive wait

Overall: MISSING. MISSING=3.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--execution-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### review job

Overall: MISSING. MISSING=3.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
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

Overall: PARTIAL. MISSING=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--host` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--port` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### task cancel

Overall: PARTIAL. MISSING=2, PARTIAL=1.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
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

Overall: PARTIAL. MISSING=8, PARTIAL=11, RETIRED=4.

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
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--idempotency-key` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--input` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--input-file` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--no-content-only` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--output` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--output-path` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--parent` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--priority` | PARTIAL | Native option exists, but Node-compatible semantics not fully verified |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
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

Overall: PARTIAL. PARTIAL=1, PASS=5.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--after` | PARTIAL | Rust accepted --after 0, but multi-page cursor equivalence with Node is not verified |
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

Overall: PARTIAL. MISSING=2, PARTIAL=1.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
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

Overall: MISSING. MISSING=5.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--reason` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--response` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### task update

Overall: MISSING. MISSING=31, RETIRED=4.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--adapter` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--agent` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--agent-graph` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--agent-graph-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--attachments` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--capabilities` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--chatgpt-project` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--chatgpt-tab-close-policy` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--clear-routing` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--content-only` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--cwd` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--dependency-validity` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--deps` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--draft` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--input` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--input-file` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--max-attempts` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--model` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--no-content-only` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--parent` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--priority` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--profile` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--project` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--provider` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--queue` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--reasoning` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--repo` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--shortcut-execution` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--shortcut-local` | RETIRED | Node handler explicitly rejects deprecated or task-only option |
| `--store-dir` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--story-size` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task-id` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--timeout` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--title` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### workflow action

Overall: MISSING. MISSING=4.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--event` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--graph` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--job` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### workflow actions

Overall: MISSING. MISSING=1.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `(none)` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### workflow discover

Overall: MISSING. MISSING=1.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `(none)` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### workflow evaluate

Overall: MISSING. MISSING=4.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--event` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--facts` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--graph` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--state` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### workflow inspect

Overall: MISSING. MISSING=1.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--graph` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### workflow trace

Overall: MISSING. MISSING=2.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--attempt-key` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--sqlite` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### workflow verify

Overall: MISSING. MISSING=5.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--condition` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--execution` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--job` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--sqlite` | MISSING | Unimplemented or no verified Rust-native parameter parity |
| `--task` | MISSING | Unimplemented or no verified Rust-native parameter parity |

### workflow where

Overall: MISSING. MISSING=1.

| Parameter | Mark | Evidence or gap |
|---|---|---|
| `--id` | MISSING | Unimplemented or no verified Rust-native parameter parity |

## Exit gate

Every command and parameter must have a verified PASS or explicit documented RETIRED decision. Missing and partial items block claims of parity. SOURCE_ONLY flags require confirmed owner classification. Node is only a differential reference; no production Node fallback.
