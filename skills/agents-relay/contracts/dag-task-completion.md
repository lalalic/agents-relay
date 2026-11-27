# DAG Task Completion Contract

- A DAG child must write a valid structured result to its declared output, including `status`, `output`, `artifacts`, existing artifact paths and the owning Project's Stage schema.
- Use the `agents-relay` Skill’s bound Bootstrap execution-fenced `task complete` CLI for success; pass the exact Job, Task and Execution identity, without a commit SHA.
- Only Relay may publish this Task's `task.completed` after validating the result and committing Graph/SQLite state. The Worker must not publish successful completion directly using the `events-bus` Skill.
- A rejected completion is not success. Correct repairable output or validation problems in the same execution.
