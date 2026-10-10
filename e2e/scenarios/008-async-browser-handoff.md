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

Create a real asynchronous `chatgpt`/browser-capable implementation Task with the required `workerRequirements` and normal completion contract. Do not specify `--test-injection` yet: no async browser-handoff checkpoint is registered. The implementation Worker MUST NOT inspect or wait for `task.process.async_exited`: that is an asynchronous transport observation owned exclusively by the external Watcher. Perform workload and publish normal authoritative `task.completed`; absence of an in-flight transport event is NOT a business failure.

The Planner must encode this in the **structured `next_tasks` response**. The worker must not create its own replacement Task or manufacture failure events. The E2E controller judges only runtime evidence.
<!-- PLANNER-CONTRACT:END -->
