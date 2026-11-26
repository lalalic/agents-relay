# Baseline research — 2026-11-26

## Scope and reproducibility

Relay source baseline: 0c2346941b89d1f9c4db12e1034886e5ec4d37e0.
Hotfix branch is isolated from main. Native Rust is the only production
backend. The live #745 Worker used installed Relay package
3dc74f30e6801886e146c4deb7d5284e98695d65 and Codex CLI 0.165.0; do not
equate its historical bytes with a reconstructed current-source prompt.
No runtime edits, production Job mutations, provider calls or activation
occurred during this design research.

## Actual Codex context behavior

Earlier read-only probes used codex debug prompt-input on the actual machine,
then repeated with temporary Git trees and isolated CODEX_HOME containing
unique marker strings. Results:

| Probe | Observed native instruction files |
| --- | --- |
| cwd ~/Workspace/neo | Neo AGENTS.md |
| cwd ~/Workspace/neo/vlog | Vlog AGENTS.md only |
| cwd Vlog independent Run Git root | No project AGENTS.md in that Run |
| cwd ~/Workspace/agents-relay | Relay AGENTS.md |
| cwd home | No nonempty project instructions |
| fixture CODEX_HOME/AGENTS.md + repo root | Global + repo |
| fixture nested non-Git directory | Global + repo + nested |
| fixture nested independent Git root | Global + independent root only |
| fixture AGENTS.override.md | Override replaces same-directory AGENTS.md |
| fixture -c project_doc_max_bytes=0 | Global retained; project instructions absent |

Actual ~/.codex/AGENTS.md is a zero-byte regular file. ~/.agents/AGENTS.md
is a 6059-byte separate Neo global file, not natively loaded by default.
A git boundary, not arbitrary parent folders, determines native project
discovery. The user's earlier claim about all global content being injected
is therefore true only when the standard global path is configured.

#745 raw JSONL
~/.codex/sessions/2026/11/26/rollout-2026-11-26T00-18-20-01a2164a-57fa-71e2-8bd1-175747442f62.jsonl
records cwd ~/Workspace/neo/vlog; provider zai; native Vlog AGENTS.md
as a user message (11017 chars with wrapper), full source text present;
Neo parent and Neo global absent. Separate skill catalog (~18.9K chars)
and Codex base instructions (~21.1K chars) were already present.
Actual Relay assignment explicitly references global, parent Neo and
Vlog instructions, requires five contracts, and imposes at least two full
self-review rounds. The role is a content Editor, not implementation.

The complete execution has 195 calls (166 exec_command, 19 view_image,
10 write_stdin). Four compactions triggered repeated startup readings.
The earlier conservative direct-read filter found 76 shell calls, 59
different explicit file paths, and 161 file/call combinations (not filesystem
syscalls; counts include attempts and some validation invocations). Example:
event contract seven direct read calls, four other startup contracts five
each, Editor MVP six, validate-stage implementation eight; Markcut compiler
three and pipeline two direct reads. Source searches add additional exposure.
The Agent explicitly described independently auditing source media rather
than relying on Visioner, discovered a 180-degree inversion, inspected
Markcut implementation and re-rendered after ineffective CSS rotation,
then pre-rotated the asset. Visioner metadata already described inversion
in prose. One segment covered 0–76160 ms, and no structured orientation
field or corrected normalized asset was available. This is both a
context ownership defect and an upstream handoff quality problem.

## Current Rust implementation

### Discovery and Agent selection

- cli_context.rs: instructions() scans configured global AGENTS.md, each
  directory from workspace to project, project README.md; canonical paths
  dedupe discovery. Native Codex's actual Git-boundary discovery differs.
  resolve_context() additionally discovers skills and Agent names.
- agent_content_resolver.rs: existing named layers, explicit absolute
  external bases, section extend/replace, relative link anchoring,
  metadata_from_raw and assigned_metadata implement effective merge.
  Effective metadata is string-based; assigned fields overwrite. Current
  public metadata only exposes advisory skills/model/reasoning and existing
  role fields. No required resource selection contract exists.
- execution_context.rs: resolve_execution_context, resolve_agent_contract,
  execution_context_prompt expose context catalog; explicit selections and
  registrations resolve centrally. Runtime/provider guidance is separately
  represented. Agent visibility is not delivery intent.
- reconciler_context.rs: WorkerContextRoots and resolve_worker_context use
  canonical Job.projectRoot and configured host workspace/global roots;
  worker_managed_prompt changes project.gitRoot to actual execution checkout
  when gitDeliveryRequired. This distinction matters for valid worktrees.

### Managed prompt and lifecycle

- managed_worker_input.rs: default implementation name, selects role,
  includes event protocol if available, task-job/event contracts always,
  recovery contracts for troubleshooter; for every worker adds Ponytail
  if found and worker-self-review if no review/name != review-chair.
  Adds all discovered AGENTS.md regardless of harness; workerSelfReview
  is true for generic worker regardless of DAG domain.
- planner_adapters.rs: separately assembles contracts and all AGENTS.md;
  optional Ponytail is also hardcoded in the builder. Planner's actual
  contract already includes explicit Ponytail guidance. Uses same
  build_relay_work_prompt renderer, separate native initial/resume launch.
- agent_prompt_builder.rs: sorts global/shared/parent/project references,
  snapshots merged role, prints mandatory read-every-contract and Contexts
  list, binding and terminal protocol, and injects generic two full
  review/fix rounds for workerSelfReview. DAG/source terminal rules remain
  indispensable. Reference validation and snapshots must be preserved.
- native_codex_execution.rs -> native_codex_thread.rs build_codex_turn_args:
  currently profile/provider/model/reasoning, cwd, resume thread and
  permissions; no Agent-context native instruction suppression.
  Planner's fresh argument assembly is partly separate. Both paths must
  consume the same context policy. Corrective turns and exact generation
  are fenced in existing code.
- cli_prompt.rs: prompt --eval-file synthetic production/evaluation uses
  managedWorkerInput; current adapter accepted is only codex. Evaluation
  path strips event lines and adds read-only no-tool boundary, does not
  model all production selected context. Durable read-only reconstruction
  cannot guarantee historical bytes; for completed task without executionId,
  current CLI rejects reconstruction. Do not present a preview as raw history.
- AGENTS.md instructs all ordinary unnamed workers to receive implementation
  quality; agent-contract.md says existing skills/model/reasoning hints are
  advisory. Keep that invariant through actual selected default implementation.
  Historical docs/agent-prompt-builder.md still references removed Node,
  ChatGPT/Z worker variants and L4 npm scripts. Production README and
  current Rust CLI take precedence; update stale docs with implementation.

### XChat boundary

Neo crates/neo-cli/src/bootstrap.rs reads the canonical ~/.agents/AGENTS.md,
XChat bootstrap rules, and live skill catalog. XChat caller rules explicitly
require one bootstrap, on-demand skills, and direct local engineering repo
verification. external-child-bootstrap.md owns provider-specific child
bootstrap and token readiness (Z and DeepSeek), not generic Relay launch.
The existing XChat parity checker grades normalized transcripts, including
orchestration, escalation and event semantics; it is not a proof of native
Codex prompt content. XChat caller can select Agent context without restoring
retired browser worker code. Claude is not currently implemented.

## Existing verification results and gaps

On unchanged clean main at exact baseline above, with a fresh temporary
AGENTS_RELAY_STORE_DIR and AGENTS_RELAY_RESOURCE_ROOT matching the source
package, ran cargo test --locked for eight targeted integration suites.
Exit 0; 44/44 pass; elapsed about 14 seconds; pre-existing compiler warnings.

| Suite | Passed | What it proves |
| --- | ---: | --- |
| native_agent_content_resolver | 5 | Layer/section merge, links, canonical scope and invalid parent |
| native_agent_prompt_builder | 6 | Prompt separation, immutable snapshot, refs, execution binding, DAG/source completion |
| native_all_codex_permissions | 2 | Existing role and continuation launch permissions |
| native_codex_planner | 6 | Router flags, exact CLI receipt, compatible continuation |
| native_codex_thread_routing | 10 | Thread/profile fencing, route switch and quota recovery |
| native_codex_worker | 11 | Owned execution, terminal/event fences, corrective continuation, false completion |
| native_eight_batch_context_publication | 3 | Stale Task identity and dependencies, reference prompt, publication dedupe |
| native_shared_worker_context | 1 | Canonical inherited Agent/checkout, provider/profile independent |

Log receipt: local Neo shell job 771e8061f8acfdd2; stdout/stderr under
~/Library/Application Support/NeoY/core/jobs/771e8061f8acfdd2.{stdout,stderr}.log.
These are native deterministic/fixture regressions, not live model E2E.

skills/agents-relay/evals/capabilities.json contains 35 skill decisions across
planning, recovery, worker, review, routing, creation, monitoring, escalation,
inspection, service. run-codex.mjs sends Skill + role markdown directly in a
read-only, ephemeral dry-run; checks recommended commands, flags and forbidden
actions. This is useful for skill behavior but bypasses production context
delivery. No fresh behavioral model run in this design phase. Legacy
npm test:skill:luna / npm test:verification:l4 / test/verification/l4 are
referenced by documentation but not present in the current Rust-only tree.
Do not claim those historical L4 suites pass.

Current CI cargo check, library tests, SQLite and Dashboard tests do not run
all the targeted prompt/context integration suites. Existing tests are mostly
string/fixture checks, including one that asserts universal two-round review
when workerSelfReview=true; these must be changed intentionally, not deleted
to make a test pass. They do not prove that native Codex loaded a selected
file exactly once, or that a content role avoided source exploration.

See verification.md for proposed additional gates and test fixture design.

## Follow-up: existing Neo Eval and trace coverage

Neo crates/neo-cli/src/eval.rs implements neo eval run/list/audit with
project .evals/cases.json, private .evals/reports, Relay prompt --eval-file,
production/evaluation prompt snapshots, read-only Codex decisions or
explicit project test workloads, and expected decision/marker checks.
Current builder checks legacy heading strings and eval launch must adopt
the same structured harness policy as production. Vlog currently has
52 cases (Visioner 5, Director 17, Editor 20, Producer 6, Planner 1,
Publisher 3). Reuse these; extend rather than replace the evaluator.

Rechecked #745 raw session: 195 visible calls, 4 compactions, last reported
cumulative input 39,794,462 tokens (38,396,352 cached), output 73,238.
These are cumulative accounting counters, not one context window or
uncached cost. #744 local Codex JSONL has no visible remote function calls,
compaction or usage records; actual remote execution coverage UNKNOWN.
Different footage and routes make #744/#745 diagnostic, not controlled A/B.
No new model eval performed in follow-up.

## Prompt layer probe (Codex CLI 0.165.0)

Isolated CODEX_HOME, temporary Git root, sentinel AGENTS.md and instruction
file; codex debug prompt-input -c project_doc_max_bytes=0, no model call.
All four invocations exited 0.

| Configuration | Observed message placement |
| --- | --- |
| Default | Global sentinel in user message; project sentinel absent; Task sentinel in user message |
| developer_instructions | Agent sentinel in developer message; built-in base preserved; Global and Task unchanged |
| model_instructions_file | Sentinel replaces base developer instructions; built-in base removed |
| instructions | Sentinel replaces base developer instructions; built-in base removed |

This proves local prompt assembly behavior, not real provider acceptance,
configured profile instruction merge, or resume semantics. Do not replace
Codex's base instructions. Test trusted developer instruction delivery and
preservation of effective configured instructions in actual integration.
