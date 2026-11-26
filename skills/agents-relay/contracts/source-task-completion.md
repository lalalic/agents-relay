# Git Source Task Completion Contract

- Source deliverables must satisfy the Task's acceptance criteria, declared self-review and verification requirements.
- A required source commit must be real, attributable to the exact execution with `Relay-Task: TASK_ID` and `Relay-Execution: EXECUTION_ID` trailers, and have a verified clean Git HEAD and valid ancestry.
- Use the `agents-relay` Skill's execution-fenced `task complete` CLI with the verified commit SHA; a branch name, dirty worktree, missing trailer or fabricated SHA is never sufficient.
- Relay alone validates and publishes `task.completed` for source Tasks requiring Git delivery. Do not publish successful completion directly through the `events-bus` Skill.
- Completion validation rejection is not success; repair and revalidate the same assigned work.
