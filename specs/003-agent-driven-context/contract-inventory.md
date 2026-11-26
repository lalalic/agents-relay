# Contract / Skill / Runtime Instruction Inventory (2026-11-26)

**Status:** inventory plus code-first extraction into 11 Markdown policy files; **no Agent files changed**. The pre-extraction source locations are now superseded by the current locations below and code-policy-extraction.md. Source markers use `Relay:`, `Neo:`, `Vlog:` plus repository-relative path:line. This is a manifest of *observed source definitions*, **not** a proof of instructions actually supplied in a live run. Contract references that are implied by prose are not yet validated dependencies.

## Source of authority: do not migrate these rules into each Agent

| ID | Source and current rule | Current enforcement | Target owner and disposition |
| --- | --- | --- | --- |
| R01 | `Relay:skills/agents-relay/contracts/runtime/global.md:1-9`; `Relay:skills/agents-relay/contracts/runtime/worker.md:1-11` | Trusted Agent/Graph boundaries, Task events, no direct SQLite, review suspension | Markdown-sourced Runtime System | Prose extracted from Rust, Graph state enforcement stays native |
| R02 | `Relay:skills/agents-relay/contracts/runtime/planner.md:1-3`; `Relay:skills/agents-relay/contracts/runtime/dag-terminal.md:1-7`; `Relay:rust/src/runtime_prompt_policy.rs:23-43` | Planner and DAG/Git/event terminal prose now Markdown; execution binding is Task data | Runtime source and selected Markdown | No terminal instructions authored in canonical Prompt Builder |
| R03 | `Relay:rust/src/planner_adapters.rs:65-124`: Plan identity and `PLAN_APPLIED` matching the exact apply receipt | Native Planner adapter | **Plan Transaction Contract — KEEP in code** |
| R04 | `Relay:rust/src/cli_job_create.rs:17-35`: fail-closed Job preflight, points to task-job contract | Native CLI validation | **Job creation gate — KEEP**, explanatory Contract may remain reference |
| R05 | `Relay:rust/src/cli_task_complete.rs:6-23`; `Relay:rust/src/dag_result_contract.rs:70-95`: exact execution identity; DAG result / artifacts validator | Native CLI / graph | **Completion truth — KEEP**; never rely on Agent saying completed |
| R06 | `Relay:rust/src/workflow/contracts.rs:28-46`; `Relay:skills/agents-relay/contracts/event-contract.md:5-158`: Event names, ownership, suspended review | Workflow / Events Bus | **Runtime/Event Contract — KEEP.** Avoid pasting all event policy into role bodies |
| R07 | `Relay:rust/src/native_codex_execution.rs:160-230`; `Relay:rust/src/native_codex_thread.rs:240-394`: verified terminal, thread identity and resume fencing | Native Codex execution | **Harness/runtime identity — KEEP**, not Agent policy |
| R08 | `Relay:rust/src/codex_context_builder.rs:11-109,160-195`: Global AGENTS setup, suppression, Developer/User delivery | Native Harness Builder | **Codex-specific — KEEP**, never put in WebChat Agent Markdown |
| R09 | `Relay:rust/src/agent_context.rs:11-187`: mandatory selected Context/Contract/Skill refs and safety | Dependency selector | **Selector Contract — KEEP**, not an implicit global requirement |
| R10 | `Relay:rust/src/outcome_review.rs:99-125,170-199`: immutable final reviewer identity and result contract | Outcome Review implementation | **Review runtime gate — KEEP**, independent of particular reviewer prose |
| R11 | `Relay:rust/src/dashboard_workflow_inspection.rs:100-120`: reads event/recovery Contract documents for dashboard inspection | Operator UI | **UI disclosure, not Agent dependency**. No automatic Task injection |
| R12 | `Neo:crates/neo-cli/src/eval.rs:343-442,585-612`: safety-only isolated Eval, native transport flags | Native Eval | **Eval safety — KEEP**, never move to an Agent contract |
| R13 | `Neo:crates/neo-cli/src/xchat_builder.rs:33-145`; `Relay:rust/src/prompt_bootstrap.rs:1-96`: source-attested neutral Prompt Parts then XChat assembly | Separate native bootstrap | **Harness split — KEEP**, no Relay WebChat adapter |

## Existing Relay Contract documents and migration ownership

| ID | Document / primary sections | Purpose / current users | Proposed use after Builder gate |
| --- | --- | --- | --- |
| D01 | `Relay:skills/agents-relay/contracts/agent-contract.md:1-103` | Frontmatter, `extends`, `contexts`, `contracts`, `required_skills` schema | **Schema reference** for Resolver/selector. Avoid loading into every Task |
| D02 | `Relay:skills/agents-relay/contracts/task-job-contract.md:1-294` | Job preflight, Task shape, DAG, Planner, source delivery | **Operator/Planner reference on demand**; enforce actual gates in code |
| D03 | `Relay:skills/agents-relay/contracts/event-contract.md:1-158` | Event source, role-specific events, interactive/human gates | **Events Bus contract**. Runtime-enforced; role documentation can refer to it |
| D04 | `Relay:skills/agents-relay/contracts/worker-self-review.md:1-20` | Implementation review/fix rounds, commit-required and DAG deliverables | **Implementation-only candidate**: `contracts: [relay:skills/agents-relay/contracts/worker-self-review.md]` after migration review |
| D05 | `Relay:skills/agents-relay/contracts/architect-design-handoff.md:1-30` | Architect→Planner design ownership and handoff | **Conditional Planner/Architect** reference, not every Worker |
| D06 | `Relay:skills/agents-relay/contracts/task-recovery-flows.md:1-186` | Troubleshooter recovery paths, original attempt, human unblock and thread isolation | **Troubleshooter role** / operator documentation. Keep Graph recovery in code |
| D07 | `Relay:skills/agents-relay/contracts/blocker-job-recovery.md:1-23` | Cross-repository blocker Job decision, supported actions, durable result | **Troubleshooter conditionally on cross-repo blocker**, not automatic per Task |
| D08 | `Relay:skills/agents-relay/contracts/orchestrator-workflows.md:1-92` | Job start, preflight, P0/self-job, deployment vs merge | **Top-level Orchestrator/operator** only; do not inject into leaf implementations |

## Agent-specific instructions currently embedded in Markdown

| ID | Source | Existing instructions | Proposed owner / extraction action |
| --- | --- | --- | --- |
| A01 | `Relay:skills/agents-relay/agents/implementation.agent.md:9-38` | Review/fix mandate, immutable output, self-review links, Task terminal | **Implementation role** and D04; separate legitimate role rules from duplicated Runtime R01/R02 |
| A02 | `Relay:skills/agents-relay/agents/planner.agent.md:28-45,124-210` | Ponytail ladder, Task granularity, Plan and output serialization | **Planner role + required Skill** candidate; Plan transaction R03 remains in code |
| A03 | `Relay:skills/agents-relay/agents/troubleshooter.agent.md:10-65` | Recovery classification, evidence, conditional P0/blocker contracts | **Troubleshooter role + D06/D07**; recovery state still Relay Graph |
| A04 | `Relay:skills/agents-relay/agents/reviewer.agent.md:8-37` | Immutable review target, independent result, events | **Reviewer role**; no live source edits |
| A05 | `Relay:skills/agents-relay/agents/job-acceptance-reviewer.agent.md:2-27` | `extends: reviewer`; preflight and final-Job acceptance specialization | **Child Reviewer role**, preserve parent contract; no second base copy |
| A06 | `Relay:skills/agents-relay/agents/review-chair.agent.md:10-49` | Panel synthesis, specialist review, no merge | **Review Chair role**, not general Task worker |
| A07 | `Neo:agents/editor.agent.md:7-27`; `Vlog:agents/editor.agent.md:1-380` | Shared editorial craft, local Markcut/EDL process; `extends: editor` | **Editor inherited role + Markcut Skill**. Do not impose Implementation code-review policy |
| A08 | `Neo:agents/visioner.agent.md:7-130`; `Vlog:agents/visioner.agent.md:1-38` | Source media vision, read source metadata and tool outputs | **Visioner inherited role**, optional platform-specific Skill/asset data |
| A09 | `Neo:agents/publisher.agent.md:7-13`; `Vlog:agents/publisher.agent.md:1-52` | Distribution authorization, idempotency, channel specifics | **Publisher inherited role**; publication is not completion until verified |
| A10 | `Neo:agents/reviewer.agent.md:7-174` | PR-head review, structured decision and gate | **Neo Reviewer specialization**, do not conflate with Relay Job Acceptance Reviewer |
| A11 | `Neo:agents/ui.agent.md:7-115`; `Neo:agents/release.agent.md:7-97`; `Neo:agents/market.agent.md:7-125` | UI quality, software release, market collateral and distinct handoffs | **Separate domain roles** and relevant references only |
| A12 | `Neo:agents/escalation.agent.md:1-81` | Human/external blocker steps and authorization | **Escalation role**, must not bypass Relay escalation runtime |
| A13 | `Vlog:agents/planner.agent.md:1-91`; `Vlog:agents/director.agent.md:1-304` | Shared Planner extension and Vlog-specific story routing | **Planner inherited role + Director specialty** |
| A14 | `Vlog:agents/producer.agent.md:1-65`; `Vlog:agents/final-qa.agent.md:1-28`; `Vlog:agents/video-director.agent.md:1-31`; `Vlog:agents/market.agent.md:1-32` | Render/verifier/independent review tasks | **Domain stage roles**, preserve independence and per-task limits |

| A15 | `Relay:agents/outcome-reviewer.agent.md:1-23`; `Relay:agents/dashboard-mvp-agent.agent.md:1-9`; `Relay:agents/neo-mobile-mvp-agent.agent.md:1-9`; `Relay:mvp/agents/dashboard-mvp-agent.agent.md:1-11`; `Relay:mvp/agents/neo-mobile-mvp-agent.agent.md:1-11` | Independent generic outcome reviewer, and two MVP agents with discovery wrappers and canonical smoke checklists | **Specialty review/MVP**: keep separate from Relay managed Workers; do not duplicate smoke checklists in discovery wrappers |

## Extraction findings / conflicts to resolve before migration

**F-K1 (P1): code vs prose ownership.** Implementation `task.completed` prose and the shared event doc are not authoritative when the actual output is a DAG file or commit-required Task. The Runtime Markdown selector distinguishes the Task's three terminal paths; the generic Prompt Builder has no such branches. Keep validation and durable transitions in the Graph, not an Agent Markdown or generic “always publish completed” instruction.

**F-K2 (P1): declaring is different from reading.** An Agent's prose link to D04/D06/D07 may be visible in its merged System body, but current frontmatter does not make that file a selected, SHA-checked `contract`. Proposed metadata references require explicit review and baseline, not an automatic bulk extraction.

**F-K3 (P1): required vs optional Skill.** Planner's Ponytail usage is conditional on installed/visible Skill (“when resolved”), and Markcut is domain-specific. A future `required_skills` declaration changes missing Skill from optional to hard failure; approve that behavior explicitly before migrating.

**F-K4 (P1): inspection compatibility.** `Relay:rust/src/execution_context.rs:115-186` and `Relay:rust/src/agent_graph.rs:117-147` can still form large human-readable bodies, but scan-time callers are inspection/parity routes. Do not reintroduce them into managed Worker or Planner Prompt through compatibility code.

**F-K5 (P2): contract docs are not a substitute for native gates.** Several markdown contracts duplicate actual enforcement. Keep the *normative security boundary* in Rust, and make prose a role-specific on-demand reference rather than trusting a model to enforce a transactional invariant.

## Decision gate: where each rule will live

1. **Keep in Relay Runtime:** Job/Task/Plan state, event source and CAS, durable review, recover/escalate, DAG validation, Git completion, approvals, Planner apply receipt.
2. **Keep in Codex Harness:** Global AGENTS setup, native project auto-context suppression, Developer/User delivery, thread/Resume identity.
3. **Keep in neutral Prompt Builder:** effective inherited Agent System, exact Task User, SHA-indexed declared references, provider-independent fingerprint.
4. **Keep in Agent Contract:** domain responsibility and proven required per-role reference policy; no repeated global development protocol for non-development Agents.
5. **Keep in optional Skill/Task input:** command procedures, tool examples, media metadata, EDL and Director handoff, project-specific artifact contents.
6. **Keep in Neo XChat:** Global/Harness/Skill bootstrap and WebChat transport; do not synthesize privileged platform instructions.

Migration remains **NOT STARTED**. See `migration-plan.md` for order, evidence, Rollback and per-Agent gates.
