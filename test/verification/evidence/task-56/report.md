# L3 production-ingress replay

Scenario: stale-duplicate
Result: PASS
SQLite job state: ACTIVE

| Step | Event | Before | After |
| --- | --- | --- | --- |
| 0 | task.completed | a:RUNNING, b:DRAFT | a:RUNNING, b:DRAFT |
| 1 | task.completed | a:RUNNING, b:DRAFT | a:SUCCEEDED, b:QUEUED |
| 2 | task.completed | a:SUCCEEDED, b:QUEUED | a:SUCCEEDED, b:QUEUED |

