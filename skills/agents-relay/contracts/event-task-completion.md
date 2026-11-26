# Event Task Completion Contract

- The assigned responsibility, outputs and acceptance evidence must be durable before a terminal success event.
- Use the `events-bus` Skill to publish Worker-owned terminal events and the `agents-relay` Skill to verify Relay accepted the exact execution outcome.
- Publish exactly one terminal outcome, `task.completed` on verified success or `task.failed` on failure with phase, reason and evidence.
- `task.completed` must meet the role-specific result schema: Reviewer needs immutable `head_sha`, `verdict` and actionable findings; Troubleshooter needs durable recovery evidence. Review defects are a successful `changes-required` verdict, not Worker failure.
- Process exit or generic transport acknowledgement alone does not establish Relay completion; never invent execution IDs or claim an unverified terminal state.
