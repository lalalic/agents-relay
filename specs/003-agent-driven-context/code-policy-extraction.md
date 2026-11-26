# Source-Code Policy Extraction into Markdown

**2026-11-26 implementation status:** extracted first; per-Agent migration deliberately deferred. The instruction text has been moved into Markdown. Rust continues to enforce Graph state, leases, fencing, path safety, transaction authorization, Plan apply receipts, DAG output validation, and Codex native configuration. Those are not Agent prose.

## Extracted sources and usage

| Source (before extraction) | New authority: versioned Markdown | Delivery |
| --- | --- | --- |
| Global worker trust, Relay Graph ownership, no SQLite writes | `skills/agents-relay/contracts/runtime/global.md` | Trusted system for Planner/Worker |
| Worker started/progress/failed/review protocol | `skills/agents-relay/contracts/runtime/worker.md` | Trusted Worker system |
| Planner Plan Context / apply_cli / PLAN_APPLIED | `skills/agents-relay/contracts/runtime/planner.md` | Trusted Planner system |
| Task and Plan authoritative context reads | `skills/agents-relay/contracts/runtime/task.md` and `plan.md` | User assignment policy |
| DAG Task terminal command, flags and validation | `skills/agents-relay/contracts/runtime/dag-terminal.md` | DAG assignment; CLI identifiers substituted generically |
| Commit and Git delivery | `skills/agents-relay/contracts/runtime/source-terminal.md` | Source assignment |
| Event-based terminal | `skills/agents-relay/contracts/runtime/event-terminal.md` | Non-DAG/non-source assignment |
| Isolated Eval do-not-use-tools safety | `skills/agents-relay/contracts/runtime/evaluation-safety.md` | Evaluation System |
| Job-create preflight error/instruction | `skills/agents-relay/contracts/runtime/job-create-preflight.md` | CLI error; native boolean gate remains |
| Read-only dashboard Contract search index | `skills/agents-relay/contracts/runtime/workflow-symbol-index.md` | Operator inspection only, never Agent Prompt |

There are **11 extracted Markdown documents**. They do not add new automatic Agent references or Context dependencies. No Agent YAML or body was rewritten.

## Code after extraction

1. `Relay:rust/src/agent_prompt_builder.rs` now composes an effective inherited Agent, exact Job/Task/Execution values, caller-supplied trusted policy text, and SHA-indexed selected references. The generic Builder does **not** switch on Agent name, Planner, DAG or source Git type. Generic template substitution uses only existing Job/Task/Execution/Repository facts.
2. `Relay:rust/src/runtime_prompt_policy.rs` chooses the versioned Markdown Runtime profile appropriate for an actual Planner or Worker and the Task's terminal type. The **content** comes from Markdown; the native Runtime still determines output type and validates Graph state independently.
3. `Relay:rust/src/cli_context.rs` no longer auto-discovers parent/project AGENTS.md or README for model consumption. The only project Context input for a managed Agent is its effective merged declaration in `agent_context.rs`, selecting at most one harness-compatible file.
4. `Relay:rust/src/execution_context.rs` no longer builds flattened Agent/Execution Context prompt text or transports providerInstructions. `agent_graph.rs` no longer creates one large prompt containing every DAG node's Agent body. Old parity prompt entrypoints were removed rather than kept as compatibility paths.
5. `Relay:rust/src/cli_job_create.rs` takes the preflight explanatory text from Markdown while code still enforces the preflight boolean; `dashboard_workflow_inspection.rs` reads Contract source-list metadata from Markdown.
6. `Relay:rust/src/runtime_resources.rs` recognizes installed resource **directories**, no longer one specific hardcoded Job Contract file.
7. `Relay:rust/src/codex_context_builder.rs` continues to configure native Codex Global setup and disable native project Context. This is a Harness implementation, not Agent Contract text. `Neo XChat Builder` remains Neo-only and unchanged in this phase.

**Build-time snapshot restriction:** the current native Runtime uses `include_str!` to pin the extracted policy files into a reviewed Relay binary. An edit to these runtime Markdown sources requires building and verifying the paired binary. During the later MD-only Agent/Contract/Skill/Context phase, the explicit Agent metadata and resolved on-demand document references become the ownership source; remove this transitional profile selector only after every affected Agent has been migrated and verified. Do not leave two competing injection paths.

## Test and review gates

- Verify the exact extracted prose stays available in appropriate Planner/Worker/DAG/Git/Event/isolated Eval paths, without unrelated role instructions. Validate before/after examples using real native CLI.
- Verify no implicit project directory Context; blank or missing `contexts` means no reference, regardless of AGENTS.md on disk. Distinguish Global Codex setup from Agent project Context.
- Confirm same Agent + Task + Execution + selected references produces provider-neutral Prompt fingerprint; compare actual Codex JSONL separately from prompt intent.
- Audit the Rust source for removed legacy flattened Prompt methods and automatic Context scanner.
- Preserve normal native Task/Plan/Job validation checks and future human/JEL review gates.
- No Agent Markdown changes; no deployment/merge from this extraction alone.

**Next stages in order:** Review `extracted-policy-definition.md`, restore extracted text into canonical Markdown Contracts and a declarative startup loader, then establish raw JSONL Baselines, then refactor individual Agent/Contract/Skill/Context definitions. Do not remove the transitional compiled Runtime profiles until the recovered MD behavior passes native and real Job E2E. Do not first rewrite Agent files while code still owns their policies.

## Review → Fix → Verify receipts (2026-11-26)

- **Review:** independent read-only Codex code review returned **NO_ACTIONABLE_FINDINGS** for the changed Prompt Builder, native Worker/Planner callers, on-demand Context selection, removed legacy Prompt APIs, and the new Markdown documents. It explicitly did not validate live provider delivery.
- **Fix:** repaired a parallel fixture-name collision in native Codex Worker tests, preserved the exact EVENT SOURCE (exact) binding for CLI and Neo Eval integration, and kept the DAG task-complete command in Markdown with generic Job/Task/Execution/Repository variable substitution. No Agent file was changed.
- **Verify (library):** cargo test --locked --lib passed 144/144.
- **Verify (targeted):** Prompt Builder, native Codex Worker, Planner, shared Worker Context, resource root and Context selection passed 26/26.
- **Verify (real CLI, no model call):** Vlog Editor neo-rs eval run --dry-run --project vlog --case editor-no-cutaway-prefers-meaningful-hold generated structured Prompt Layers; verified Markdown-sourced Runtime System, execution event source, safe isolated Eval, Developer Instructions and project_doc_max_bytes=0.
- **Static provenance:** four source-linked documentation artifacts, 133 valid source citations, 11 extracted Markdown files, zero modified Agent Markdown files. git diff --check passed.
- **NOT YET VERIFIED:** full Daemon integration, actual live Codex Worker and WebChat provider execution after extraction, per-Agent baseline quality/JEL comparison, deployment. These remain release gates.
