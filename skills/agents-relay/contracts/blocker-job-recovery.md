# Cross-Repository Blocker Job Recovery

Use this contract when an authorized technical prerequisite must be completed in another repository before a failed Task can safely resume.

## Decision boundary

- Missing cross-repository capability is technical work. When it is within the parent Job's authorized objective and the target repository is within the same owner/workspace trust boundary, create or reuse a blocker Job; do not ask the owner to create it and do not escalate merely because the repository differs.
- Escalate only for a concrete owner-only action such as human approval, account consent, or a destructive/public/billing decision outside the existing authorization.
- The blocker Job owns a reverse `unblocks` relation to the exact dependent Job, Task, and attempt. Never create a cross-Job Task dependency or mark the original Task successful.

## Supported action

Use the version-matched Relay CLI `blocker ensure` action. It accepts the dependent `--repo` and `--id`, target `--target-repo`, exact `--dependent-task`, stable `--request-id`, short `--reason`, standalone `--title` and `--objective-file`, `--origin planner|troubleshooter`, `--resolution merge|verified`, and explicit `--authorized`. Include `--project-path` only when a validated repository-relative project path is known. The stable request ID must be reused unchanged after uncertainty or retry.

The objective must stand alone, identify the target repository and dependent Task, and stay within the parent authorization. Do not include secrets, arbitrary commands, path traversal, additional billing, public publication, destructive actions, or new sensitive access. The target repository must be normalized, configured in the trusted workspace, and share the dependent repository's owner/workspace boundary.

## Durable result and recovery

The action returns the blocker Job ID, repository, dependent Job/Task, reason, resolution mode, outcome, status, and whether planning recovery remains. Relay creates or adopts one durable Job, persists the request identity, and registers the reverse relation. A repeated request with the same identity and scope reuses that Job; reuse of the identity with different scope fails closed. If creation succeeded but planning or registration failed, retry the same request to recover the existing Job and continue the missing step. Never create a second Job to recover planning.

`merge` releases the dependent after the blocker Job's verified merge. `verified` releases it only after an explicit `blocker resolve` operation records the required post-merge evidence. The dependent Task stays failed/waiting until Relay verifies the configured condition and matching attempt. A blocker creation, planning, registration, or CLI receipt alone does not prove the original Task succeeded.

After the action, inspect the blocker Job and dependent Task through the pinned Relay CLI. A Troubleshooter may complete its own Task only after the handoff and exact reverse relation are durable. An immediate repair instead requires a fresh `task recover` receipt and confirmation that the original Task is queued for the expected recovery attempt.
