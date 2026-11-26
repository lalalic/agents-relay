---
name: worker
description: Reusable Worker Agent and execution Contract profile; runtime selects its Contracts for every Job Task.
startup_contracts: [relay:skills/agents-relay/contracts/worker-lifecycle.md]
eval_contracts: [relay:skills/agents-relay/contracts/evaluation-safety.md]
assignment_contracts: [relay:skills/agents-relay/contracts/task-execution.md]
dag_contracts: [relay:skills/agents-relay/contracts/dag-task-completion.md]
source_contracts: [relay:skills/agents-relay/contracts/source-task-completion.md]
event_contracts: [relay:skills/agents-relay/contracts/event-task-completion.md]
artifact_contracts: [relay:skills/agents-relay/contracts/worker-self-review.md]
---

# Relay Task Execution Contract Profile

This Agent declares the shared Contract set for Relay-managed Job Tasks.
The Task harness automatically applies **only these Contract declarations**
to every Job Task, without changing that Agent's extends chain or
injecting this Worker role body.

An Agent may also write `extends: worker` as ordinary Agent inheritance.
That explicitly inherits this Agent's body and metadata; the Loader
deduplicates Contracts already selected by the Task execution layer.
The authoritative Task output kind chooses the applicable completion
Contract from this file's declarations.
