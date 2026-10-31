# Implementation Worker Self-Review Loop

For every Task that implements or changes code, configuration, documentation, media, or another artifact, complete this cycle **inside the same worker Task** before reporting success:

1. **Implement.** Check the full durable Job objective, Task requirements, and acceptance criteria. Make the change, then run relevant tests, static checks, and user-style verification when applicable.
2. **Self-review.** Independently inspect the complete current diff or artifact as a critical reviewer. Look for incorrect behavior, omissions, edge cases, security/privacy issues, maintainability problems, regressions, misleading claims, and missing or weak tests. Recheck the acceptance criteria and observable outcomes; a successful build or test run alone is not a clean review.
3. **Fix and repeat.** For **every actionable finding**, repair the work and rerun affected checks. Then perform a **new, complete review of the revised result**, not merely a check of the previous findings. Continue **implement → self-review → fix → re-review** until the latest complete self-review finds **no changes required**. Do not stop at a preset number of review rounds or after the first successful fix. If a single approach repeatedly fails, change the approach rather than repeating the same ineffective attempt.
4. **Report evidence.** In the durable Task result, state the number of self-review rounds, important findings and fixes, final `no changes required` verdict, validation performed and results, and any unresolved limitations. Only report `task.completed` after the declared output is durable and the review is clean. If a required check cannot run, an actionable finding remains, or the cycle cannot converge, report the blocker and evidence with `task.failed` rather than falsely declaring success.

This worker self-review **does not replace** Relay's independent SHA-bound final Reviewer, required human approvals, Graph-managed review/revision, or delivery/merge gates. A worker must not approve its own final review, merge, or invent verification evidence.

For read-only research or diagnostic Tasks, validate findings and evidence; do not invent artifact modifications or review rounds.
