# E2E-004 — Objective-driven recovery exhaustion / escalation

## Objective

Validate the non-success recovery branch without shared-runtime fault injection. The original worker emits a controlled recoverable-looking failure, then the automatic Troubleshooter is instructed by the preserved failure evidence to classify a deterministic human/external blocker and invoke the canonical escalation graph instead of inventing a retry.

## PASS

- original Task genuinely fails/blocks
- automatic Troubleshooter runs and inspects event history
- Troubleshooter invokes canonical escalation with preserved intent/context
- resolved/failed/needs_user branch is owned by the escalation graph
- no replacement implementation Task, infinite retry loop, false review, local merge, or `COMPLETED` occurs while unresolved
- terminal/nonterminal state exactly matches the selected escalation outcome

This scenario is intentionally not required to end in successful merge.
