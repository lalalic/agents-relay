# E2E-010 — Browser Workspace runtime dependency failure

## Objective

Inject a controlled real Browser Workspace runtime/tool dependency failure without permanently damaging shared packages. Run last among fault scenarios.

## PASS

- failure is classified as worker/tool/runtime evidence
- recovery repairs the dependency or routes to a usable worker according to policy
- exact original Task resumes/retries
- no manual lifecycle mutation and no false success

<!-- PLANNER-CONTRACT:START -->
## Mandatory Planner contract

Create an implementation Task requiring the browser-workspace runtime, with explicit expected terminal behavior. Do not set `--test-injection` until a browser-workspace rejection checkpoint exists; do not fake browser failures in Task output.

The Planner must encode this in the **structured `next_tasks` response**. The worker must not create its own replacement Task or manufacture failure events. The E2E controller judges only runtime evidence.
<!-- PLANNER-CONTRACT:END -->
