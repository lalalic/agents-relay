# Agent-driven context across harnesses

Status: implementation in isolated hotfix worktrees; no merge or production activation.
Baseline: Relay main 0c23469, Codex CLI 0.165.0, 2026-11-26.

## Execution order and release gates

These stages are strict. **Do not migrate or rewrite individual Agent
definitions while Builder implementation is in progress.**

1. **Prompt + Harness Builders**: resolve the effective inherited Agent
   once; generate a typed System / User / on-demand References bundle;
   auto-prepare and verify native Global instructions; disable native
   project auto-context; deliver through the actual supported Harness
   message channel, including fresh, resume and corrective turns. Validate
   with fixtures, native prompt-input and real Job/Task read-only snapshots.
   Neo XChat Builder has separate WebChat-only bootstrap delivery; it cannot pretend a user turn is
   a privileged System message.
2. **Extract the current hard-coded Context and Contract policy from
   code**, before Agent changes. Inventory every read/injection/terminal
   path with exact source location, owning layer, semantic priority,
   requiredness and test evidence. Classify: invariant Relay lifecycle,
   role-specific Contract, directory Context candidate, optional Skill,
   or current Task fact. Mark removal/replacement plan and detect
   duplicated/contradictory instructions. Do not delete core execution
   invariants during this extraction.
3. **Refactor individual Agents one by one** against the approved
   inventory; retain existing inheritance, overrides and empty/[] clear
   semantics. Move each non-global requirement to exactly one owner and
   test on real recorded execution traces. No broad mass rewrite.
4. **Validate and release as a whole**: JEL Reports, quality checks,
   matched Before/After comparison, review/fix, merge/live/clean.

Existing in-flight Agent metadata edits are provisional and not final
acceptance for step 3. No Agent-specific change is released before the
Builder and extraction gates pass.

## Objective

Make each selected Agent the authority for its required non-global context.
A harness owns how context reaches the model, not what a role needs. Eliminate
unnecessary instructions, repeated file reads, framework implementation
exploration, and unrelated development review obligations in content-production
workers, while preserving Relay's durable execution and acceptance guarantees.

The first target is the existing native Rust/Codex path. WebChatGPT/XChat has a
separate, harness-owned bootstrap/assembly path. Claude is a future harness,
not an implemented adapter. Model providers and profiles are not harnesses.

## User stories

### US0 — Real Job/Task execution report (P0; first deliverable)

As an operator I can select an actual historical or running Relay Job or
Task and generate an evidence-linked report of Agent performance without
rerunning inference or manually parsing JSONL. A Job report identifies
critical-path delay, dependencies, individual Agent attempts, recovery,
review and outcome. Drill down to each Task attempt for actual prompt
layers, file access, observable decision/action/result sequence, failures,
artifact evidence and resource use. I can identify concrete improvement
candidates and compare a subsequent equivalent execution.

Acceptance: generate a browsable offline report from existing #745 and its
Editor Task 2370 before changing Context Builder behavior. Show actual
recorded calls, repeated reads and their evidence, compaction, known
resource usage, outcome, and actionable findings with correction owners.
Unknown or inaccessible telemetry is clearly visible, never zero or PASS.
A human can locate the top bottleneck, inspect original evidence, save
findings and use them to review the next run. Analysis is read-only;
reports cannot alter Jobs or Agent configuration. This P0 report is the
feedback mechanism for the remaining refactor, not a post-refactor test.

### US1 — Global instructions exactly once (P1)
As an operator I maintain one global AGENTS.md and each harness receives it
once without repeated Shell reads. Codex loads its native global file from a
configured CODEX_HOME; on Neo Master this is a verified link to
~/.agents/AGENTS.md. XChat obtains it via its existing bootstrap. Missing,
empty, divergent or unverified global configuration has an explicit diagnosis,
not a silent loss of policy or a second copy in the task prompt.

Acceptance: a fixture with unique sentinels proves each supported harness sees
one global instruction body; Codex native project discovery is disabled for
Relay-managed Agent launches, while ordinary standalone Codex retains native
behavior.

### US2 — Agent declares role-specific dependencies (P1)
As an Agent author I declare the startup context, required skills and role
contracts in the effective Agent definition, independently of transport.
An implementation Agent declares project development instructions, Ponytail
and the implementation quality/review contract. An Editor declares Markcut,
Shotcraft and its own editorial handoff/quality requirements, without inheriting
development files, Ponytail, Git delivery rules or an implementation review
loop merely because it is a worker.

Acceptance: same Agent resolves the same role dependencies across providers
and supported harnesses. Ordinary unnamed work still selects implementation
and retains its quality checks. Named content DAG Agent receives no
undeclared development dependencies. Named reviewer, planner, troubleshooter,
review-chair and specialist roles have explicit, isolated requirements.
Missing required dependency fails before launch, optional suggestions remain
advisory, and a child can intentionally replace or clear an inherited list.

### US3 — Minimal immutable execution assignment (P1)
As a Relay Worker I receive my effective role, selected context, exact Task or
Plan locator and enough protocol to start, report progress, finish or fail.
I do not need to inspect Relay implementation, read a generic Skill to discover
the exact lifecycle CLI, or re-read all startup documents after compaction.

Acceptance: exact generation, event source, execution-bound context read,
version-matched CLI, Plan apply receipt, source/DAG/non-source completion
authority and failure handling remain correct. Role-specific completion
standards are not duplicated by the prompt builder. No new Graph state or
alternate completion path is introduced.

### US4 — Content production uses upstream evidence (P1)
As a Vlog Editor I consume Visioner's canonical metadata and Director's
handoff, use documented Markcut interfaces and existing project templates, and
verify the rendered result. Source image perception belongs to Visioner,
not routine editing. Missing actionable orientation/segment evidence is
reported to the appropriate upstream owner rather than causing broad source
exploration or invented facts.

Acceptance: a fixture with structured orientation and segment evidence
permits editing without reading original contact sheets or Markcut internals.
A missing-evidence fixture leads to a bounded explicit diagnosis; the Agent
does not claim verified quality or publish content. Rendered-output QA is
retained. A domain follow-up is needed if current Visioner metadata lacks
sufficient evidence; disabling instructions alone cannot fix that.

### US5 — Explainable context and realistic regression coverage (P1)
As an operator I can inspect a read-only context plan showing each selected
resource, its provenance, loading mode, deduplication and exclusions.
The inspection path uses the same selection/build code as real dispatch.
Tests prove the actual model-visible input, not just that a prompt string has
the expected headings.

Acceptance: deterministic Rust fixtures, native Codex prompt-input probes,
execution-bound lifecycle tests and isolated behavioral evals demonstrate
correct role boundaries and no duplicate startup resource. Real provider and
Vlog acceptance are labeled separately from simulated/fixture results.

### US6 — Extend harness support without copying business policy (P2)
As a harness integrator I can deliver an already selected context plan via a
harness-specific builder without changing role dependencies or lifecycle
semantics. XChat's bootstrap is explicit; Claude support can be added later
after verifying its native context mechanism.

Acceptance: XChat contract tests validate global ownership and selected role
context without restoring retired WebHelm/browser workers in Relay. An
unimplemented harness fails explicitly rather than falling back to Codex.

## Harness-native Context candidate rule

The effective Agent's `contexts` field is a list of alternative native
instruction filenames (e.g. `[AGENTS.md, CLAUDE.md]`), not multiple files
to preload. The Harness Builder selects at most **one** candidate matching
the actual Harness; it never loads both or automatically falls back to
a different Harness's file. An absent, blank or `[]` effective value means
**no directory Context**, regardless of whether the project has AGENTS.md.
This excludes only directory instructions, not native Global instructions.
Inherited declarations remain effective unless a child explicitly clears them.

## Functional requirements

- FR-00: deliver real Job/Task reports first, including historical jobs,
  all recorded attempts, partial/in-progress reports with capture cutoff,
  actual evidence drilldown, persisted human findings and matched-run
  comparison. Keep deterministic analysis offline by default; model-based
  commentary is optional and cannot substitute for trace evidence.

- FR-01: separate discovery (visible resources), effective Agent resolution,
  dependency selection, harness delivery and the shared Relay assignment.
- FR-02: preserve current Agent inheritance, source layering, advisory skills
  and model/reasoning hints. Introduce explicit required dependencies as
  distinct metadata; an absent declaration never silently adds development
  resources. List replacement and empty-list clearing must be deterministic.
- FR-03: use configured roots, canonical file identity, strict reference
  validation, stable ordering and de-duplication. Relative paths must resolve
  within authorized roots; external bases follow the existing trusted
  inheritance policy. Missing mandatory content must be actionable.
- FR-04: load the effective Agent and required startup material once per
  assignment, without instructing the model to re-read already supplied
  resources. Optional skill procedures are discovered/read on demand. Do
  not introduce new large generic manuals or duplicate contract text.
- FR-05: preserve Graph-owned lifecycle, independent immutable Final Review,
  exact execution fencing, durable output checks, Task/Plan identity,
  process ownership, routing and retry semantics. No role name can weaken
  mandatory source or DAG completion requirements.
- FR-06: Codex fresh and resume paths share the same context policy. Existing
  sessions retain historical text: do not claim that removing a prompt
  section erases it. Context-policy changes require a safe new-thread
  boundary or an explicitly compatible continuation with current authority.
- FR-07: XChat bootstrap does not confer Task authority. XChat consumes an
  explicit selected context handoff; it must not re-run global bootstrap or
  top-level orchestration duties within a managed leaf worker. No provider
  credentials are placed in context manifests or published logs.
- FR-08: only Agent-declared role context plus the global baseline and the
  minimal non-overridable Relay lifecycle envelope may be mandatory. Project
  AGENTS.md, parent instructions, Skills, and domain contracts are not
  selected by generic worker/adapter/dagNode heuristics.
- FR-09: retain backward-readable historical execution evidence. New
  inspection output distinguishes a reconstructed prompt from a historically
  captured one. No SQLite migration or new execution mode is required.
- FR-10: keep the source-only build, release and production rollout boundaries
  unchanged. No restart of an active Relay solely for testing.

## Success measures

| ID | Measure |
| --- | --- |
| SC-01 | Global sentinel exactly once after Builder auto-setup; declared startup references exactly once; no undeclared project/parent/implementation context in Editor fixture. |
| SC-02 | All mandatory lifecycle fence and prior native regression tests pass; negative cases reject stale bindings/missing requirements. |
| SC-03 | Native prompt-input probe verifies actual Codex fresh invocation flags and global/project boundaries; resume policy is tested independently. |
| SC-04 | Controlled same-input/same-model Editor comparison eliminates framework-source reads and routine original-media perception; no loss of required artifact/render verification. Count calls, repeated reads, bytes and tokens rather than promising a particular wall-clock speed. |
| SC-05 | Read-only eval uses the production selector and separately sanitized evaluation envelope. Results identify fixture/model/provider/harness evidence and cannot mutate live Jobs. |
| SC-06 | All migrated roles have an explicit ownership map; no new mandatory field is inferred from DAG membership or model provider. |

## Additional acceptance: Builder ownership and human Eval

The Harness Context Builder owns Global delivery/verification and native
context suppression, not just rendering. The Harness Builder performs safe, idempotent first-use native setup,
including the Global AGENTS.md symlink, then verifies the result. Distinguish Agent responsibility, Contract invariants,
Context (task facts and selected policy), and Skill procedure. The broad
model context includes all these resources; discovery does not imply load.

FR-11: expose read-only execution analysis with actual call/result pairs,
explicit file reads, search matches, images, repeated reads and compaction.
FR-12: human-readable review report, observable decision/action/result
timeline, per-file cause and necessity, matched comparison and saved rubric
findings. Explicit rationale vs inferred cause vs unknown must be labeled;
no hidden reasoning or invented rationale.
FR-13: reuse existing Neo Eval, preserve decision cases, mark missing
telemetry UNKNOWN and never compare incomplete traces as zero work.

| Gate | Acceptance |
| --- | --- |
| SC-07 | Actual native global exactly once, native project discovery suppressed for managed Codex; declared project policy delivered once. |
| SC-08 | Every supported recorded call accounted for or explicitly unknown/unclassified/truncated. |
| SC-09 | Reviewer locates #745 repeated contracts, source exploration and source image reads with evidence without manual JSONL parsing. |
| SC-10 | Reviewer can filter, compare matched runs, assess observable action chain and save findings/verdict offline. |
| SC-11 | Incomplete remote #744 trace is UNKNOWN, not zero; no misleading A/B. |
| SC-12 | Outcome and lifecycle pass, no undeclared startup dependencies, no routine source exploration/perception with sufficient handoff. |

Full terminology, report schema, commands, rubric and gates:
[agent-eval-design.md](agent-eval-design.md).

## Prompt layering acceptance

FR-14: separate logical System Instructions, User Prompt and on-demand
References; preserve the native harness base instructions, distinguish
actual message roles from logical layers, never elevate Task data.
FR-15: compact reference entries declare purpose and activation condition;
required reference availability is checked without mandatory bulk reading.
Static Agent instructions contain essential invariants; detailed contract
and skill procedures are loaded only when useful.

SC-13: Codex probe and real trace show stable trusted instructions distinct
from dynamic Task, Global once, native base instructions preserved and
project auto-context disabled. XChat does not mislabel a user turn as system.
SC-14: two different Tasks for the same Agent share stable instruction
content; only assignment/reference selection changes. A fixture requiring
one reference reads only that reference; an irrelevant reference is not
read. Required completion and quality checks still pass.

## Non-goals

No new Job lifecycle, database schema, role registry, runtime type or browser
worker; no Markcut implementation change, no access-control sandbox redesign,
no live deployment, no Claude implementation in this design phase. Prompt
rules alone are not file-system access enforcement. Do not remove final quality
checks or publish videos. Existing Agent hints remain advisory unless a new
explicit required field declares a dependency.
