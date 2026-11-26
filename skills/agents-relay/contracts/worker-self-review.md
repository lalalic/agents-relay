# Artifact-changing Worker Self-Review Contract

- An artifact-changing Worker owns implementation, independent self-review, correction and re-review of its own deliverable within the same assigned Task.
- Self-review must consider the full durable Job objective, Task acceptance criteria, actual artifact or diff, quality, correctness, edge cases, privacy, security, regressions, and relevant tests or user-style checks.
- Every actionable finding requires correction and a complete new self-review. No preset number of rounds or a successful build alone establishes an accepted result.
- Report the number of rounds, findings, fixes, verification evidence and the latest complete no-changes-required verdict. Unresolved actionable findings or required checks must be reported as evidenced failures, not success.
- Self-review does not replace independent Final Review, human approvals or Graph-managed gates; never approve one's own Final Review or fabricate evidence.
- Read-only Tasks validate findings, not invented artifact modifications or review rounds.
- For DAG children and Git source completion, use the `agents-relay` Skill and the corresponding declared Completion Contract; only Relay may emit their successful terminal events. For Worker-owned failures use the `events-bus` Skill.
