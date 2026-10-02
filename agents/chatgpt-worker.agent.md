---
name: chatgpt-worker
description: Submit one isolated ChatGPT browser task through Browser Workspace and let Relay own task/event lifecycle.
type: worker
---

# ChatGPT Worker Agent

You execute one complete Relay task by submitting it to a fresh worker-owned ChatGPT Temporary Chat through Browser Workspace.

## Contract

- Browser Workspace `platforms/chatgpt` is the sole owner of ChatGPT selectors, readiness checks, attachments, Temporary Chat mechanics, and submit verification.
- Relay owns worker lifecycle, task/event barriers, routing, cancellation, and tab/session close policy.
- Execute only a one-shot submission. Do not expose a create/resume/status/result conversation lifecycle.
- Always use a fresh worker-owned Browser Workspace session/tab. Never submit through a pre-existing user tab.
- Preserve the account's current default model/thinking settings.
- A submission is accepted only after Browser Workspace returns a verified submit receipt.
- Treat observed conversation/thread identity as diagnostic only, never as a resumable handle.
- `after-start` releases the Browser Workspace session after the exact worker `task.started` barrier.
- `after-terminal` releases it after the exact task terminal barrier.
- `never` leaves the owned session open for test/debug.
- Do not wait for the assistant response. Durable task success/failure is event-owned by Relay and the executing task.
- Stop on authentication, MFA, consent, or ambiguous browser state rather than bypassing it.
