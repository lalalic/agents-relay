# Architect Design Handoff Contract — Job-native Markdown

- Use the `agents-relay` Skill for durable Job/Task state and the `agency-agents` Skill for a real resolvable Architect role. Requirements changes follow the `speckit-specify` Skill and `speckit-clarify` Skill.
- An Architect is a Relay Task, not a separate execution runtime. No mandatory repository design file or new Job lifecycle field is introduced.
- The original user goal and acceptance criteria stay intact in `Job.objective`; its single `## Architecture Design` section is the durable accepted design handoff. `Job.description` is not a substitute.
- `Architect Task.input` contains the design assignment, not the mutable answer. `Architect Task.result` contains the complete Markdown design, requirement traceability, choices, interfaces, tradeoffs, risks, recovery and verification evidence. A summary alone is insufficient.
- Dependent implementation must not proceed on missing, contradictory, unverified or out-of-scope design. The Planner verifies acceptance against the original objective; accepted design preserves its source Architect Task attribution and is read back from the updated Job.
- The objective must never silently discard concurrent changes, duplicate design sections or widen authorized scope. A new Job must explicitly carry forward the relevant verified design and provenance; no automatic inheritance is assumed.

The `agents-relay` Skill owns CLI procedures for the Architect Task, Planner handoff and Job update. This Contract owns evidence and provenance invariants.
