# Planner CLI Action

Planner only decomposes objectives into independently verifiable Tasks and creates one Task Tree. Relay owns state, scheduling, review, retries and recovery.

Existing `agents-relay plan --repo … --pr … --id …` starts/reuses a planning round. Existing job/task CLI reads remain unchanged.

## One additional action: `plan apply`

`agents-relay plan apply --repo OWNER/REPO --pr PR_NUMBER --id JOB_ID --plan-id PLAN_ID --execution-id EXECUTION_ID --file plan.json`

The CLI uses the existing Graph/schema checks and Planner persistence path. It validates the whole Task Tree, writes all children and the result in one SQLite transaction, or rejects the submission without partially creating Tasks. The caller must match the active Plan execution. An error is returned to the SAME Planner agent; it fixes its proposal and retries within that execution, without creating another Plan. Success prints the persisted Plan JSON and Task IDs. The Planner then returns the separate `PLAN_APPLIED:<plan-id>:<execution-id>` final receipt. Relay accepts that receipt only when the same Plan is already `SUCCEEDED` in authoritative SQLite. Completed Plan submissions cannot be applied twice.

The Codex Planner runs with `workspace-write` sandbox access and an additional writable directory containing the unified Relay SQLite database. This is required for the guarded CLI action to commit. The Planner still cannot write lifecycle state directly; `plan apply` validates and commits through Relay's normal persistence path.

The Planner must not manage execution, schedule recovery, run review, or mark Job Completed. A missing durable Plan/execution identity is a contract error; JSON-only responses are never a substitute for authorized CLI apply. `changes-required` is a successful Reviewer verdict, not a task execution failure.
