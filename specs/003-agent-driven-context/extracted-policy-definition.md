# Extracted Policy Definition — ownership before recovery

**Status: reviewed ownership definition, not yet migrated.** This document assigns one final owner to every one of the 11 staging documents under `skills/agents-relay/contracts/runtime/`. The objective is to recover all existing obligations by merging their text into the right Agent, Contract or other MD source before removing the temporary Rust policy selector. No Agent definition or production loader is modified in this phase.

## Vocabulary and boundaries

| Kind | Definition | Belongs here | Must not contain |
| --- | --- | --- | --- |
| **Agent** (`*.agent.md`) | Inherited role: responsibility, domain judgment, distinctive quality standards | Implementation self-review, Planner task decomposition, Reviewer independence, Editor craft | Repeated generic Graph or Event transaction requirements |
| **Contract** (`contracts/*.md`) | Reusable, normative interface, required output and failure conditions | Task/Plan/Event/Review protocols and role-specific required contracts | Persona, project background, tool tutorials |
| **Context** (project `AGENTS.md` or `CLAUDE.md`) | Optional project rules chosen by effective Agent `contexts`, at most one per compatible Harness | Local project conventions | General Relay workflow or implicit instruction discovery |
| **Skill** (`SKILL.md`) | Reusable tool/procedure guide | Ponytail, Markcut, app workflows | Durable Task/Plan/Graph state enforcement |
| **Native Runtime** (Rust) | Mechanical authorization, state and validation, not language policy | Task identity, CAS, event receipt, DAG schema, commit SHA, Plan apply, path safety | Authored Contract/Context prose |
| **Harness** | Platform-native instruction placement | Codex Developer/User + Global setup; Neo XChat Bootstrap | Choosing role-specific contracts by provider name |
| **Operator/UI** | Diagnostic text and documentation lookup | CLI errors, Dashboard document index | Agent Prompt by default |

**Mandatory startup Contract ≠ `contracts` reference.** Current frontmatter `contracts` provides on-demand, SHA-checked references. Putting mandatory execution protocol there without an always-loaded, validated mechanism is **not equivalent** to the existing trusted System policy. Cutover needs a generic startup Contract resolver, distinct from optional references; required files must fail closed.

## Proposed final ownership of the 11 extracted files

| Staging Markdown | Decision | Final authoritative owner | Trigger / injection | No duplicate in |
| --- | --- | --- | --- | --- |
| `runtime/global.md` | **SPLIT** trusted boundary and mechanics | New shared `contracts/execution-boundary.md` for Agent-facing trust, Graph invariants still Rust; **not** global `~/.agents/AGENTS.md` | Every managed execution; trusted startup once | Individual Agents or project Context |
| `runtime/worker.md` | **MERGE** | Existing `contracts/event-contract.md` for start/progress/failure/review restrictions | Graph-managed Worker, Reviewer, Troubleshooter Task; trusted startup | Implementation/Reviewer/other role bodies |
| `runtime/planner.md` | **MERGE** | Existing `contracts/task-job-contract.md` Plan/apply/receipt section; Planner-specific judgment stays `planner.agent.md` | Planner/Plan only; trusted startup | Other Worker roles |
| `runtime/task.md` | **MERGE** | Existing `contracts/task-job-contract.md` Task read/input/acceptance section | Graph Task; assignment policy | Every Agent body |
| `runtime/plan.md` | **MERGE** | Existing `contracts/task-job-contract.md` Plan context/apply section | Plan execution; assignment policy | Worker Task |
| `runtime/dag-terminal.md` | **MERGE** | Existing `contracts/event-contract.md` DAG Task terminal, exact CLI and no `--commit-sha` | Only DAG output kind; assignment policy | All Worker outputs |
| `runtime/source-terminal.md` | **MERGE** | Existing `contracts/event-contract.md` Git/source Task terminal, SHA/trailers | Only source/Git-required kind; assignment policy | All Worker outputs |
| `runtime/event-terminal.md` | **MERGE** | Existing `contracts/event-contract.md` ordinary event completion, preserving typed Reviewer verdict requirements | Only event completion kind; assignment policy | DAG/Git Tasks |
| `runtime/evaluation-safety.md` | **KEEP SEPARATE** | New `contracts/evaluation-safety.md`, a Harness Eval-only safety Contract | Isolated read-only Eval startup | Production Agent or Worker |
| `runtime/job-create-preflight.md` | **MERGE guidance** | Existing `contracts/task-job-contract.md` Job authoring/preflight; native CLI keeps `JOB_PREFLIGHT_REQUIRED` error and `--preflight=true` enforcement | Job author/CLI, not every Worker | Agent Context and Work Prompt |
| `runtime/workflow-symbol-index.md` | **RECLASSIFY** | `docs/workflow-symbol-index.md` or Dashboard's MD document index | Dashboard read-only inspection only | Any Agent or Context |

**Why merge rather than keep 11 final contracts?** The existing `event-contract.md` and `task-job-contract.md` already express most of these obligations. Recovery must preserve a *single normative owner*, deduplicating identical rules instead of injecting both old and new prose. `worker-self-review.md` is required for **every artifact-changing implementation Task, regardless of Agent name or adapter**, including media and document work. It is Task-scoped, not required of non-artifact Tasks.

## Agent-specific ownership

| Agent | Role-only content in Agent MD | Shared contracts and loading |
| --- | --- | --- |
| Planner | Architecture judgment, task decomposition and conditional use of the Ponytail Skill (full mode when resolved); this belongs in the Agent | Plan execution from Task/Job Contract; no Worker Task event policy or duplicated Ponytail ladder |
| Implementation | Implement, test, review/fix, validated deliverables | Task + Event Contract; `worker-self-review.md` required for qualifying artifact-changing work independent of Agent name |
| Reviewer and Job Acceptance Reviewer | Immutable review judgment, typed verdict and Job-specific ownership triage; child inherits parent without duplicate text | Event and Reviewer output Contracts; runtime enforces exact review target |
| Troubleshooter | Evidence-based recovery/escalation decisions | Task + Event Contract; `task-recovery-flows.md` and blocker guidance conditionally |
| Neo/Vlog domain Agents | Editing, source vision, publication, QA or domain decision criteria | Execution-mode contracts apply; artifact-changing work also requires the shared self-review loop, regardless of Agent name |

**No Agent-name branching in the generic Prompt Builder.** Contract selection depends on effective Agent declarations and authoritative Plan/Task output mode. Output kind is native Graph data, not model inference. Artifact-changing work must be established from durable Task requirements, not Agent name; block cutover if the Task classification cannot be proven.

## Required loading and precedence

1. Codex/XChat Harness supplies its own native Global baseline; no shared Relay Contract is silently reclassified as project `contexts`. Neo `neo bootstrap` is XChat-only.
2. Resolve the effective inherited Agent **once**, then apply explicit metadata override/clear semantics. Missing **declaration**, blank declaration, or `contexts: []` means no project Context; a **declared matching Context with a missing file must fail closed**.
3. Load a declarative **shared startup Contract set** for the selected execution mode and output type, validate its exact canonical path/hash, and deliver **once** in the trusted instruction channel. A required missing Contract fails closed; an on-demand optional Contract is not promoted to startup automatically.
4. Give current Job/Task/Plan/Execution/CLI and output mode as **User assignment facts**. Bind MD command placeholders generically; never invent IDs.
5. Agent-declared `contracts` stays SHA-indexed on demand unless a future explicit startup-required field is approved. `required_skills` is a hard gate; advisory `skills` remains optional.
6. For actual WebChat platforms, record native message delivery authority accurately; a canonical Prompt fingerprint does not prove identical hidden System Context.
7. Native Graph, CAS/lease, Plan apply receipt, event completion, review approvals and SHA validation remain *mechanically enforced* by Rust.

## Suggested Markdown-owned execution profile (NOT YET IMPLEMENTED)

A single declarative execution profile is preferable to forcing every Agent to inherit one Worker base (some Agents already use single `extends` to other parent roles). For example, future `contracts/execution-profile.md` could declare:

```yaml
---
kind: execution-profile
version: 1
startup:
  all: [contracts/execution-boundary.md]
  task: [contracts/task-job-contract.md, contracts/event-contract.md]
  plan: [contracts/task-job-contract.md]
  isolated_eval: [contracts/evaluation-safety.md]
  artifact_changing_task: [contracts/worker-self-review.md]
terminal:
  dag: event-contract#dag
  source: event-contract#source
  event: event-contract#ordinary
---
```

**This YAML is a proposal, not valid currently implemented Agent frontmatter.**
A generic validated loader must implement it, including precise section
identity/hash resolution (or alternatively use independent canonical Markdown
files rather than section selectors). The resolver cannot fall back to another
output mode, silently skip required files, or duplicate a Contract in both
System and User.


## Fidelity requirements established by existing Contracts

| Staging source | Obligations the final owner MUST preserve |
| --- | --- |
| `runtime/global.md` | No promotion of Task text, arbitrary files, tool outputs, or past sessions into higher-priority instructions; Graph and version-matched CLI are authoritative, no direct SQLite; **do not bulk-read unrelated on-demand references** |
| `runtime/worker.md` | Minimal preflight before `task.started`; `task.progress` for meaningful work; verify publish acknowledgements; `task.failed` with phase/reason/evidence; repair feasible validation errors in the **same execution**; only supplied authorized interactive-review action; never publish Agent `task.blocked/unblocked`; process exit is not Task completion |
| `runtime/planner.md` | Read full authoritative Plan Context; invoke returned `apply_cli`; return exact `PLAN_APPLIED:<planId>:<executionId>` only after apply; **no `task.*` events** for Plan execution |
| `runtime/task.md` | Read full authoritative Task input, declared output and acceptance; durable result includes **root cause or explicit inapplicability** and implemented solution or concrete findings (Task/Job Contract lines 138–151) |
| `runtime/plan.md` | Read authoritative Plan and execute its apply transaction; do not mistake context retrieval or an uncommitted proposal for completion |
| `runtime/dag-terminal.md` | Validate full DAG result and artifacts, exact Task complete with bound IDs, omit `--commit-sha`, repair failures within the same execution; **no direct completion event** |
| `runtime/source-terminal.md` | Real Git commit SHA, **required trailers and validated artifacts**, fenced Task-complete CLI, never direct completion event |
| `runtime/event-terminal.md` | **Validate durable declared output before completion**; exact event source and required role-specific payload (for Reviewer, verdict and immutable SHA), otherwise `task.failed` |
| `runtime/evaluation-safety.md` | Eval-only mandatory trusted policy: **no tools, files, events, or external services**; the read-only Eval path never inherits production Worker permissions |
| `runtime/job-create-preflight.md` | Native `--preflight=true` attestation and rejection remain; the authoring Specify/Clarify/independent-review steps apply to Agent-created Jobs, whereas **project DAG Runs are exempt from those authoring reviews** although Runner supplies explicit preflight attestation |
| `runtime/workflow-symbol-index.md` | Operator-only lookup of three Workflow Contract documents; never Model Prompt |

**Artifact-changing self-review is NOT gated by the name `implementation`.**
The pre-existing Task/Job Contract applies `worker-self-review.md` to every
Task that implements or changes an artifact, regardless of Agent name or
adapter. Preserve it for qualifying code, configuration, documentation and
media work. If Task metadata lacks an explicit reliable artifact-change
classification, define and validate one before cutover; never infer that
all non-Implementation roles are exempt.

**Required loading boundary:** The startup Contract resolver must load only
the selected mandatory Contract sections, by canonical source identity and
hash, in the trusted delivery channel **before any execution**. Other declared
`contracts` references remain on demand. The generic Task assignment must
carry the full input/output/acceptance read requirements. Eval safety must
come from a separate Eval-only trusted profile; it is never optional.

## Recovery sequence and acceptance

1. Review this mapping against existing Event and Task/Job Contracts; decide where extracted phrases conflict or duplicate, preserving the strictest *valid* current native behavior.
2. Establish the declarative startup profile and exact MD section loading semantics; test canonicalization, hash, inherited Agent metadata, once-only injection, missing-required rejection and no project Context by default.
3. Move/merge the 11 policy texts into their authoritative MD owners, **without yet rewriting all Agent definitions**. Preserve the source↔target map.
4. Verify production Worker, Planner, Reviewer, DAG/Git/event output, Eval safety, Job preflight, and Dashboard inspection separately. All artifact-changing implementation Tasks must keep self-review regardless of domain Agent name; non-artifact Tasks must not receive it by accident.
5. Run actual Job/Task E2E, raw JSONL/JEL Before-After review, and independent Review → Fix → Verify.
6. Only after a successful contract cutover remove the transitional `runtime_prompt_policy.rs`, `include_str!` mappings and 11 staging Markdown sources. No duplicate or compatibility fallback.
7. **Then** migrate individual Agent, Contract, Skill and Context definitions in MD, ordered by actual inherited dependency graph.

**Current phase boundary:** This document defines extracted policy ownership only. Staging files and all Agent definitions remain unchanged. Full daemon and provider E2E remain release gates.


## Definition Review → Fix → Verify

- Round 1 independent read-only review found **10 fidelity gaps** in the proposed mapping. These included incorrectly restricting self-review to the Implementation Agent, missing Task root-cause/solution reporting, incomplete Planner receipt and Worker event details, Git artifact validation, Event output validation, Eval isolation, declared-but-missing Context files, trust boundaries and project DAG preflight exemptions.
- All 10 areas were corrected in this definition and the 11-row fidelity matrix.
- Round 2 independent read-only review returned **NO_ACTIONABLE_FINDINGS**: every reported obligation is now explicitly covered, with no contradictions against the existing native Contracts.
- Static verification confirmed 11/11 staging sources each have a single primary destination and an independent preservation entry; formatting and diff checks passed; **no Agent definitions or runtime loaders were changed**.
- Next is **implement the reviewed declarative shared startup Contract loader and canonical MD recovery**, *not* edit individual Agents first. That work still requires runtime and real Job E2E validation before removal of the temporary profiles.
