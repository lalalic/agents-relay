# Agents Relay Unified Task Event Contract

**Scope:** Relay-specific event meaning and validation. This does **not** define Events Bus transport. The bus only handles generic event identity, type, timestamp, routing as needed, and opaque `data`. No Events Bus change is required when Relay adds agent roles or payload fields.

## Producer contract

Every Implementation, Reviewer, and Troubleshooter execution publishes `task.started`, optional `task.progress` or `task.heartbeat`, then **exactly one** agent terminal event:

- `task.completed`: assigned responsibility finished and its role-specific output is durable, regardless of whether a reviewed artifact passed.
- `task.failed`: assigned responsibility could not be fulfilled; include failure phase, reason, and evidence in `data`.

`task.blocked` and `task.unblocked` are **Relay-owned lifecycle facts**, not agent terminal outcomes. Transport acceptance is not proof Relay accepted the transition. Every lifecycle event must use the exact Job, Task, and execution source identity provided by Relay; stale/duplicate execution events cannot change current state.

## Role-specific completed data

| Role | `task.completed.data` | Relay action |
| --- | --- | --- |
| Implementation | Evidence of output/artifact, validation, and summary as required by the Task | Persist Task success and continue dependencies/review |
| Reviewer | `verdict` (`approved` or `changes-required`), exact immutable `head_sha`, actionable `findings` as necessary | Validate current immutable review target and apply verdict; defects are a successful Reviewer execution, not `task.failed` |
| Troubleshooter | Recovery action and durable evidence of verified original Task retry, blocker-Job handoff, or other authorized recovery | Complete recovery Task only; original Task state changes through separately authorized Relay operations |

A Reviewer must **not** publish unstructured `task.completed`: missing verdict or immutable head is invalid. Relay normalizes an authenticated structured Reviewer terminal event into its internal Review decision; native `review.*` events may be accepted for backward compatibility.

## Troubleshooter human escalation

Only a real user action merits escalation. Troubleshooter invokes the Relay escalation operation, specifying the required action, resolution condition, and diagnostic context. Relay durably records the human action and blocks **the Troubleshooter Task**, leaving the original failed Task `FAILED`. This is a Relay state transition, not a third agent terminal event.

When the human responds, the **Troubleshooter Task** is authoritatively unblocked and resumed with its prior context plus the response. Troubleshooter independently verifies resolution, requests an authorized original Task recovery, and only then publishes its own `task.completed`. If unresolved, it continues diagnosis or escalates again; human assertion alone is not technical verification.

See [task-recovery-flows.md](task-recovery-flows.md) for unified architecture, overall flow, failure recovery, and post-blocked resumption.

Reviewer unavailable evidence is an execution failure (`task.failed`), not a blocked Task. Legacy Reviewer verdict `blocked` is normalized to failure and must dispatch Troubleshooter. Only Relay blocks a Troubleshooter during human escalation.

A host-mediated interactive invocation is a separate Relay-controlled wait. It requires an already-bound `interactiveInvocation` with status `awaiting_decision`. It is not permission for a Worker or Reviewer to choose a blocked terminal outcome.

A legacy Job-level `review: blocked` gate is reset to `pending` only after authoritative `task.unblocked` metadata exists on its bound Reviewer Task and the immutable review head still matches. The same Reviewer Task then resumes without creating a duplicate.
