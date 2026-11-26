# Git Source Task Completion Contract

## Validate source, artifacts and attribution

Check the full Task acceptance and actual changed source and artifacts,
run relevant verification and finish any declared self-review requirement.
Create a real Git commit of authorized changes with the required
`Relay-Task: TASK_ID` and `Relay-Execution: EXECUTION_ID` trailers.
Verify commit SHA, exact trailers and declared artifact evidence; never
substitute a branch name, uncommitted diff or fabricated revision.

## Complete through the authorized CLI

Call the same-version `agents-relay task complete` with exact repository,
Job, Task and Execution IDs; pass `--commit-sha` for the actual verified
commit and an evidence-backed summary. Do not publish `task.completed`
directly. Relay validates the source commit and artifacts, commits the
Graph/SQLite outcome and publishes the correlated terminal. Rejection
is not success; repair the rejected deliverable and revalidate.
