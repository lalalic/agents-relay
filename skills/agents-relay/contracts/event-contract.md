# Agents Relay Unified Task Event Contract

**Scope:** Relay-specific event meaning and validation. This does **not** define Events Bus transport. The bus only handles generic event identity, type, timestamp, routing as needed, and opaque `data`. No Events Bus change is required when Relay adds agent roles or payload fields.

## Execution event source

The caller-configured Events Bus protocol owns the public event-publish transport format. Relay's contract specifies only Task lifecycle meaning and execution identity. Its `source` field is a **string** identifying the exact current Relay execution:

```text
source = "job/<job-id>/task/<task-id>/execution/<execution-id>"
```

When using a provider's event command facade, follow its configured schema and preserve the exact `{type, source, data}` contract. Do not invent an object such as `{ "source": { "id": "..." } }`; `source.id` belongs only to an internal Events Bus envelope.

Relay supplies the complete source string in the managed Task context. Agents must copy it unchanged; they must not infer a Job/Task ID, generate an execution ID, or reuse an identity from a previous attempt. Transport acceptance alone does not establish that Relay accepted the event for the current execution.

## Producer contract

Every Implementation, Reviewer, and Troubleshooter execution publishes `task.started`, optional `task.progress`, then **exactly one** agent terminal event:

`task.started` and `task.progress` reset the Task inactivity timeout only when Relay accepts the event for the exact current execution. Progress is nonterminal, must be newer than the last accepted progress event, and cannot extend a terminal or stale execution.

- `task.completed`: assigned responsibility finished and its role-specific output is durable, regardless of whether a reviewed artifact passed.
- `task.failed`: assigned responsibility could not be fulfilled; include failure phase, reason, and evidence in `data`.

`task.blocked` and `task.unblocked` are **Relay-owned lifecycle facts**, not agent terminal outcomes. Transport acceptance is not proof Relay accepted the transition. Every lifecycle event must use the exact Job, Task, and execution source identity provided by Relay; stale/duplicate execution events cannot change current state.

## Role-specific completed data

| Role | `task.completed.data` | Relay action |
| --- | --- | --- |
| Implementation | Evidence of output/artifact, validation, and summary as required by the Task | Persist Task success and continue dependencies/review |
| Reviewer | `verdict` (`approved` or `changes-required`), exact immutable `head_sha`, actionable `findings` as necessary | Validate current immutable review target and apply verdict; defects are a successful Reviewer execution, not `task.failed` |
| Troubleshooter | Recovery action and durable evidence of verified original Task retry, blocker-Job handoff, or other authorized recovery | Complete recovery Task only; original Task state changes through separately authorized Relay operations |

A Reviewer must **not** publish unstructured `task.completed`: missing verdict or immutable head is invalid. Relay validates the Reviewer verdict; read the accepted review outcome through the matching Relay CLI.

### Targeted review findings and original Task revisions

The automatically created `job-acceptance-reviewer` (historical `reviewer` records remain valid) owns the integrated Job acceptance gate, not the Implementation Agent's self-review. For blocking findings with an unambiguous original succeeded Task owner, its *active execution* calls `agents-relay task revise --repo ... --id ... --task-id ORIGINAL --review-task-id REVIEW --execution-id REVIEW_EXEC --head-sha REVIEW_SHA --request-id STABLE_ID --findings-file PATH`. A findings file is a JSON array of identified `{id, summary, evidence?}` items. Relay rejects stale execution/head, unsupported owner or conflicting request ID, and transactionally appends `review.feedback` comments and one targeted child per owner/Review round. The CLI receipt is evidence of request persistence, **not** repair or completion. The Reviewer then publishes its single correlated `task.completed` verdict `changes-required` with matching `findings` and immutable `head_sha`; the Review Graph authorizes scheduling only when all blocking findings have durable owners. No direct `task.blocked`/`task.unblocked` event is emitted by the agent.

A fix child reports its **own** correlated completion after verified repair. Downstream `dependencyValidity` policy is `order-only` by default, or explicitly `revalidate`/`rerun` per declared input. All changed upstream generations must settle before a fan-in consumer can verify or rerun. Relay derives successful revision lineage from durable Task results, then creates another fresh immutable-head Job Acceptance Review. A partially submitted message, unverified terminal, historical result or stale source SHA does not count as a fix or approval.


## Interactive Task suspension

For a managed human Preview the current Agent Task calls
`agents-relay review interactive --path ABS --id JOB --task-id TASK --execution-id EXEC`.
The host may expose `review.preview`; it renders and delivers without managing
Task state. Relay binds one review to that Task Execution ID, persists
`RUNNING -> AWAITING_DECISION`, releases the execution lease, accepts a
correlated decision, and requeues **the same Task**. The Agent does not call the
low-level Review lifecycle commands, invent an invocation ID, or emit another
waiting/terminal event on behalf of its host. An inbox acknowledgement is not
approval. No Git commit, content snapshot or SHA is required for human Review.

For new DAG executions, the Coordinator creates normal Agent Tasks; a review
belongs to the corresponding Agent child, not the Coordinator. The ordinary
Reconciler (not the external Shortcut start CLI) schedules their retries and
revisions. A Script Task on `changes_requested` may use its own Agent Model
executor in a **new execution of that same Task**; after a fresh approval,
Script verifies the revised artifacts. Legacy running Shortcut checkpoints
retain the earlier foreground-runner resume behavior until completion.

The Job stays ACTIVE; the Task does not requeue until a matching
`task.interactive_decision` is durably accepted and the Task Graph selects
`interactive.resume` -> QUEUED. Retries and daemon restarts must not create
another Task. Cancellation remains legal while awaiting a decision.

The invocation record holds immutable request/revision identity and the
decision outcome. Its status is not the authority for the Task execution
lifecycle; Task.state is. The older overloaded DRAFT waiting snapshots
are normalized to AWAITING_DECISION during Relay durable-state initialization.
Do not use `task.blocked` to suspend an interactive Task.

## Generic interactive decision event (human review)

**Canonical type:** `task.interactive_decision`. This is a human decision for an in-progress Task (video preview, document review, image approval, etc.), **not** an Implementation terminal event or a Job Final Reviewer verdict. A host review UI is a generic publisher: it receives a caller-supplied template and fills only the declared review-result fields. It must not invent Task/Execution/source identity or a new Relay-specific event type.

**Producer event template**, based on the exact managed Task execution context (illustrative identities only):

```json
{
  "type": "task.interactive_decision",
  "source": "job/556/task/producer/execution/exec-abc",
  "data": {
    "interactive": {
      "jobId": "556",
      "taskId": "producer",
      "executionId": "exec-abc",
      "invocationId": "review-request-123"
    }
  }
}
```

The caller supplies the review action and its immutable event template, for example `{path, review:{delivery:"event", eventTemplate}}`. `source` and the four template identity fields are immutable. They must match the current Job/Task/Execution. An invocation ID is a stable unique identifier for the human review request; it is not a video revision, a new Task, or a generated execution ID.

**On human Submit**, the Preview UI fills the following fields under `data.interactive`, preserving every caller-owned field:

| Field | Rule |
| --- | --- |
| `decision` | **Required**: `approved` or `changes_requested`; only the human sets it. |
| `feedback` | **Required** string: plain-language feedback, or `""` on approval. |
| `comments` | Optional structured scene/timestamp comments; do not flatten or discard when available. |
| `revision` | **Required**: immutable content SHA-256 for the reviewed video in event-only mode. |
| `contentHash` | **Required** in event-only mode; equals `revision`, exact 64 lowercase hex. |
| `revisionId` | **Required** in event-only mode: human-visible immutable preview revision identifier. |
| `previewId`, `requestId` | Optional/required respectively in event-only mode; bind the original review request. |
| `idempotencyKey` | **Required** in event-only mode, stable across delivery retries. |

For a human clicking Approve or Request Changes, **one submitted decision generates one event**. Editing individual comments does not publish events. All review clients use the same field paths. Events Bus still accepts `{type,source,data}` through the caller's configured publisher. A successful publish is only a transport receipt, **not** an accepted Relay decision or a completed revision.

**Relay admission and Graph semantics:**

1. Normalize the event, validate the source identity against the data and current Task, then consult the canonical `workflow/interactive-invocation.mmd` Graph. Reject stale executions, invalid decisions/versions, wrong identities, cancelled Jobs and duplicated/conflicting decisions; record the decision atomically in Relay-owned durable state.
2. Legacy host-bound invocations remain supported. An event-only decision may arrive **without a preceding `bindInteractiveInvocation()`** when the Job is ACTIVE, the Task is RUNNING in the exact matching Execution, and the event carries complete immutable content identity. A later video revision may be submitted for the same execution only after `changes_requested`; already decided revisions may not be replayed as new ones.
3. `changes_requested` records actionable feedback for the owning Task. `approved` passes only the human interaction gate for **that exact content**; it does not mark a Task or Job complete. Graph-selected continuation/recovery is separate from the Event Bus receipt. A RUNNING Worker that did not register a waiting Promise must consume the accepted decision via its event-driven workflow; accepting the event alone does not create a new Agent Turn.
4. **Limitation of an entirely unbound event**: Relay cannot independently prove that a never-before-seen content hash is the *latest* review revision solely from the Event payload. The review provider and client must reject superseded revisions before publishing; a future trusted, durable preview-generation fact is necessary if Relay must independently reject every previously unreviewed stale version. Do not present client-declared revision fields as cryptographic authorization.

`review.approved` and `review.changes_required` belong to immutable-head Job Acceptance Review; do **not** emit those or `task.completed` from a Preview UI. Consumers outside Relay may use their own event type, but managed Relay review templates must use `task.interactive_decision`.

## Troubleshooter human escalation

Only a real user action merits escalation. Troubleshooter invokes the Relay escalation operation, specifying the required action, resolution condition, and diagnostic context. Relay durably records the human action and blocks **the Troubleshooter Task**, leaving the original failed Task `FAILED`. This is a Relay state transition, not a third agent terminal event.

When the human responds, Relay records the response as an append-only Task Comment and authoritatively unblocks the **Troubleshooter Task**. The stable Task input is unchanged. Troubleshooter receives current authoritative state and relevant comments, independently verifies the response against the original failing execution context, requests an authorized original Task recovery, and only then publishes its own `task.completed`. A repeated identical escalation without new evidence is idempotent. If unresolved, it continues diagnosis or escalates again; human assertion alone is not technical verification.

See [task-recovery-flows.md](task-recovery-flows.md) for unified architecture, overall flow, failure recovery, and post-blocked resumption.

Reviewer unavailable evidence is an execution failure (`task.failed`), not a blocked Task. Legacy Reviewer verdict `blocked` is normalized to failure and must dispatch Troubleshooter. Only Relay blocks a Troubleshooter during human escalation.

A host-mediated interactive invocation remains a Relay-controlled wait when explicitly bound. The event-only path above accepts complete decisions from current active executions without requiring prior binding; neither route authorizes a Worker or Reviewer to choose a blocked terminal outcome.

A legacy Job-level `review: blocked` gate is reset to `pending` only after authoritative `task.unblocked` metadata exists on its bound Reviewer Task and the immutable review head still matches. The same Reviewer Task then resumes without creating a duplicate.

## Delivery outcome

Relay owns merge and delivery. Workers must not emit `job.merge.*` or mark
the Job complete. Inspect delivery status and its failure reason/receipt through
the version-matched Relay CLI. A prior failed attempt or successful browser
submission is not proof of final delivery.
