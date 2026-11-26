# Cross-Repository Blocker Job Recovery Contract

- Use the `agents-relay` Skill for `blocker ensure`, `blocker resolve`, Task recovery and authoritative Job/Task reads.
- A technical prerequisite in another trusted, same-owner repository remains authorized technical work, not an automatic human escalation. Escalation is for genuine owner-only decisions.
- The target repository and standalone objective must remain within the original authorization; no implicit paid, public, destructive or sensitive-access actions.
- A blocker Job must durably identify the exact dependent Job, Task and attempt through a reverse `unblocks` relation, not a cross-Job Task dependency. The original Task remains failed until verified release.
- A stable request identity must be idempotent: equivalent requests adopt the same blocker; a conflicting identity fails closed. Never create a duplicate blocker to recover an uncertain operation.
- `merge` resolution requires a verified merge; `verified` resolution requires explicit post-merge evidence through Relay. Receipts alone do not prove that the dependent resumed or succeeded.
- A Troubleshooter may complete a deferred handoff only after verifying its exact reverse relation. An immediate recovery requires a fresh correlated original Task recovery receipt.

For CLI flags and recovery steps use the `agents-relay` Skill; do not reproduce its command help here.
