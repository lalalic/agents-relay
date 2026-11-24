# Agents Relay Orchestrator Workflows

## Job context capture

Before `job create`, the orchestrator converts the relevant discussion into a standalone Markdown objective. Prefer `--objective-file`; if a diagram materially clarifies workflow/state/architecture/dependencies, put Mermaid first. The objective must be sufficient for a fresh orchestrator/agent to complete the Job without access to the original conversation. Creating the Job is the context-compaction boundary: important decisions must be copied into durable Job context before work is delegated.

## Job creation quality gate

Before **any Agent-issued** `job create`, including create-only and Coordinator Jobs, follow the [shared Job quality contract](task-job-contract.md#agent-created-job-quality-gate-before-job-create).

1. Confirm the user authorized the Job; a design discussion or Spec Kit exercise is not permission to execute.
2. Apply `speckit-specify` then `speckit-clarify` to formulate and assess the Job's Markdown objective, retaining prior user decisions and acceptance requirements. Do not ask for information already settled.
3. Invoke Relay's **built-in** `job-acceptance-reviewer` as an independent read-only Outcome Reviewer against the actual `spec.md`/Objective file, which must include the original user request and decisions. This Agent **extends `reviewer.agent.md`** (canonical Final Reviewer contract), not a copied role, and the generic Outcome Reviewer runs implicitly too:

   ```sh
   agents-relay review run --agents job-acceptance-reviewer \
     --project-path /absolute/project \
     --prompt "Preflight-review /absolute/project/spec.md against the original user request recorded in it. Verify completeness, ambiguity, scope, testable acceptance and future Final Review feasibility. Return PASS, CHANGE_REQUIRED or BLOCKED."
   ```

   Do not invent `job-preflight.md`. `--prompt` is a short instruction; the full specification is the actual `spec.md`/Objective Markdown, not an auxiliary prompt file. For standalone Jobs without `.specify/`, use the same Objective file that will become `--objective-file`. This uses the existing `review run` API, **not** a new mode or the immutable-head `review job` lifecycle.
4. Accept only `PASS` before `job create --objective-file --preflight=true`. On `CHANGE_REQUIRED`, the orchestrator corrects the Markdown and repeats preflight (bounded retries); on `BLOCKED`, missing reviewer execution or unresolved critical choice, stop and obtain the necessary information. Never label missing evidence as PASS. The exact CLI flag `--preflight=true` is mandatory for all new Jobs (normal, create-only, self/P0, Project Run); absent/false/other values produce `JOB_PREFLIGHT_REQUIRED` (exit 2) without persistence. No Job preflight field or separate lifecycle; the creator is accountable for the assertion.

The full file-producing Spec Kit Skills require a valid `.specify/` project in an authorized checkout. During earlier repository-independent dialogue, follow their requirements/clarification methods without pretending to have created files. The CLI/API enforces only the creator's exact preflight declaration; it does not independently verify Spec Kit quality or Outcome Review evidence and does not alter Relay's normal Planner, execution or immutable-head Final Review gates.

This contract defines orchestrator-owned exception workflows that sit above normal Agents Relay task/job execution.

## Reuse architecture from an earlier Job

For a follow-on or cross-repository Job, retrieve the relevant upstream Job through the version-matched Relay `job show --id UPSTREAM_JOB_ID` before Specify/Clarify and preflight. Bring forward the necessary `## Architecture Design` Markdown from the upstream **Job objective** (including source Job/Architect Task attribution) into the new Job objective, together with its own scope and acceptance criteria. Do not rely on prior repository files or thread memory, infer that new Jobs automatically inherit design, or treat a previous Architect recommendation as a user authorization to enlarge scope. If design changes the user's decisions, clarify and review the new proposal before creation.

## Review-driven JEL continuation

After the Initial Plan materializes its Tasks, Relay waits for **all non-review Tasks to be terminal**, including Troubleshooter recoveries. The Final Reviewer reads every Task result (including FAILED and CANCELLED), the original Job objective, the immutable head and test evidence. An outstanding required failure must be reported as a finding and cannot pass the merge gate. The Final Review is the **completion check**; do not schedule a second Planner merely to ask whether the objective is satisfied.

`review.approved` with valid durable evidence permits Relay-owned merge/delivery. `review.changes_required` persists the immutable Reviewer's findings in the Job and initiates a **new Planner round**, whose sole automatic objective is to address those findings with the minimum necessary revision Tasks. Once those Tasks terminate, repeat Final Review. No speculative verification Task or separate completion-check Planner is allowed. Preserve older targeted-revision histories for restart compatibility; new Review rounds should use the Review → Replan path. A real blocker/recovery may use its separate canonical trigger without pretending to be a Review finding.

## Normal managed Job start workflow

For a normal managed Job, the preferred bootstrap is one command:

```text
job create --initial-plan
  -> durable plan-N
  -> Planner next_tasks
  -> Relay materializes Tasks
  -> normal routing, execution, and reconciliation
```

Without `--initial-plan`, `job create` remains create-only and establishes durable Job state without execution. `agents-relay plan` remains available for an existing create-only Job. Unless the user explicitly requested **create-only / no execution**, the orchestrator should use `job create --initial-plan` rather than issuing two separate commands.

The initial decomposition belongs to that durable Planner round. The orchestrator must not hand-author the initial child Task batch as a substitute. If initial planning fails, the create command fails visibly after preserving the durable Job/Plan evidence; the orchestrator must not silently invent Tasks. Every Job follows this same objective-driven lifecycle. After a completed implementation batch, Relay automatically creates subsequent Plan rounds until the latest successful Plan reports `objective_status: satisfied`; there is no fixed/autonomous execution mode or Job scheduling.

## P0 / self job workflow

For a self Job owned by the current XChat thread, resolve the current thread ID
before creating the Job. If it cannot be retrieved reliably, ask the user for
the thread ID before proceeding. Set `creatorThreadId`,
`implementationThreadId`, and `reviewerThreadId` to that same thread ID at
creation, using the corresponding `--creator-thread-id`,
`--implementation-thread-id`, and `--reviewer-thread-id` options. Do not infer
the thread ID from an unrelated worker, execution, or previous conversation.

P0/self work is ordinary durable Relay work. The orchestrator may choose normal
Task requirements, but every newly created work Task is executable by a
worker/model route selected by Execution Router. Relay has no privileged
orchestrator-worker lifecycle, and new Task creation rejects
`adapter: orchestrator`. P0/self jobs do not require the normal reviewer gate
unless the user explicitly asks for review; Relay-owned merge and completion
lifecycle remain in their canonical graphs.

For legacy Tasks with an unsupported runtime or unknown execution outcome,
inspect the actual state and supported recovery options using the matching
Relay CLI. Do not edit task records, infer completion, or relaunch uncertain
executions directly. Report a concrete blocker if CLI recovery cannot proceed.

`job create --initial-plan` remains the normal way to create durable planning
state and hand subsequent execution to Relay.

## Merge completion vs deployment evidence

For a managed Job, Relay owns Job completion. Successful implementation evidence, an applicable SHA-bound approved Final Reviewer Task (or a satisfied Plan/Coordinator gate), and a verified local merge/delivery receipt when a merge is required are mandatory. A historical failed Planner *alone* must not override a later valid immutable-head Final Review. For older reviewed Jobs that lack `localMerge`, derive a pending merge request only from verified checked-out source ref and exact reviewed SHA and persist it through SQLite CAS; never mark completion simply because `autoMerge=true`. A GitHub merge alone is not proof of Job completion; verify the outcome with the Relay CLI. Deployment code must not invent another completion gate after durable Job completion.

Post-merge publication and deployment activity is separate from Job lifecycle. Events or evidence such as `package.published`, published version metadata, service restart, and deployment verification may be attached after the Job is already `COMPLETED`; they must not hold the Job open, reopen it, or redefine completion. If post-merge deployment needs remediation, record that as separate deployment/recovery work rather than mutating the completed implementation Job lifecycle.

## Live acceptance after publication

Use **publish-first live acceptance** when verification genuinely requires a running published build, real provider/account, device, or runtime. The Planner completes available build/isolated tests and mandatory pre-merge gates, then hands off unrun live-only scenarios as explicit `NOT_RUN` / `PENDING_POST_PUBLISH` evidence, not successful tests. Do not let a live-only check become a pre-merge Task or repeated Plan round just because its environment is unavailable. Independent Final Review and normal Relay merge/delivery remain mandatory.

After a **verified** publication/deployment receipt, the orchestrator uses the handoff to run supported live checks and monitor health if capable and authorized. A persistent watcher requires a real scheduled automation/monitoring mechanism; never promise background execution without creating one. If the scenario requires a user action or unsupported device/account, provide a concrete manual-acceptance checklist and request/reminder rather than holding the completed code Job open. Record exact version, test owner, evidence and final status separately; failures trigger a new post-release fix/rollback workflow. Security, legal, data-loss and explicit pre-release approval requirements are **not** deferrable under this policy.

If a PR closes without merge, check the Job state through Relay CLI; do not infer a successful completion.
