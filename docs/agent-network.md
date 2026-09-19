# Agent Network enhancement

## Objective

Evolve Agents Relay from task adapters into a minimal network of independently registered, result-owning agents while retaining GitHub PR state as durable truth and preserving shell/Codex/ChatGPT worker support.

## Scope shipped

- Typed agent registration distinguishes identity, role/responsibility, boundaries, claimed capabilities, endpoint/runtime, availability, and routing metadata.
- Trusted `agents-relay:agent:v1` markers persist registrations in the existing GitHub PR comment store; no second database is introduced.
- `agent-register` and `agent-discover` are machine-driven CLI/core surfaces.
- Discovery applies hard requirements first, then returns explainable evidence and a small policy ranking with optional exploration of unobserved agents.
- Evidence models representative evaluations, historical outcomes, reliability inputs, latency, and cost without fabricating a universal score.
- Documentation defines the single-orchestrator UX, durable task/lease/retry/reconciliation model, and a narrow future authenticated remote job/status contract.

## Non-goals

This PR does not build a public marketplace, broad multi-owner control plane, unauthenticated HTTP endpoint, private-data/credential routing, isolation/billing/trust enforcement, or automatic final agent selection. Adapters remain execution runtimes; events remain live observability and never durable truth.

## Acceptance criteria

- Existing task, scheduler, lease/recovery, continuation, dashboard, and ChatGPT adapter behavior remains green.
- Agents can be registered and discovered from the same durable PR-backed store.
- Discovery rejects unmet capabilities/runtime/trust/availability requirements and exposes evidence rather than an opaque score.
- Registration and discovery work without a human web form.
- The future remote surface is explicitly limited to authenticated create/submit and status operations, with intention-only/public jobs separated from private-data jobs.

## Validation

Run `npm test`, `npm run build`, and `git diff --check`. The implementation adds registry/discovery tests and store round-trip/forgery tests while retaining the existing test suite.

## Future direction

Add authenticated remote submission only when the host has a concrete identity and trust boundary. Then add durable remote task leases/heartbeats and recovery integration, richer evidence aggregation, policy-pluggable matching, and security/isolation gates for private jobs. Keep GitHub PR markers authoritative throughout.
