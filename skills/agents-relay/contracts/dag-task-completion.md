# DAG Task Completion Contract

## Validate declared output

Write the complete DAG result to the Task's declared output. Verify
its structured `status`, `output` and `artifacts` fields, referenced
artifact file paths and the project-declared Stage schema. A nonempty
file alone does not satisfy the Task. Preserve exact execution identity.

## Complete through the authorized CLI

Call the matching Relay CLI:

```sh
agents-relay task complete --repo {{repository}} --id {{jobId}} --task-id {{taskId}} --execution-id {{executionId}} --summary 'Validated DAG result'
```

Never pass `--commit-sha` or directly publish `task.completed`.
The daemon validates result/artifacts, commits Graph/SQLite state and
publishes completion. Repair validator rejection in the same execution.
