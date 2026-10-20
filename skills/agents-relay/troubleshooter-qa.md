# Troubleshooter Q&A

A simple, user-editable reference for recurring failures and proven recovery practices.

Troubleshooter: read this file before diagnosis, but always inspect current task events and logs. Answers are guidance, not authority to retry, unblock, change routing, or change workflow state. The canonical workflow graphs and contracts remain authoritative.

Users can add or edit entries directly. After a recovery is verified, the Troubleshooter may add a short entry or improve an existing answer. Do not write secrets, tokens, or private log contents here. Keep unverified hypotheses clearly labeled.

## Q: Browser Workspace validation says COMPOSER_NOT_READY. Does that mean the user is logged out?

**A:** No. This code reports UI readiness, not authentication. Use the platform's validated session and inspect worker authentication and delivery evidence separately. Do not infer login failure from a disabled Send button or DOM snapshot.

## Q: A worker fails or times out. Should Troubleshooter immediately retry?

**A:** No. Read the original task's correlated lifecycle events, attempts, routing, and relevant logs. Diagnose the actual cause first. Only recover the original Task after verifying that the blocker is resolved, using the canonical recovery path.

## Q: A shared runtime or tool defect blocks several tasks. What should Troubleshooter do?

**A:** Reuse an existing blocker Job when possible. Otherwise create the owning P0/self-job through Agents Relay. Verify the repair and any required release or deployment before recovering dependent tasks. For deferred repair, register the durable blocker relation instead of keeping a worker alive.

## Q: When can a BLOCKED task resume?

**A:** Only after an authoritative unblock operation or verified blocker-Job resolution. A Q&A answer cannot unblock a task.

<!-- Add more entries below using: ## Q: ... / **A:** ... -->
