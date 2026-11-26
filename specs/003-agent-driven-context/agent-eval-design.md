# Agent execution analysis and human Eval

Proposed, not implemented. Companion to spec.md, design.md, research.md and
verification.md. Reuse Neo Project Eval; no additional service or lifecycle.

## P0 — Execution reports before refactor

The primary product is a repeatable evidence-based improvement loop:

    Existing Job/Task -> report -> human findings -> scoped Agent/Skill/
    Contract/Builder/upstream change -> matched rerun -> comparison

Deliver offline reporting on historical #745 first. It must work with
existing logs, not depend on a future builder manifest. Later executions
can add observed context provenance without changing report semantics.
Do not create another dashboard service or a separate evaluation registry.

Proposed canonical CLI (not shipped):

    neo eval report --job-id 745
    neo eval report --job-id 745 --task-id 2370
    neo eval report --job-id 745 --task-id 2370 --execution-id ID
    neo eval compare --baseline REPORT_A --candidate REPORT_B

The report command supersedes the earlier inspect proposal. Resolve Job
identity through read-only Relay APIs, not inferred filenames or current
cwd; project can be inferred only from verified Job identity. If ambiguous,
require explicit project/repository selector. Comparison accepts immutable
report IDs/paths; Job IDs may be resolved into report snapshots with explicit
capture metadata. Task selection includes attempts by default; exact
execution selector restricts drilldown. Never attribute a thread's entire
history to a single resumed attempt. If boundaries cannot be reconstructed,
mark attribution partial and show available raw evidence separately.

Job report: actual graph/dependency timeline, overlap, queue vs execution
time, critical path if sufficiently observed, Task/Agent status, attempts,
recovery, review and durable outcome. Sum of parallel Task times is not
wall-clock duration. Task report: actual route, identity and policy,
startup input, references, per-attempt timeline, file/tool inventory,
tokens/cache/compaction, errors, repeated actions, output and verification.
A running Job report is an immutable as-of snapshot, not final status.

Private local standalone HTML + structured JSON are the proposed outputs.
Use existing .evals/reports ownership, no mandatory network, no model
calls, no live mutation. Include evidence source IDs/record offsets,
redacted excerpts and coverage by execution/metric. Capture actual data
where present, never reconstruct historical prompt as observed input.
Use explicit findings (observation, evidence, impact, confidence, suggested
change and owner) and save human disposition separately. Optional future
LLM interpretation may assist, never replace the trace or human judgment.

First milestone acceptance: generate the #745 Job overview and Editor
drilldown; independently reconcile the 195 observed calls and four
compactions, explain repeated contract reads using actual instructions
and later actions, show Markcut source exploration and render outcomes,
and let a reviewer save at least one evidence-linked finding. File parser
uncertainties remain visible. #744 missing remote data is the negative
fixture. No new Agent execution is necessary for this milestone.

## Per-execution Report Builder selection

Context delivery and report generation are paired by the actual execution
Harness ID, not by Agent name, model provider or presence of a thread.
Job Report aggregates Task Reports; each Task attempt dispatches to its
own recorded Harness Report Builder. Preserve the actual adapter and
builder version/identity alongside its trace locator at execution time.
Historical records lacking attempt-level attribution use the verified
latest worker binding only for the latest attempt; other unknown attempts
remain UNKNOWN. Never reconstruct earlier attempts from today's routing.

| Execution Harness | Report Builder | Authoritative behavior evidence |
| --- | --- | --- |
| Codex | Codex JSONL | Exact session and execution-bound raw JSONL |
| Script | Script | Exact raw script trace if recorded; otherwise UNKNOWN behavior |
| Neo XChat bootstrap | Neo-owned Builder, not Relay Task | Canonical Global rules, XChat Harness instructions and Skill catalog |
| Claude | Claude (future) | Verified Claude native raw trace |
| DAG coordinator | Relay graph overview | Durable graph state; not an Agent execution |

All builders normalize into a shared report format without inventing
missing telemetry. Script lifecycle and artifact proofs are Relay facts,
not a substitute for its absent raw action trace. A Codex neo-local
provider remains Codex for its local trace; linked remote evidence requires
a verified execution correlation and an appropriate reader. Do not
silently use Codex parsing for an unsupported harness.

Acceptance: replay #745 and show coordinator 2365 as a graph wrapper,
Director 2368 and Editor 2370 via Codex JSONL, Visioner 2367, Producer
2374 and Publisher 2375 via Script. Verify unknown evidence is explicit;
synthetic multi-attempt, conflicting requested/selected adapter, and
unsupported harness cases cannot fall back to the wrong parser.

## Terminology and ownership

| Resource | Question answered | Owner | Loading |
| --- | --- | --- | --- |
| Agent | Who am I; what do I own? | Agent definition | Effective role once |
| Contract | What MUST be true? | Interface/domain owner | Required invariant or referenced schema; validate at boundary |
| Context (narrow) | What must I know for this assignment? | Agent declares relevant resources; Task provides actual facts | Selected instructions/facts only |
| Skill | How do I do the work? | Skill owner | Discover catalog; load chosen procedure on demand |
| Context (broad) | What is delivered to model? | Harness Context Builder | Composed role, contracts, selected context, skills, global and lifecycle |

Project AGENTS.md is instruction context (policy), not task evidence.
Visioner metadata and Director story are task/domain evidence, not
instructions. An Agent can declare their expected input contract; the
actual Task supplies their locations and data. Do not convert arbitrary
metadata, document text or tool output into trusted instructions.
A schema belongs to a contract; do not call it a Skill. A Skill may reference
a contract but should not copy its invariants or the Agent's role. Ponytail
is a development/planning procedure, not a universal Relay contract.
Existing optional skills/model/reasoning metadata remain advisory.

Implementation: explicit project development rules and review contract;
Ponytail only when the role declares/uses it. Editor: editorial input/output
and quality contract; Visioner/Director evidence; Markcut/Shotcraft as
applicable. Editor is not a Markcut developer. Verify final render, do not
repeat upstream perception when sufficient evidence exists. A missing
orientation or segment fact has a bounded upstream remedy, not fabricated
quality or broad source exploration. The shared Relay execution envelope
is the one non-overridable lifecycle contract, distinct from role contracts.

## Builder responsibility and acceptance

The Harness Context Builder owns the global delivery plan, verification,
native-context suppression, selected role delivery and deduplication.
Codex builder checks effective CODEX_HOME/AGENTS.md and override precedence,
supplies actual project_doc_max_bytes=0 for every managed launch path
including planner, resume and corrective turn. Builder first-use setup
creates a verified symlink to the configured canonical global source,
backing up only an empty prior file; conflicting nonempty files and
overrides fail closed. Standalone Codex is unaffected. Agent-selected
project instructions must still be delivered once. Neo XChat bootstrap uses its own Builder. There is no Relay XChat
Worker, and no leaf Agent handoff here. Claude future only.
Test effective prompt-input and real captured input, not flags alone.
Keep required role contracts separate from optional skills and context facts.

## Three-layer review

Show separate System Instructions (logical vs actual message role),
User Prompt, and References / Context tabs. Compare stable instructions
between tasks, verify dynamic binding, and list each reference with
purpose, activation condition, available/read status and exact call
evidence. An unused relevant-but-conditional reference is not a defect;
a required invariant missed at completion is. Detect base-instruction
replacement, duplicate Global, project auto-loading and untrusted Task
content promoted to developer role. See design.md for harness mapping.

## Existing integration

Neo eval run/list/audit already uses .evals/cases.json and private
.evals/reports/; retain decision cases and deterministic grading. Extend
the same entry point with analysis of recorded actual executions. Relay
owns execution binding and planned context manifest; harness trace readers
normalize observed records; Neo owns report, comparison and human review.
No report changes Job state. No new inference needed for offline analysis.

Proposed CLI (not shipped):

    neo eval report --job-id 745 --task-id 2370
    neo eval compare --project vlog --baseline REPORT --candidate REPORT
    neo eval review --report REPORT

Report accepts exact execution/attempt or explicitly authorized trace file,
validates association, writes private evidence. Compare immutable report
snapshots. Review opens local standalone HTML with filterable tables,
evidence detail, rubric and findings form; persist human verdict separately
via local review command or JSON export/import, without a new service.
No manual JSONL editing. No real model calls needed to inspect or review.

## Normalized evidence

- Execution: project/Agent hash, job/task/plan + execution/attempt/thread,
  harness, actual provider/model/profile/reasoning, cwd, input hashes,
  timestamps, trace source, coverage.
- Context: canonical resource ID, kind, declaration provenance, digest,
  planned vs observed load, native/inline/reference/on-demand, evidence
  pointer. Distinguish catalog entry from full skill content.
- Action: ordered sequence/time, tool name and redacted arguments, call ID,
  matching output ID, duration/exit/status, returned bytes or unknown,
  compaction window, observable assistant progress and artifact evidence.
- File: normalized path, operation (direct text read, search match, image,
  write, metadata-only or unknown), call ID, role/category, read count,
  repeated/read-after-compaction, returned bytes when attributable,
  reason and provenance, necessity judgment.
- Decision: explicit public action explanation when recorded, relevant
  instruction/fact, actual tool/action, result, subsequent action/outcome.
  Analyze the observable decision chain, NOT hidden model reasoning,
  private chain of thought or internal reasoning tokens as text. If no
  explicit explanation, label analyst inference and cite surrounding
  observable evidence; otherwise UNKNOWN. No invented rationale.
- Outcome: output path/hash, validator/render evidence, exact terminal
  receipt/SQLite state, required approvals, quality findings.
- Review: human judgment, criterion, evidence pointer, comment, verdict,
  reviewer/time; preserve separately from immutable analyzed records.

For Codex JSONL, pair function_call/custom_tool_call and corresponding
outputs by call_id; include tool event records only once. Handle async
exec_command/write_stdin via session identity when available. Track working
directory, explicit shell operands and shell variable values only when
deterministically resolvable. Parse cat/sed/head/tail/nl/jq direct operands,
redirections and recognized file-read commands; separate writes and pipe
stdin. Parse rg/grep output paths where explicit; do not claim every file
traversed. Count image paths from view_image. Mark dynamic shell expansion,
opaque scripts, truncated outputs, unmatched calls and unsupported commands
unclassified, not zero. Do not execute historical shell commands to infer
paths. A path mention is not proof of reading a file. Attribute bytes to
file only when reliably separable; otherwise report call-level output.
Deduplicate canonical aliases where known, not unknown relative paths.
Compaction does not itself prove a read; detect later observed rereads.

Trace sources may be incomplete: #744 neo-local local Codex log has no
visible remote tool calls or token-count records. A remote harness adapter
must provide authorized correlated remote trace, or mark tool/usage
coverage UNKNOWN. Do not infer zero reads or lower cost. #745 has visible
local calls; inputs/models differ, so these runs are diagnostic examples
not matched A/B. Redact secrets and private media; use bounded evidence
snippets with exact record pointers; original trace remains private.

## Human report layout

1. Summary: Context correctness, role behavior, outcome, efficiency and
   coverage; PASS/FAIL/UNKNOWN/NOT_RUN separately. Critical gates cannot be
   averaged away. Show planned versus observed startup context and actual
   delivery flags/global binding.
2. Files: sortable rows with path/category, first and repeated read count,
   returned bytes/unknown, trigger, explicit vs inferred cause, necessary/
   redundant/out-of-role/unknown, and evidence. Group by contracts, policy,
   Agent, skills, domain inputs, source code, generated output, image.
3. Timeline: time, observable decision/action, input or instruction,
   result, subsequent action, gap duration; compaction markers; render/
   validation attempts; links to bounded call/result excerpts. Reviewer can
   determine whether an action follows from evidence and whether an
   alternative documented route was available.
4. Comparison: same case/input/role/model/profile/reasoning, Agent hash,
   context policy, quality checks and comparable coverage. Show deltas for
   startup context bytes, calls/read/repeated reads, compactions, source
   exploration, original-media reads, render count, tokens (reported
   cumulative input, cached input, output separately), time to first artifact,
   total duration and outcome. Label different inputs/config and incomplete
   coverage; disable misleading deltas. Do not treat cached input as cost.
5. Human rubric: each row evidence-linked with PASS/FAIL/UNKNOWN,
   notes, suggested correction owner (Agent/Skill/Contract/Builder/upstream).
   Save verdict and findings separately. Allow browsing without new calls.

## Acceptance rubric and gates

| Gate | PASS condition | Failure example |
| --- | --- | --- |
| G1 Context | Global once, intended native suppression observed, selected resources exactly once, no undeclared mandatory role context | Editor receives Ponytail or duplicate AGENTS.md |
| G2 Role | Each material action in scope and supported by supplied evidence or explicit bounded gap remedy | Editor re-perceives original footage with sufficient metadata, studies Markcut implementation |
| G3 Decision/action | Observable action and next action supported by prior result, retries tied to specific new evidence, documented interface preferred | Repeated read-all after compaction, identical blind retry, unsupported transform guess |
| G4 Outcome | Actual artifact and role-specific quality validation, required approvals and execution-fenced terminal receipt | Missing render, bypassed review, completion inferred from process exit |
| G5 Analysis | Every supported call accounted for or marked unknown; all review findings reference actual evidence; no fabricated reasoning | Unmatched call silently discarded, missing remote calls counted as zero |
| G6 Human usability | Open report, filter category, inspect exact evidence, compare matched runs, save human verdict/notes without reading raw JSONL | Only raw log or one aggregate model score |
| G7 Efficiency | No redundant startup reads in matched case; no unnecessary source reads/perception when inputs suffice; report real measured deltas with preserved outcome | Faster run with worse result, unrelated input/model comparison |

G1-G6 and lifecycle safety are release gates; G7 includes required
role-boundary exclusions plus measured efficiency metrics (no arbitrary
duration guarantee). Unknown evidence cannot PASS a mandatory gate.
No model-generated score can override human evidence or durable state.

## Fixtures and verification

- Existing #745 replay (offline): identify 195 visible calls, 4 compactions,
  repeated protocol/contract/MVP reads, Markcut source paths and original
  versus final-render image reads. Exact counts must be derived by parser
  with explicit supported-coverage rules, not forced to earlier heuristic
  counts. Verify causal labels using instructions and observed action
  sequence. A human should identify the issue in one report without raw log.
- #744 incomplete trace: no visible remote tool/usage data => UNKNOWN; no
  misleading zero/delta. Verify matching trace identity and model metadata.
- Synthetic parser fixtures: pipe with stdin, multi-file cat, partial sed,
  relative paths, unknown shell expansion, file write, rg matches, no-match,
  output truncation, async calls, retries, compaction, malformed JSONL,
  redaction and unmatched/duplicate calls. Require deterministic results.
- Build fixture with implementation and editor using same native harness,
  assert actual context marker counts and selected role policy, and real
  terminal/negative cases. Preserve existing 44 baseline regressions.
- Migrate existing decision cases, including Vlog's 52 cases (20 Editor).
  Dry-run decisions are not actual file-read evidence. Keep real trace
  grading separate. Run controlled same-input/same-model Vlog comparison,
  hold handoff quality fixed, preserve final output checks; at least three
  matched runs per arm for generalized timing claims if feasible.
- Human usability trial: one reviewer opens the #745 report, finds the
  top redundant files, reviews one source exploration decision/action
  sequence, compares a matched fixture, records findings and verdict,
  and reopens them. No raw JSONL parsing or new model call needed.

No implementation or new model eval has been performed in this design
phase. Actual remote trace acquisition and native resume policy remain
integration gates; do not represent proposed commands as available.
