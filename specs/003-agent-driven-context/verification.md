# Refactor verification and Evals plan

Baseline evidence: [research.md](research.md). This is a proposed verification
plan; only the existing 44-test baseline and earlier native prompt-input
probes have been run. No new implementation, model eval or Vlog run is claimed.

## P0. Report-first acceptance

Before modifying production context selection, generate the actual #745
Job report and Task 2370 report from existing records. Verify immutable
execution identity and attempt attribution, visible call/compaction totals,
read evidence, public action/result timeline, lifecycle and artifact
evidence. Run the #744 incomplete trace and synthetic parser negatives;
unknown data must remain unknown. Review using the rendered report alone,
save a concrete finding and reopen it. Compare two matched fixture reports
and reject misleading cross-input/config/coverage deltas. No inference
or production mutation required. Actual implementation and this acceptance
are NOT_RUN in the design phase.

## A. Deterministic native tests (pre-merge)

Extend the existing suites, avoiding a second backend or duplicate test runner.

| Case | Test owner / expected result |
| --- | --- |
| A1 Layering, same-name/absolute external inheritance, relative links | native_agent_content_resolver: effective required lists follow existing overlay order; omitted inherits; explicit list replaces; explicit [] clears; differently named and absolute external parents preserve declarations; invalid cycles/namespace/path/symlink/missing resource fails. Existing tests unchanged in purpose. |
| A2 Context selection and de-duplication | native_shared_worker_context + focused unit tests: fixture unique global, parent, project, role, skill and contract sentinels; implementation selects only declared resources; editor has no implementation/parent/project baggage; same selected resources for neo/openai/zai/deepseek profiles; checkout vs canonical project resolution tested. |
| A3 Rendering and inspection parity | native_agent_prompt_builder / cli prompt tests: production and inspect same plan, stable order and single resource body/ref, no generic repeated-read instruction; safe evaluation envelope does not produce authorized CLI/events. Missing required field/path rejects before launch. |
| A4 Role isolation | Fixture matrix: default unnamed implementation, named implementation, planner, reviewer, job-acceptance-reviewer, review-chair, troubleshooter, Vlog editor/director/publisher, script agent unaffected. Test role requirements, only actual implementation self-review contract, no lower-quality loophole. |
| A5 Lifecycle | Existing native_codex_worker, native_codex_planner, native_eight_batch_context_publication: exact start/progress/terminal, Plan apply receipt, DAG/source completion validation, stale execution, negative output/result, independent Final Review, no false success. No role metadata can remove envelope. |
| A6 Launch/continuation | native_codex_thread_routing, native_all_codex_permissions: actual fresh/planner/resume/repair argv carry project_doc_max_bytes=0; provider/profile flags and permissions retained. Same-policy continuation accepted, context-policy mismatch uses existing safe recovery, never replay side effects. |
| A7 Neo XChat bootstrap | Neo CLI delegates to its XChat Builder, which obtains canonical Global, XChat rules and Skills through Relay \`prompt --parts-stdin\`, validates content fingerprint and renders JSON/Markdown/--project; missing Global fails closed, no \`CODEX_HOME\` mutation. Relay rejects unsupported XChat Worker adapter. |
| A8 CI | Add focused native context/prompt integration tests to existing Rust CI. No test points at canonical store or production services. Docs and fixture paths reference Rust commands, not deleted npm targets. |

Check all role requirements against selected effective metadata, not simply
absence of words in an opaque generated prompt. For duplicates, use resource
identity plus full sentinel occurrence, not filename mention counts (a path
can occur as evidence without a second content load).

## B. Native Codex context contract (pre-merge)

Create a disposable CODEX_HOME and Git fixture tree, no credentials or model
calls required. Make separate uniquely marked global, project, parent,
nested, override, Agent and skill documents. Use installed Codex
debug prompt-input with the exact relevant launch config. Verify:
- default native Git traversal/override behavior, configured global linkage;
- project_doc_max_bytes=0 removes all implicit project instructions but not
  global; the selected project policy explicitly supplied by builder appears
  once for implementation, absent for Editor;
- native skill catalog discovery is not the same as full skill body loading;
- missing Global link is created automatically, an empty prior file is
  backed up, repeat setup is idempotent, and a conflicting nonempty file
  or override is rejected without overwriting user data;
- actual worker/planner launch option construction from production code
  rather than a handwritten equivalent; fresh and resume argv fixture proof
  plus real new-thread/resume probe separately if supported.

Additionally test three logical prompt layers. Compare default Codex base
instructions with trusted developer_instructions delivery (excluding
expected dynamic fields); prohibit base replacement via instructions or
model_instructions_file. Verify configured profile developer instructions
are preserved/explicitly composed, actual native Global message placement,
ordinary Task user message, and no elevation of untrusted task facts.
A two-task fixture checks stable Agent instruction identity and distinct
Task binding. Reference-trigger fixtures exercise relevant vs irrelevant
reads, including required-reference missing failure without bulk reads.
XChat records actual user/bootstrap transport, not a fictional system role.

Capture version, exact redacted config/argv, sentinel counts, result and
fixture isolation. Do not label debug prompt-input as real task execution.
If a Codex version changes config behavior, fail the context contract gate
and investigate rather than silently falling back.

## C. Role-behavior Evals (read-only)

Reuse the existing skill capability fixtures/runner patterns and production
context selection. Refresh obsolete references; do not revive Node
backend or create a parallel registry. Detached eval inputs have no real
execution ID or event permission. Evaluation must use read-only fixture
paths, not production stores, external side effects or live credentials.
Compare intended actions with explicit acceptance constraints.

| Eval | Required behavior | Forbidden behavior |
| --- | --- | --- |
| Implementation | Reads selected dev policy and Ponytail, performs role review, validates durable result | skips required implementation checks; works on main |
| Editor, complete upstream metadata | Uses metadata and Director handoff, documented CLI/DSL/recipes, final-render QA | reads Markcut implementation or routine original image/contact sheets; runs dev review loop |
| Editor, missing orientation/segment evidence | Names exact evidence gap and follows role's bounded domain remedy | fabricates source facts, arbitrary source exploration or claims completion |
| Planner | Exact plan context and apply receipt, Agent-specific planning requirements | emits Task terminal event, duplicates builder policy |
| Reviewer | Immutable target, no artifact edits, verdict independent of implementation | inherits development repair loop |
| Troubleshooter | Concrete recovery evidence and exact bindings | blind retry, fabricated event acceptance |
| Context after compaction | Uses current authoritative assignment, checks needed facts only | restarts mandatory read-all contracts or assumes old execution remains valid |
| Unsupported/missing dependency | Bounded explicit configuration/role failure | silently adds generic dev resources or invents access |

Dry-run model responses are advisory evidence, not execution outcomes.
Separate fixture-level assertions (zero prohibited resource selection) from
model compliance (actual tool transcript). Grade each selected fixture;
record provider/profile/model/reasoning, exact Agent version, prompt
fingerprint, tokens, calls, result. No claims about unavailable live provider
or real Claude runtime.

## D. Controlled end-to-end acceptance

After implementation review and deployment authorization, first launch
an isolated Codex test through native Relay in a disposable store with real
provider/model and unique fixture. Assert authoritative Task state, matching
execution event acceptance, actual produced artifact and real JSONL startup
sentinel counts. Test fresh and safe resume with no duplicate side effects.
Repeat with neo-local and one configured alternate provider only if available;
harness is the same. Never substitute a browser submission receipt for completion.

Then run a controlled Vlog A/B (same media set, same model/profile/reasoning,
same accepted metadata/handoff, fresh run paths, no review/publication,
identical output quality criteria) before and after refactor. Domain follow-up
for Visioner corrected asset/segmentation must be measured separately or
held fixed in both arms. Preserve media and previous outputs; no production
publication. Use the existing private Run workflow, not a test-only DAG.

Measure start-to-first-artifact, total task duration, input/output tokens,
compactions, direct file-read calls, repeated contract reads, source-code
search/reads, original-image view calls, final-render checks and render count.
Inspect actual JSONL call/output pairs; recursive search output is not every
filesystem syscall. Record output file hashes, stage validator and real
render/frame/audio evidence, stating any subjective audio verification gap.
Target: no duplicate mandatory context, no routine framework implementation
reads or source re-perception when handoff is sufficient, and no regression
in editorial correctness or completion authority. Timing improvement is an
observed metric, not a fixed success claim. Use at least three matched runs
per arm for comparative speed claims where cost/time allow; otherwise report
individual trials without generalizing.

Real XChat handoff and Claude are separate gates; XChat fixture is not a real
WebChatGPT bootstrap. No Claude E2E until that harness is implemented.

## E. Human-reviewable trace acceptance

Implement and test [agent-eval-design.md](agent-eval-design.md): offline
#745 replay, deliberately incomplete #744 remote trace, synthetic parser
fixtures, context sentinels, matched report comparison, evidence-linked
human review trial and private/redacted persistence. Observable decisions
and results, not hidden chain of thought, are the review evidence.
No model calls required for inspection or human grading. Existing native
tests and real role outcome remain required.

## F. Delivery and audit

Check architecture lens: no workflow authority moved to builder; shared
selection used by all entry points; no SQLite rewrite or fixed Neo paths in
generic Relay. Verify docs/Agent contract ownership, role dependencies,
manifest references and removed duplicate instructions. Independent
implementation review and scoped tests before merge. Only deploy using
normal reviewed release with safe live checks and no disruption of active
Jobs. Keep exact test commands/results and explicitly mark NOT_RUN for
unexecuted live gates. This branch currently contains design documents only.
