# E2E autonomy production-path smoke — 2026-10-08

Use the existing production Agents Relay daemon, Events Bus, Graph Engine, Router, Codex/ChatGPT worker integrations, Reviewer, Troubleshooter, and GitHub webhook. Test repository ONLY: lalalic/agents-relay-e2e. No new daemon, no special test entry point, no manual retry/review/merge, and no alteration to production jobs.

## Objective
Create a deterministic implementation task in this E2E repository: add fixtures/autonomy-smoke-20261008.json containing {"scenario":"autonomy-smoke-20261008","result":"pass"}, and a Node test asserting the file contents. Keep all other files intact.

## Workflow acceptance
- Existing Relay planner creates durable work and review tasks and launches real worker through normal production path.
- Worker changes and pushes test PR branch, runs npm test, publishes correlated terminal events.
- Review targets immutable head and completes without human action.
- Relay automatically merges this PR and marks Job COMPLETED.
- Capture durable Job/Task records, GitHub PR state, NATS event sequence, execution IDs, duplicate launches, and worktree state; do not claim PASS based solely on unit tests.
- If any stage fails, preserve failure evidence and classify as a system defect, allowing normal production troubleshooter/reconcile to act. Do not manually retry or bypass lifecycle.

## Safety
Only this test PR and this test repository may be changed. Do not restart or kill shared services; do not inject shared-daemon failures; do not alter unrelated repository jobs or files.
