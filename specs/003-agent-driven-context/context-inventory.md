# Context Inventory — source-linked extraction (2026-11-26)

**Status:** Extraction only; no Agent changed. **Scope:** unmerged Relay and Neo hotfix worktrees, plus read-only inspection of the external `neo/vlog` project. Source IDs use `Relay:`, `Neo:`, `Vlog:` and repository-relative paths with 1-based line numbers. This is static evidence, **not** an assertion that any file was actually read by an Agent. Only the corresponding raw JSONL / browser transport evidence can establish actual behavior.

## Ownership and invariant semantics

| Layer | Owner | Responsibility | Explicit non-responsibility |
| --- | --- | --- | --- |
| Effective Agent | Relay `agent_content_resolver` | Builtin/project/other overlays, `extends`, body and effective metadata | Infer undeclared Context based on role name |
| Managed Prompt Builder | Relay `agent_prompt_builder` | Canonical Agent/Task System/User/References and provider-neutral fingerprint | Choose model/provider or inject all discovered files |
| Neutral Bootstrap Parts | Relay `prompt_bootstrap` | Validate Global/Harness rule files and a Skill catalog; return a content fingerprint | Construct a specific Agent/Task Prompt or select project Context |
| Dependency selector | Relay `agent_context` | Resolve at most one compatible native `contexts` candidate plus declared `contracts` / `required_skills` | Auto-include every project `AGENTS.md` |
| Codex Harness Builder | Relay `codex_context_builder` | Global AGENTS linking, native context suppression, Developer/User placement, Resume | Handle WebChat |
| XChat Harness Builder | Neo `xchat_builder`, called by `neo bootstrap` | Verify neutral Relay Prompt Parts and assemble WebChat Global/Harness/Skills | Touch CODEX_HOME, spawn a Relay XChat worker, claim platform System authority |
| Task / Plan context | Relay Graph | Assignment, execution identity, output, acceptance and event source | Become Agent or Global rules |
| Execution Report | Neo `eval_report` | Ground actual behavior in original JSONL | Treat intended context as actual file reads |

- `contexts` contains alternate native instruction filenames, **not** an eager-read collection. Current recognized candidates are `AGENTS.md` and `CLAUDE.md`; Codex chooses the first matching `AGENTS.md`. It is at most one; none if not declared, empty, `[]`, or no compatible candidate (`Relay:rust/src/agent_context.rs:11-179`).
- Global `~/.agents/AGENTS.md` setup is **separate** and does not depend on the Agent's project `contexts` declaration (`Relay:rust/src/codex_context_builder.rs:11-109`).
- The effective child inherits omitted metadata; explicit override replaces; empty or `[]` clears the inherited list. Inheritance also merges parent body sections, supports differently named parents and approved absolute external Markdown bases (`Relay:rust/src/agent_content_resolver.rs:431-528`).
- `contracts` and `required_skills` are independent, on-demand, validated references and do not imply file discovery (`Relay:rust/src/agent_context.rs:111-187`).
- The canonical Prompt fingerprint includes execution binding and exact references, but excludes provider-specific routing and delivery. Equal fingerprints **do not prove** equal hidden WebChat System instructions (`Relay:rust/src/agent_prompt_builder.rs:32-49,79-194`).

## Source inventory

| ID | Source | Existing behavior | Actual category | Ownership / proposed treatment |
| --- | --- | --- | --- | --- |
| C01 | `Relay:rust/src/agent_content_resolver.rs:180-208,431-528` | Merge effective Agent Markdown, frontmatter, `extends`, source hashes | Agent Resolver | Preserve and regression test |
| C02 | `Relay:rust/src/agent_context.rs:11-44,75-187` | Parse explicit context alternatives, scoped files, deduplicate and validate refs | Selected dependencies | Preserve; no implicit discovery |
| C03 | `Relay:rust/src/managed_worker_input.rs:26-107,183-235` | Worker production/Eval use effective Agent and typed PromptLayers | Production Prompt ingress | Preserve; no other Agent's contracts |
| C04 | `Relay:rust/src/planner_adapters.rs:130-211,225-277` | Planner creates same typed Prompt and Codex Resume args | Planner Prompt ingress | Preserve; verify Resume ref identity |
| C05 | `Relay:rust/src/agent_prompt_builder.rs:79-196` | Effective Agent and Markdown-sourced trusted Runtime policy in System; assignment facts and selected SHA references in User | Canonical Prompt | No embedded Worker/Planner/DAG policy prose; see code-policy-extraction.md |
| C06 | `Relay:rust/src/codex_context_builder.rs:11-109,160-195` | Prepare Global link; reject conflicting config; disable project auto-context; configure developer instructions | Codex only | No XChat responsibility |
| C07 | `Relay:rust/src/native_codex_execution.rs:27-98,275-323`; `Relay:rust/src/native_codex_thread.rs:10-81` | Production Worker/Resume delivery | Native transport | Verify actual model startup JSONL |
| C08 | `Relay:rust/src/cli_context.rs:215-245` | Former broad AGENTS.md/README scanner removed; current resolve_context discovers Agent and Skill catalogs, not automatic model Context | Discovery, not selected injection | Only declared effective Agent contexts can select project instructions |
| C09 | `Relay:rust/src/execution_context.rs:115-186` | Legacy flattened agent_contract_prompt and execution_context_prompt removed | Retired code | resolve_agent_contract remains read-only Agent definition inspection |
| C10 | `Relay:rust/src/agent_graph.rs:117-147` | Legacy bulk DAG Agent Prompt assembler removed; graph parsing/validation retained | Graph data, not Prompt | One Agent role per effective Task, never all DAG roles inline |
| C11 | `Relay:rust/src/execution_context.rs:33-93` | providerInstructions copy removed from execution context | Retired transport metadata | Harness/provider routing owns native delivery |
| C12 | `Relay:rust/src/prompt_bootstrap.rs:1-102` | Read-only `prompt --parts-stdin`: Global, Harness rules, Skill catalog and fingerprint; **no Agent/Task System/User, no project Context selection** | Neutral Bootstrap Parts | Provider-neutral, no Codex setup side effect |
| C13 | `Neo:crates/neo-cli/src/bootstrap.rs`; `Neo:crates/neo-cli/src/xchat_builder.rs` | `neo bootstrap` builds WebChat manifest from verified neutral Prompt Parts | XChat assembly | No Relay XChat Adapter / platform System privilege claim |
| C14 | `Neo:crates/neo-cli/src/prompt_parts_client.rs`; `Neo:crates/neo-cli/src/package.rs` | Resolve and package version-paired Relay CLI | Packaging | Paired release acceptance required |
| C15 | `Neo:crates/neo-cli/src/agent.rs:19-36,99-168,184-207` | Discover Agent catalog and metadata | *Discovery*, not loaded Prompt | No implicit inference from catalog membership |
| C16 | `Neo:crates/neo-cli/src/eval.rs:113-136,218-238,343-442,585-612` | Requires test project AGENTS.md for **Eval eligibility**; isolated safety in System | Eval only | Not an Agent Context dependency |
| C17 | `Neo:crates/neo-cli/src/eval_report/mod.rs:398-468`; `Neo:crates/neo-cli/src/eval_report/trace.rs` | Analyze captured Codex JSONL | After-run evidence | Mark unsupported/missing traces UNKNOWN |
| C18 | `Vlog:AGENTS.md`; `Vlog:agents/editor.agent.md:1-18`; `Vlog:agents/planner.agent.md:1-15` | Project AGENTS present; Editor/Planner extend shared roles | Read-only project overlays | Do not silently auto-inject AGENTS |
| C19 | `Relay:agents/outcome-reviewer.agent.md:1-23`; `Relay:agents/dashboard-mvp-agent.agent.md:1-9`; `Relay:agents/neo-mobile-mvp-agent.agent.md:1-9`; `Relay:mvp/agents/dashboard-mvp-agent.agent.md:1-11`; `Relay:mvp/agents/neo-mobile-mvp-agent.agent.md:1-11` | Additional Relay outcome-review and MVP/discovery Agent definitions, separate from six bundled managed Worker roles | Auxiliary native review and manual MVP Agents | Inventory separately; do not misclassify as inherited managed Worker Agents |

## Extraction findings and risks (not yet migrated)

**F-C1 (RESOLVED IN CODE): broad discovery contradicted explicit Context selection.** The former cli_context::instructions scanner and execution_context_prompt were removed along with their flat-prompt parity routes. There is no implicit context["instructions"] collection. The only selected project Context comes from effective Agent metadata. A raw JSONL trace is still required to assert the model actually read it.

**F-C2 (P1): undeclared required Contract.** Relay Implementation Agent body links `../contracts/worker-self-review.md` but no explicit `contracts` metadata (`Relay:skills/agents-relay/agents/implementation.agent.md:23-28`). Treat as a migration candidate, **not** an immediate Agent file edit.

**F-C3 (P1): inherited overlays must survive.** Vlog Editor declares extends: editor, Visioner/Publisher declare their respective shared names and Planner declares extends: planner. The runtime resolution of each named parent through the Relay source layers is **not yet verified**. Each may add domain-local rules. Do not inject implementation/review contracts into unrelated roles based on a shared Codex runtime.

**F-C4 (P1): two comparison boundaries.** Compare canonical Relay Prompt SHA for same Agent+Task+Execution, then independently compare *actual delivery* (Codex native messages or WebChat sent text). Hidden provider instructions cannot be controlled or claimed equal.

**F-C5 (P1): absence is local evidence, not a universal effective default.** None of the **scanned Agent files** in the listed Relay builtin, Neo shared, Vlog project or auxiliary Relay folders declares `contexts`. However, effective Agent definitions can inherit metadata from additional workspace/project/absolute-base layers; those overlays were **not exhaustively resolved for every live execution**. Empty selection is the expected result **only when the fully merged effective metadata also has no applicable Context**. Review full inheritance sources and selected references for each real Task; mere project AGENTS.md file existence never proves injection. The YAML in `agent-contract.md` is an example.

## Exit gate

Before editing any Agent: complete a production-ingress audit beyond this first static inventory, classify discovered vs injected vs read from raw artifacts, preserve inheritance/clear semantics, attribute each on-demand reference to a single owning Agent, and generate per-Agent baseline Task Reports. UNKNOWN cannot be replaced by an unverified assumption. See `contract-inventory.md` and `migration-plan.md`.
