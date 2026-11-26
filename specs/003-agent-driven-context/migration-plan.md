# Agent-driven Context Migration Plan — extracted, not yet executed

**Prepared:** 2026-11-26. **Status:** PLAN ONLY; all Agent rewrites are `NOT STARTED`. Reviewed scope: Relay bundled managed Agents (6), auxiliary Relay review/MVP Agent files (5), Neo Agent files (8: seven shared domain roles plus the escalation executor), Vlog project overlays (9) = **28 Agent-marked Markdown files**, plus shared transport and eight Relay Contract documents. Five auxiliary files have distinct discovery/runner status, not five extra managed Worker roles. The three repositories have distinct ownership; Vlog is read-only here. No automatic Project AGENTS injection.

## Ordered gates and stop conditions

| Gate | Action | Go / no-go evidence |
| --- | --- | --- |
| G0 — Builder | Confirm neutral PromptLayers, inherited metadata, native Codex Global and XChat Bootstrap separation, provider-invariant SHA, JEL report generation | Focused tests and paired staged Neo/Relay Bootstrap succeeded; **whole-daemon regression still open**, including environment prerequisites. Do **not** call the entire refactor production-ready |
| G1 — Extraction review (this phase) | Review `context-inventory.md` and `contract-inventory.md` line evidence, source-to-owner classification, differences between discovery, selection and real read | Every managed ingestion point must be verified beyond this initial source scan and every effective Agent layer/overlay resolved; no changed Agent files. Disagreements explicitly assigned an owner |
| G1b — Code → Markdown extraction | Before Baselines and before editing individual Agents, move hardcoded runtime policies and context scanning out of Rust, into Markdown; keep mandatory native Graph gates | See `code-policy-extraction.md`. Verify 11 policy documents, no edited Agents, no legacy flattening and focused native tests |
| G1c — Define extracted ownership | Map all 11 extracted Markdown policies to exactly one final Contract/Agent/Eval/UI owner and define startup-vs-on-demand | See `extracted-policy-definition.md`; no active loader or Agent change |
| G1d — Recover canonical Markdown Contracts | Merge and deduplicate extracted policy into final MD, implement generic required-startup Contract loading, and only remove compiled profiles after verification | Worker/Planner/DAG/Git/Event/Review/Eval and actual CLI checks required |
| G2 — Baseline freeze | For each Agent choose representative existing Job/Task attempt. Record effective Agent source/hash, canonical prompt fingerprint, selected ref SHA, native transport and actual raw JSONL/thread; for Script use UNKNOWN if raw trace absent | Baseline report is directly openable from JEL Job Viewer; manual reviewer can mark quality; record any unavailable inputs as UNKNOWN, never substitute made-up metrics |
| G3 — Agent-by-Agent | Migrate exactly one Agent definition or approved project overlay, run targeted inheritance + real task E2E, compare JEL reports | Gate requires no regressions in domain output, fewer irrelevant startup reads, no unexpected added Contract/Skill, preserved review and Resume |
| G4 — Delivery | Two independent repos reviewed, full relevant tests and real Job / WebChat transport acceptance, before/after evidence and rollback | Merge and activate only after G3 passes and operator authorizes coordinated live release |

**No compatibility code.** After each successfully migrated Agent, remove that Agent's obsolete duplicate instructions/paths in the same change. Do **not** remove Relay Graph lifecycle safety code, or compatibility needed to read past durable historical records. Legacy inspection routes are a distinct explicit cleanup decision after owner review.

## Migration order and owner matrix

Each row is a proposed **separate** migration; none is an instruction to rewrite now. Default `contexts` remains **absent** unless the Agent genuinely needs one specific directory instruction file. Contract and Skill lists are not interchangeable. An inherited declaration is resolved from the *effective* child before any Harness selection.

### Relay builtin Agents (6)

| Stage | Agent / source | Inheritance | Candidate extracted rules / dependencies | Evidence and acceptance |
| --- | --- | --- | --- | --- |
| R-1 | `Relay:skills/agents-relay/agents/implementation.agent.md` | None (builtin) | Make self-review D04 an explicit **role-scoped contract** after approval; remove prose duplicate of Runtime R01/R02, retain deliverable and implementation responsibility | `Relay:rust/tests/native_codex_worker.rs`; source-review/fix-verify real Task; correct Git/DAG terminal, no extra Contract reads |
| R-2 | `Relay:skills/agents-relay/agents/planner.agent.md` | Builtin; Vlog child below | Keep Plan method/role decomposition; assess Ponytail as optional vs mandatory Skill **before** `required_skills`; remove duplicated native apply protocol but keep Plan semantics | `Relay:rust/tests/native_codex_planner.rs`, actual Planner apply receipt; Vlog Planner continues inheriting |
| R-3 | `Relay:skills/agents-relay/agents/reviewer.agent.md` | Base of job-acceptance child | Immutable target, review verdict remain role-specific; immutable SHA and terminal graph gates remain runtime | `Relay:rust/src/outcome_review.rs:99-125`; no edit/merge, independent cited findings |
| R-4 | `Relay:skills/agents-relay/agents/job-acceptance-reviewer.agent.md` | `extends: reviewer` | Keep only preflight/final-job specializations; inherited reviewer rules appear once | `Relay:rust/tests/native_agent_content_resolver.rs`; verify base+child effective hashes and final acceptance |
| R-5 | `Relay:skills/agents-relay/agents/review-chair.agent.md` | None | Panel synthesis and immutable target policy; no general Implementation review-loop injection | Stage review tests, no extra source modifications |
| R-6 | `Relay:skills/agents-relay/agents/troubleshooter.agent.md` | None | Explicit recovery D06 + **conditional** D07; remove copy of Runtime recovery invariants, preserve escalation guard | Original attempt event history, exact retry vs human escalation, P0 self-job behavior; do not invent model reroute |

### Relay auxiliary outcome-review/MVP Agents (5 files, distinct from managed Workers)

| Stage | Agent / source | Effective ownership / dependencies | Acceptance |
| --- | --- | --- | --- |
| A-1 | `Relay:agents/outcome-reviewer.agent.md:1-23` | Generic Outcome Reviewer for `outcome_review`, **not** Relay SHA-bound final Reviewer and not a child of it | Review outcome against caller evidence without mutating artifacts; preserve existing CLI |
| A-2 | `Relay:agents/dashboard-mvp-agent.agent.md:1-9` | Discovery wrapper; points to the canonical `mvp/agents` definition | Wrapper must not duplicate D01–D03 checklist |
| A-3 | `Relay:mvp/agents/dashboard-mvp-agent.agent.md:1-11` | Canonical WebHelm Dashboard MVP check agent | D01–D03 actual visible UI evidence, no broad regressions |
| A-4 | `Relay:agents/neo-mobile-mvp-agent.agent.md:1-9` | Discovery wrapper; points to the canonical `mvp/agents` definition | Wrapper must not duplicate M01–M04 checklist |
| A-5 | `Relay:mvp/agents/neo-mobile-mvp-agent.agent.md:1-11` | Canonical physical iPhone MVP check agent | M01–M04 actual device evidence; no false success |

These files are inventoried, but not automatically subject to managed `PromptLayers` migration. Their invocation path must first be explicitly established from actual CLI/runtime sources.

### Neo Agents (8: seven shared/domain roles plus the escalation executor)

| Stage | Agent / source | Inheritance | Candidate extracted references and non-references | Acceptance |
| --- | --- | --- | --- | --- |
| N-1 | `Neo:agents/editor.agent.md` | Declared parent target of Vlog Editor (requires effective Relay resolver verification) | Keep editorial craft/visual watch loop and EDL; Markcut requiredness must be decided with Vlog project owner; no implementation-code self-review contract by default | Real timeline, audio and EDL decision evidence, native report |
| N-2 | `Neo:agents/visioner.agent.md` | Declared parent target of Vlog Visioner; not yet verified effective loading | Existing normalized source media/Markcut skill references; distinguish optional inference adapters from mandatory source data | Input metadata and actual STT/VTT evidence, no repeated inference |
| N-3 | `Neo:agents/publisher.agent.md` | Declared parent target of Vlog Publisher; not yet verified effective loading | Publication authorization, HOLD and idempotent channel operation; never inherit software Release Agent contract | Source authorization / platform receipt / exact terminal status |
| N-4 | `Neo:agents/reviewer.agent.md` | Separate from Relay reviewer | Native PR SHA and structured outcome contract; no unrelated Job preflight policies | Independent immutable review; review result accurately attributed |
| N-5 | `Neo:agents/ui.agent.md` | None | UI platform and accessibility Skill refs, optional specialist composition | Platform screenshot and visual review when available; no blind code assumptions |
| N-6 | `Neo:agents/release.agent.md` | None | Software release approvals, target receipts; no assumption Market draft == published | External platform release and rollback evidence |
| N-7 | `Neo:agents/market.agent.md` | None | Market copy / asset provenance and domain specialist refs | No publication without authorization; no redundant Video Editor implementation |
| N-8 | `Neo:agents/escalation.agent.md` | None | Human/external recovery procedures; optional external platform references | Explicit operator/human boundary, no password or MFA bypass |

### Vlog project Agent overlays (9, read-only in this phase)

| Stage | Agent / source | Inheritance | Candidate extraction / migration caution | Acceptance |
| --- | --- | --- | --- | --- |
| V-1 | `Vlog:agents/planner.agent.md` | `extends: planner` (Relay) | Domain-specific graph, handoffs, Markcut verification; preserve shared Planner apply contract exactly once | Real Vlog Plan and Job DAG matched before/after |
| V-2 | `Vlog:agents/visioner.agent.md` | `extends: visioner` (Neo) | Shared inference + run source metadata; don't duplicate source vision stacks | Actual source evidence and no unnecessary second inference |
| V-3 | `Vlog:agents/director.agent.md` | None in file | Narrative, episode history, creator profile, candidate evidence and Hook | Correct story, factual source grounding, handoff to Editor |
| V-4 | `Vlog:agents/editor.agent.md` | `extends: editor` (Neo), **380 lines** | Large domain role; extract Markcut/shotcraft/EDL procedural rules into appropriate on-demand Skill, keep decisions/quality ownership; do not auto-read Markcut source code | Real Editor E2E and raw JSONL on known failed/successful Vlog Job; review two real passes, inspect watchable film and EDL |
| V-5 | `Vlog:agents/producer.agent.md` | None in file | Verify/render task and review; explicitly distinct from creative Editor | Markcut verify+MP4 artifact, preview receipt, no false publication |
| V-6 | `Vlog:agents/publisher.agent.md` | `extends: publisher` (Neo) | Vlog channel specifics + private HOLD authorization, idempotent WebHelm shortcuts | No unapproved publish; destination receipt after authorized post |
| V-7 | `Vlog:agents/market.agent.md` | None | Independent market feedback, not Producer's technical QA | Immutable preview-based creative judgment |
| V-8 | `Vlog:agents/video-director.agent.md` | None | Independent picture/sound quality assessment, preserve specialist boundary | Playable moving footage + audible sound evidence |
| V-9 | `Vlog:agents/final-qa.agent.md` | None | Output media fidelity/caption/privacy validation | Actual MP4 playback, no source-editor overlap |

### Cross-Agent dependency map

`Relay Planner` → `Vlog Planner` (named extends); `Neo Editor` → `Vlog Editor`; `Neo Visioner` → `Vlog Visioner`; `Neo Publisher` → `Vlog Publisher`; `Relay Reviewer` → `Relay Job Acceptance Reviewer`. **The Vlog files declare these extends targets, but this is not proof of effective runtime inheritance.** The Neo CLI catalog only records frontmatter; Relay source-layer resolution must be tested. Do not assume merely matching filenames proves the merged definition. A change in a shared parent potentially affects every child, so all affected child baselines must be rechecked.

## Per-Agent standard change procedure (for G3, not now)

1. **Observe** effective Agent/ancestor hash, runtime PromptLayers SHA, existing selected references, raw JSONL tool/file-read trace, Task outcome, output quality and token/time. Keep source read-only during baseline.
2. **Classify** each duplicated instruction as Runtime invariant, Agent role, native Harness delivery, Context candidate, Contract, mandatory Skill, optional Skill or Task data. Confirm missing reference semantics and ownership.
3. **Edit one Agent** (or one parent plus all children in its own explicit migration unit), only after G1/G2 approval; add `contexts` **only if an actual project AGENTS file is needed**. Declare required Contract/Skill only if failing closed on absence is desired.
4. **Verify** inherited section precedence, exact execution identity, references/SHA, no duplicate Agent body in User, no extra automatic Context, Resume compatibility, real domain output and independent human-visible JEL Report.
5. **Compare** canonical fingerprint and report before/after; change in fingerprint is expected when instructions change, but provider invariance for the same version is mandatory. Model quality is not judged from SHA alone.
6. **Review/fix/reverify** until no actionable finding remains. No production release after a partial individual migration or unverified report.

## Baseline and coverage matrix (explicit NOT STARTED)

| Verification | Concrete acceptance | State |
| --- | --- | --- |
| Static inventories | Three files cross-referenced and source anchors validated | This extraction phase |
| Builder provider invariance | Same Agent+Task+Execution across Z.ai, OpenAI, DeepSeek/WebChat yields identical neutral Prompt SHA | Builder unit test exists; live WebChat delivery comparison **NOT VERIFIED** |
| Native Global / no extra Context | Codex's Global once, no project Context without declaration | Native Codex prompt-input tested; real Worker-level JSONL correlation **NOT COMPLETE** |
| Worker / Planner Resume | Same trusted effective role and reference identity, no double load | Focused Rust tests; actual before/after matched run **NOT STARTED** |
| E2E report baseline | JEL viewer can generate/open raw-trace report for real selected Task | Viewer wiring exists; per-Agent baseline comparison **NOT STARTED** |
| Vlog Editor comparison | Real cut + audio + EDL; tool/file read chronology, compactions, measured token/time | **NOT STARTED** in this phase |
| Package | Paired Neo+Relay staged CLI, XChat bootstrap from package | Verified staged E2E; not production deployment |
| Full daemon tests | All relevant integration suites green or individually classified against clean Main | **OPEN**: prior suite had isolated Script Node and project-root failures; do not call clean |
| Final merge/live | Both repo diff reviews and all gates | **NOT STARTED / NOT AUTHORIZED BY THIS PHASE** |

## Scope ledger / rollback

- **Modify now:** `Relay:specs/003-agent-driven-context/context-inventory.md`, `contract-inventory.md` and `migration-plan.md` only. No change to any `*.agent.md` or production Rust/Neo code in Extraction Phase.
- **External project:** Vlog project Agent files were *read only* and require a separate future authorized worktree before any changes.
- **Deferred questions:** whether Planner Ponytail is mandatory or advisory; whether Worker Self Review Contract is required by metadata vs inherited body; whether legacy context inspection has any true managed consumer; which Agent-specific domain handoffs belong in Skills vs Contracts.
- **Rollback for future G3:** restore exact prior effective source hash/metadata, re-run native harness E2E, and preserve raw JSONL and immutable JEL comparison. Do not modify historical Task state to make an Eval pass.

**Execution-order correction:** Code-to-Markdown policy extraction (G1b) takes priority over per-Agent Baselines and Agent migration. The earlier inventories were the input to this *implementation*, not a substitute for it. Runtime policy text is now stored in 11 versioned Markdown documents; per-Agent YAML migration remains later.

## Extraction Review → Fix ledger (2026-11-26)

- **Round 1 (Relay-only read-only Codex review):** Two P1 document findings, both corrected: separate Agent/Task Prompt Builder from neutral Global/Harness/Skills Bootstrap Parts; limit absent Context claims to *inspected file headers* until the full effective inheritance chain is resolved.
- **Round 2 (Neo + Vlog read-only Codex review):** Correctly verified 9 Vlog Agent files, 8 Neo Agent files **including** the standalone Escalation executor, and the three declared Vlog extends relationships. Clarified that a declared parent name is not proof of effective runtime resolution. The review independently confirmed XChat **manifest assembly only**; WebChat session injection and required Markcut/Ponytail Skill status remain unverified.
- **Static audit:** 3 documents, 125 source mentions, 69 unique local source files and 28 Agent-marked files. Every cited file exists, every explicit line range is in bounds; no Agent Markdown files modified. This validates **documentation references**, not production or model behavior.
- **Open gating evidence:** full managed ingress callgraph verification, actual effective inheritance resolution on representative Jobs, raw-trace per-Agent baseline, real WebChat message delivery, complete environment-qualified Daemon regression and final release review.

**Extraction scope accepted as a source inventory; Agent migration is deliberately NOT STARTED.**
