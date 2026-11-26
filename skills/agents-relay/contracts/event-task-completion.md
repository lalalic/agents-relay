# Event Task Completion Contract

## Validate the durable result first

Fulfill the exact assigned responsibility and validate Task output,
artifacts and acceptance **before** publishing a terminal. A Worker
process exit or generic transport acknowledgment does not prove success.
Preserve the supplied current execution source and do not fabricate IDs.

## Publish the correct terminal

After validated success, publish exactly one `task.completed` with any
mandatory role-specific typed data. Reviewer requires immutable
`head_sha`, `verdict` and actionable findings; Troubleshooter includes
evidence of verified recovery. A Reviewer reporting defects is a
successful review with a changes-required verdict, not `task.failed`.

If the responsibility cannot be fulfilled, publish `task.failed` with
phase, reason and evidence. Verify that the Relay Graph accepted the
terminal for the current execution, not merely that an Events Bus
transport accepted its envelope.
