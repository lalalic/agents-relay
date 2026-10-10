# E2E-008 — Async browser-worker transport handoff

## Objective

Run an async browser worker whose submission transport exits before business completion.

## PASS

- transport exit alone is neither Task success nor failure
- Task remains active until a correlated authoritative terminal event
- no duplicate worker launch while the async execution is live
- final terminal event controls durable outcome

<!-- PLANNER-CONTRACT:START -->
## Mandatory Planner contract

Create a real asynchronous `chatgpt`/browser-capable implementation Task with the required `workerRequirements` and normal completion contract. Do not specify `--test-injection` yet: no async browser-handoff checkpoint is registered. Observe actual transport-vs-terminal behavior.

The Planner must encode this in the **structured `next_tasks` response**. The worker must not create its own replacement Task or manufacture failure events. The E2E controller judges only runtime evidence.
<!-- PLANNER-CONTRACT:END -->
