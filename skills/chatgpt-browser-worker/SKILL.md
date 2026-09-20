---
name: chatgpt-browser-worker
description: Manage ChatGPT work threads through the authenticated browser-harness session, including Project selection, thinking-level requests, durable thread identity, resume/status/result retrieval, and cleanup.
---

# ChatGPT browser worker

This skill is the browser-backed ChatGPT worker contract for Neo. It uses the
existing `browser-harness` command as its only browser interaction layer. It
does not use the MacBridge ChatGPT runtime, ChatGPT APIs, copied cookies, or a
second browser automation stack.

## Capability contract

The worker boundary exposes these lifecycle operations:

```text
create(project, prompt, thinking_level) -> ThreadState
resume(thread_id, project)             -> ThreadState
status(thread_id)                      -> StatusObservation
result(thread_id)                      -> ThreadResult
delete(thread_id)                      -> DeletedThreadState
```

`project.name` is required when creating or resuming a thread. `project.id` is
optional because the UI may not expose it at every boundary. The adapter must
select and verify that Project before sending the first prompt. A resumed
thread keeps its recorded Project identity; callers cannot silently move it to
another Project.

Thinking levels are split into `requested_thinking_level` and
`effective_thinking_level`. Requested values are `default`, `low`, `medium`,
and `high`; effective values may additionally be `unknown`. `default` leaves
the account's current/default setting unchanged. The adapter must preserve
`unknown` rather than guessing from a label or silently downgrading a request.

## Durable identity and state

Persist the returned state after every successful lifecycle transition. The
durable key is the ChatGPT `thread_id`; a URL, title, or browser tab index is
not an identity. Records retain a deleted thread as a tombstone so a stale
caller cannot recreate or accidentally reuse it. The complete JSON schema and
valid transition table are in [references/contract.md](references/contract.md).

Pure validation and transition helpers live in `scripts/contract.py`, with
focused tests in `tests/test_contract.py`. The browser-harness driver is
intentionally injected through the semantic port described in the reference;
the contract layer does not import or launch `browser-harness`.
Run `python3 -m pytest skills/chatgpt-browser-worker/tests` from the repository
root.

For the Neo/Leo and Agents Relay handoff—task IDs, run-local state, event
ownership, and the create/resume/result/delete invocation sequence—see
[references/orchestration.md](references/orchestration.md). The outer
orchestrator may use MacBridge as a transport, but this worker never treats
MacBridge as the ChatGPT runtime.

The runtime entry point is the
[browser-worker agent](agents/browser-worker.agent.md). Callers launch that
agent with a typed lifecycle intent; they must not directly call
`create_bh.py` or `operate_bh.py`. Those scripts are helper implementations
that the agent may use, repair, or bypass while preserving this skill's
browser-harness and verification contract.

The browser-worker agent's `create` intent starts a new ChatGPT chat when the
attached tab is already a conversation and emits JSON with the observed
`thread_id`, conversation URL, selected Project, and thinking observation.
`scripts/create_bh.py` is only a helper for that agent, not a caller-facing
runtime contract.

For implementation/debugging, the agent may use the helper equivalent for an
existing thread with the durable identity from persisted state:

```text
python3 scripts/operate_bh.py resume --thread-id ID --project NAME
python3 scripts/operate_bh.py continue --thread-id ID --project NAME --prompt TEXT
python3 scripts/operate_bh.py status --thread-id ID --project NAME
python3 scripts/operate_bh.py result --thread-id ID --project NAME
python3 scripts/operate_bh.py delete --thread-id ID --project NAME
```

Each command performs one serial browser-harness operation. The injected
semantic adapter in `scripts/operations.py` is the testable boundary; it does
not import MacBridge or a ChatGPT runtime API.

## Verification boundary

The worker may report `completed` only from an observed assistant message and
normalized result. A process exit, click, URL change, or tab title alone is not
proof that a thread was created, resumed, completed, or deleted. Authentication
walls, MFA, consent, ambiguous account/project selection, and unverified
thinking levels are `blocked` or `failed` conditions and must not be
self-healed.

Delete targets the exact durable conversation URL, requires an observed action
and confirmation, and verifies that the requested thread is no longer visible.
Repeated cleanup is idempotent (`not_found` is accepted); archive/undo UI
controls are evidence only and never revive a deleted tombstone.

Keep credentials, prompts containing private data, and browser runtime state
out of durable state and events. Runtime artifacts belong under the caller's
ignored `runs/` directory.
