# Agents Relay local-Git-only lifecycle HOTFIX — 2026-11-16

## Authority and scope

- Authoritative policy: `workflow/job-lifecycle.mmd`, `workflow/review-lifecycle.mmd`, `workflow/projection-conflict.mmd`, with historical projection-outbox conflict classification isolated in `workflow/projection-outbox-conflict.mmd`.
- Authoritative lifecycle data: local SQLite; canonical `job.projectRoot`, local Git source and target refs, globally numeric Job/Task IDs.
- Completion: Final Review approval -> local Git fast-forward merge -> SQLite `COMPLETED`, never gated by GitHub authentication, PRs or network delivery.
- Optional post-terminal effect: only Jobs newly marked with matching `remoteDelivery.mergedCommitSha` are scanned; origin missing => skip; configured origin => inspect and non-force fast-forward of the *verified SHA*; origin unavailable/diverged => bounded SQLite retry, with a fenced inspection/push lease and no recovery Tasks.
- Historical completed Jobs without a delivery marker must remain unchanged and never be backfilled or automatically pushed.

## Reproducible evidence

All commands ran in isolated branch `hotfix/local-git-only-lifecycle-20261116` at the stated worktree, never the original dirty `rust2` checkout.

| Command | Observed result | Local evidence |
| --- | --- | --- |
| `npm run test:verification:l1` | 58 pass, 0 fail | `/tmp/relay-hotfix-final-l1.log` |
| `npm run test:verification:l2` | 11 pass, 1 intentional live-Codex skip, 0 fail | `/tmp/relay-hotfix-final-l2.log` |
| `npm run test:verification:l3` | 87 pass, 1 intentional live-Codex skip, 0 fail | `/tmp/relay-hotfix-final-l3.log` |
| `npm run test:verification:cross-a` | 10 pass, 0 fail | `/tmp/relay-hotfix-final-cross-a.log` |
| `node --test test/workflow-production-outbox.test.js` | 1 pass, 0 fail | `/tmp/relay-hotfix-final-outbox.log` |
| `npm run test:verification:matrix` | 11 PASS, 0 FAIL, 0 NOT_RUN | `/tmp/relay-hotfix-final-matrix.log` |
| `node --import ./test/test-store-env.mjs --test test/local-git-only-cli.test.js test/no-github.test.js test/service.test.js test/workflow-engine.test.js` | 76 pass, 0 fail | `/tmp/relay-hotfix-final-cli-and-workflow.log` |
| `node --test test/local-merge-projection.test.js test/projection-conflict-v2.test.js` | 14 pass, 0 fail | `/tmp/relay-hotfix-pinned-focused.log` |

The L3 suite includes an actual temporary `dist/relayd-main.js` process, separate real Git repos and bare origin, a temporary SQLite store, and assertions for push success, disconnected origin, missing origin, divergent remote, restart deduplication, historical Job isolation. Further focused tests inject a concurrent main ref move in `pre-push`, an inaccessible canonical project root, retries not due, retry exhaustion, and an expired lease resumed by two concurrent reconcilers. No test result was synthesized from a mocked HTTP success receipt.

The initially failing 12 synthetic L3 cases used nonnumeric fixture Task IDs and collapsed distinct reviewer generations onto one display alias. The replay/simulator now allocate globally numeric IDs through the production allocator and preserve aliases **only in expected traces**, without relaxing production identity checks.

## Production isolation/read-only cross-check

At approximately 2026-11-16 19:52 EST, a strictly read-only SQLite inspection of `~/.agents-relay/relay.sqlite` found 465 Jobs (292 `COMPLETED`, 173 `CANCELLED`, **zero nonterminal**), with 0 nonnumeric IDs across 465 Jobs and 1,512 Tasks; Job #636 remains `CANCELLED`. The production database was **not written or migrated**. The original checkout `/Users/chengli/Workspace/agents-relay` remains `rust2` and dirty, and its PM2 daemon is owned by a separate thread. None of its processes, databases or other worktrees were stopped, reset, or deployed by this hotfix.

## Delivery gate

Code can be committed to the isolated hotfix branch and fast-forwarded into local `main` only after source review and the verification above. A production service switch/restart is **not authorized by this evidence alone** while the other rust2 thread owns the original checkout and daemon, even with zero active Jobs. Live cutover requires owner coordination and fresh checks of daemon ownership, Job activity and correct runtime checkout; never rebuild the dirty rust2 checkout for this hotfix.
