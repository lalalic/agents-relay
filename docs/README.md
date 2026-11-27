# Relay project knowledge

Start at [AGENTS.md](../AGENTS.md); select only the references relevant to the objective. These documents describe current architecture and operating behavior, not migration history, incident logs or completed feature reports. Use Git history for earlier designs and evidence. Code, executable graphs, and canonical runtime Contracts are the evidence for exact behavior.

| Area | Current reference |
| --- | --- |
| Architecture and design constraints | [Architecture](architecture.md), [Harness independence](harness-independence.md) |
| Job, Plan, Task and review | [Objective-driven Jobs](objective-driven-jobs.md) |
| Workflow policy and engine | [Workflow engine](workflow-engine.md), [Graph orchestration](graph-engine-orchestration.md) |
| Agent selection and Prompt | [Prompt builder](agent-prompt-builder.md) |
| Model routing | [Execution Router](worker-model-routers.md) |
| Execution ownership | [Worker process lifecycle](WORKER_PROCESS_LIFECYCLE.md) |
| Recovery and human review | [Recovery](unblock-resolution-workflow.md), [Interactive review](interactive-task-host-contract.md) |
| Dashboard | [Dashboard/PWA](DASHBOARD_PWA.md), [Workflow symbol index](workflow-symbol-index.md) |
| Operations and verification | [Service](service.md), [Observability](structured-observability.md), [Testing](testing-strategy.md) |
| Feedback | [Feedback intake](feedback-intake.md) |

Generic Agent roles and runtime Contracts remain in `skills/agents-relay/`. Do not duplicate those schemas or procedures in project docs.
