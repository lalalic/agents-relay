# Managed Task Execution Contract

- Use the `agents-relay` Skill’s bound Bootstrap exact execution-bound CLI for authoritative Task input, output, Job objective, acceptance criteria and execution identity.
- Preserve declared dependencies, assigned scope, workspace boundaries and review ownership.
- Verify durable results and artifacts against the Task acceptance criteria before success; artifact-changing Tasks require the separate Worker Self-Review Contract.
- The Task result must contain the outcome, root cause when applicable, and concrete validation evidence. Neither a message nor a file alone establishes accepted completion.
