# E2E-010 — Browser Workspace runtime dependency failure

## Objective

Inject a controlled real Browser Workspace runtime/tool dependency failure without permanently damaging shared packages. Run last among fault scenarios.

## PASS

- failure is classified as worker/tool/runtime evidence
- recovery repairs the dependency or routes to a usable worker according to policy
- exact original Task resumes/retries
- no manual lifecycle mutation and no false success
- this covers the PR #49/browser-workspace-session-daemon gap: the durable original
  business Task is the only implementation owner, and the Job reaches review,
  local merge, and `COMPLETED` without a sibling replacement Task

<!-- PLANNER-CONTRACT:START -->
## Mandatory Planner contract

Create exactly one original implementation Task requiring ChatGPT browser workspace (`"workerRequirements":{"runtime":"chatgpt","capabilities":["model","browser-workspace"]}`), with `maxAttempts` at least 2. On that Task only, set the structured Task JSON field `"--test-injection":{"method":"browserWorkspace.command","action":"throw","execution":"skip","error":{"code":"BROWSER_WORKSPACE_UNAVAILABLE","message":"E2E browser-workspace runtime dependency unavailable","status":503}}`. Put this field in the structured `next_tasks` entry alongside `id`, `input`, `output`—NOT inside `input`. At the real Browser Workspace CLI invocation boundary the adapter consumes this once, reports an ordinary launch/runtime failure, and Graph must recover the original Task. Do not fabricate browser failure events or run browser CLI probes to assert an outage.

The Planner must encode this in the **structured `next_tasks` response**. The worker must not create its own replacement Task or manufacture failure events. The E2E controller judges only runtime evidence.
<!-- PLANNER-CONTRACT:END -->
