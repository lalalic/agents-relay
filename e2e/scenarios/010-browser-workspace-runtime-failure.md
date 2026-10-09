# E2E-010 — Browser Workspace runtime dependency failure

## Objective

Inject a controlled real Browser Workspace runtime/tool dependency failure without permanently damaging shared packages. Run last among fault scenarios.

## PASS

- failure is classified as worker/tool/runtime evidence
- recovery repairs the dependency or routes to a usable worker according to policy
- exact original Task resumes/retries
- no manual lifecycle mutation and no false success
