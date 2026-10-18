# Planner CLI Action

Planner only decomposes objectives into independently verifiable Tasks and creates one Task Tree. Relay owns state, scheduling, review, retries and recovery.

Existing `agents-relay plan --repo … --pr … --id …` starts/reuses a planning round. Existing job/task CLI reads remain unchanged.

## One additional action: `plan apply`

`agents-relay plan apply --repo OWNER/REPO --pr PR_NUMBER --id JOB_ID --plan-id PLAN_ID --execution-id EXECUTION_ID --file plan.json`

The CLI uses the existing Graph/schema checks and Planner persistence path. It validates the whole Task Tree, writes all children and the result in one SQLite transaction, or rejects the submission without partially creating Tasks. The caller must match the active Plan execution. An error is returned to the SAME Planner agent; it fixes its proposal and retries within that execution, without creating another Plan. Success produces persisted Task IDs. Completed Plan submissions cannot be applied twice.

The Planner must not manage execution, schedule recovery, run review, or mark Job Completed. Existing JSON-result planning remains a fallback when no Plan execution context is available. `changes-required` is a successful Reviewer verdict, not a task execution failure.
