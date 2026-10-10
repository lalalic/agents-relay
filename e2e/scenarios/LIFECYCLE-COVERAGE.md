# Agents Relay V2 Lifecycle Coverage Map

This document is the canonical map for production lifecycle coverage. It shows the normal happy path, every important failure branch currently identified, the expected recovery mechanism, whether the behavior exists in production code, whether focused/integration tests cover it, and whether a production E2E scenario proves it.

The purpose is to distinguish two very different gaps:

- **CODE GAP** — the recovery/lifecycle behavior is missing, ambiguous, or architecturally incomplete.
- **E2E GAP** — production behavior exists and is tested below E2E, but no real production-path scenario proves it yet.

## Status legend

| Status | Meaning |
| --- | --- |
| `PASS` | Production E2E completed successfully. |
| `RUNNING` | Production E2E currently executing. |
| `PLANNED` | Scenario/injector exists but production E2E has not passed yet. |
| `E2E GAP` | Code/test support exists but production E2E coverage is missing. |
| `CODE GAP` | Production behavior itself needs implementation or an explicit architecture decision. |

## Lifecycle graph

```mermaid
flowchart TD
    A[Job created\nSQLite authority] --> B[Planner]
    B --> C[Task routing / worker selection]
    C --> D[Worker execution]
    D --> E[Implementation succeeds]
    E --> F[Independent final review\nimmutable head]
    F --> G[Review approved]
    G --> H[Local Git merge]
    H --> I[Job COMPLETED]
    I --> J[Optional GitHub projection / PR merge]

    %% Planner failures
    B -. planner fails / invalid output .-> B1[Planner retry with prior failure context]
    B1 --> B
    B -. planner unavailable / retry exhausted .-> B2[Planner failure remains durable\nno false task execution]

    %% Routing failures
    C -. provider quota / rate limit .-> C1[Refresh usage + routing facts\nexclude/deprioritize failed route]
    C1 --> C
    C -. no viable route .-> C2[Troubleshooter or escalation\npreserve routing evidence]

    %% Worker failures
    D -. task.failed / task.blocked .-> D1[Graph creates Troubleshooter]
    D1 --> D2[Diagnose from durable task + events + logs]
    D2 --> D3[Remove recoverable blocker]
    D3 --> D4[Recover EXACT original Task]
    D4 --> D

    D -. process exits without terminal event .-> W1[Terminal-event watchdog]
    W1 --> W2[Persist watchdog.failed / execution evidence]
    W2 --> D1

    D -. delayed terminal from old execution .-> W3[executionId/source generation fence]
    W3 --> W4[Ignore stale event]

    D -. async browser transport exits early .-> W5[Keep Task active]
    W5 --> W6[Wait for authoritative correlated terminal]
    W6 --> E

    D -. Browser Workspace dependency/runtime failure .-> W7[Classify tool/runtime failure]
    W7 --> D1

    %% Troubleshooter failure / escalation
    D2 -. external/human blocker .-> T1[Canonical escalation graph]
    T1 --> T2[resolved / failed / needs_user]
    D2 -. Troubleshooter itself fails .-> T3[Bounded same-Task retry/reroute and recovery]

    %% Review failures
    F -. changes_required .-> R1[Graph creates one review-fix Task]
    R1 --> R2[Fix commits new head]
    R2 --> F

    F -. reviewer runtime/provider failure .-> R3[Classify runtime failure]
    R3 --> R4[Recover/reroute review against same immutable head]
    R4 --> F

    F -. head changes while review evidence is old .-> R5[Cancel/invalidate stale review]
    R5 --> F

    %% Merge failures
    H -. merge conflict / dirty target / lock issue .-> M1[Persist failed merge receipt]
    M1 --> M2[Keep Job non-COMPLETED\nprotect target ref/worktree]
    M2 --> H

    %% Daemon failure
    D -. daemon restart during active execution .-> O1[Recover durable executionId / lease / PID evidence]
    O1 --> O2[Resume/recover exactly once]
    O2 --> D

    %% GitHub projection failures
    J -. projection/API failure .-> P1[Persist projection failure/outbox]
    P1 --> P2[Retry idempotently later]
    P2 --> J

    J -. duplicate webhook/projection delivery .-> P3[Delivery/event idempotence]
    P3 --> J

    J -. external MERGED while local mandatory work failed .-> P4[GitHub remains audit-only]
    P4 --> P5[Local Job must NOT become COMPLETED]
```

## Coverage matrix

| Lifecycle stage | Failure point | Expected production solution | Code | Focused / integration tests | Production E2E | Coverage classification |
| --- | --- | --- | --- | --- | --- | --- |
| Job / Planner | Happy-path planning | Planner creates executable implementation work from durable objective | Implemented | Covered | `#1 PASS`, `#2 PASS`, `#3 PASS` | Covered |
| Planner | Planner invalid output / transient failure | Automatic planner retry carries prior failure/context; no manual reconcile required | Implemented | `autonomous.test.js`, planner/runtime tests | None dedicated | **E2E GAP** |
| Planner | Planner unavailable / retry exhausted | Persist failure; do not fabricate implementation work or completion | Implemented | workflow/core tests | None dedicated | **E2E GAP** |
| Routing | Worker execution rejection (quota/model/provider/etc.) | Preserve structured failure, apply cause-specific recovery, retry exact Task | Implemented in routing/recovery path | Router/core tests | `#6 PLANNED` | Planned E2E |
| Routing | No viable worker/model | Persist Task `FAILED` before any execution claim; Graph then exposes normal recovery path | Implemented | Core routing failure test proves no execution generation is claimed | None | **E2E GAP** |
| Dispatch | Duplicate/concurrent launch | Per-Job execution slot + pool/global capacity control | Implemented | Core/local-job routing tests | Happy path exercises ordinary dispatch; stronger injection in `#5` | Mostly covered; fault E2E planned |
| Worker | Ordinary worker `task.failed` / `task.blocked` | Graph creates exactly one relevant Troubleshooter; recover exact original Task | Implemented | Troubleshooter/core/local-authority tests | `#2 PASS`, `#3 PASS` | Covered |
| Recovery | Recoverable blocker | Troubleshooter diagnoses event history, removes blocker, uses dedicated `task recover` | Implemented | Core/troubleshooter tests | `#2 PASS`, `#3 PASS` | Covered |
| Recovery | Replacement business Task instead of original retry | Reject as invalid recovery; exact original Task must reactivate | Implemented by recovery contract / tests | Core/task-action tests | `#2 PASS` | Covered |
| Recovery | Troubleshooter itself fails | Retry the same failed Troubleshooter (bounded, rerouted), then recover original Task and complete Job; exhaustion is a failure requiring escalation | Implemented | Troubleshooter reconciliation/idempotence test | `#4 PASS` | **E2E GAP** |
| Recovery | Genuine human/external blocker | Canonical escalation graph owns `resolved / failed / needs_user` outcome | Implemented pathway exists | Escalation/component tests need audit | `#4 PASS` | Needs E2E proof |
| Worker runtime | Process exits without authoritative terminal | Terminal-event watchdog persists failure evidence and wakes recovery | Implemented | Strong core/workflow tests | `#5 PLANNED` | **E2E GAP** until #5 passes |
| Worker runtime | Late terminal from old execution generation | Compare event source/executionId to current generation and ignore stale terminal | Implemented | Strong core tests | `#5 PLANNED` | **E2E GAP** until #5 passes |
| Async worker | Browser submission transport exits before business completion | Transport exit is observational; wait for correlated terminal event | Implemented | Core adapter/runtime tests | `#8 PLANNED` | **E2E GAP** |
| Tool/runtime | Browser Workspace dependency failure | Classify tool/runtime defect; repair/reroute exact original Task | Recovery mechanisms exist | Partial | `#10 PLANNED` | Needs real E2E proof |
| Review | Happy-path approval | Review exact immutable head; approval is local durable fact | Implemented | Strong core/review tests | `#1 PASS`, `#2 PASS` | Covered |
| Review | `changes_required` | Create exactly one fix Task for reviewed head; fix creates new head; new independent review | Implemented | Strong core/review tests | `#3 PASS`, requires two rejection/fix generations | Running |
| Review | Stale approval/review after head changes | Invalidate/cancel stale review; only current-head evidence counts | Implemented | Strong core tests | `#3 PASS` indirectly covers successive heads | Running / partial |
| Review | Reviewer runtime/provider failure | Recover/reroute the exact reviewer Task while preserving immutable `reviewHeadSha`; later verdict must bind to that same head | Implemented | Dedicated same-Task/same-head recovery test + start-ack tests | No dedicated current scenario | **E2E GAP** |
| Local merge | Happy-path local merge | Shared merge lock, merge exact approved source head, durable receipt | Implemented | Strong no-GitHub/local merge tests | `#1 PASS`, `#2 PASS` | Covered |
| Local merge | Merge conflict | Persist failed receipt, leave Job ACTIVE/non-COMPLETED, keep target clean | Implemented | Strong `no-github.test.js` coverage | None | **E2E GAP** |
| Local merge | Dirty checked-out target / untracked collision | Refuse unsafe merge without mutating target | Implemented | Strong local merge tests | None | **E2E GAP** |
| Local merge | Dead/concurrent merge lock | Serialize Relay merges; recover dead owner safely | Implemented | Cross-process merge-lock tests | None | **E2E GAP** |
| Daemon | Restart during active execution | Reconstruct durable execution state; avoid duplicate launch; recover orphan once | Implemented recovery primitives | Startup/orphan/core tests | `#9 PLANNED` | **E2E GAP** |
| Local authority | GitHub unavailable/rate-limited | SQLite/Graph lifecycle continues; GitHub cannot gate dispatch/review/merge | Implemented | Strong local-authority/no-GitHub tests | #1/#2 indirectly with enabled projection; #7 planned for explicit projection failure | Strong code, explicit E2E planned |
| GitHub projection | Projection/API transient failure | Durable outbox/failure, retry idempotently; never block local lifecycle | Implemented | Relay-store/projection tests | `#7 PLANNED` | **E2E GAP** |
| GitHub projection | Duplicate webhook/projection delivery | Idempotent event/projection handling | Implemented | Strong webhook/store tests | `#7 PLANNED` | **E2E GAP** |
| GitHub audit | External PR becomes MERGED while mandatory local work is failed | Treat GitHub as audit-only; local Job stays failed/ACTIVE and cannot false-complete | Implemented | `workflow-lifecycle.test.js`, local-authority/core tests | No current production E2E after scenario compression | **E2E GAP — important** |
| Service boundary | CLI mutates SQLite outside daemon | All durable interfaces go through `agents-relayd`; only explicit `--file` demo may be local | Implemented in `.27` | Boundary guard + service/dashboard tests | Exercised by current E2E runner/CLI | Covered |
| Dashboard realtime | Cross-process lifecycle changes not pushed via SSE | All durable mutations occur inside daemon; local commit hook emits SSE | Implemented in `.26/.27` | Dashboard/service tests | Current E2Es exercise service path; visual refresh not separately asserted | Mostly covered |

## Current production E2E scenarios

| Scenario | Purpose | Status |
| --- | --- | --- |
| `001-happy-path` | Planner → implementation → review → local merge → COMPLETED → GitHub MERGED | **PASS** |
| `002-worker-blocker-troubleshooter-recovery` | Real worker blocker → automatic Troubleshooter → exact original Task retry → review → merge | **PASS** |
| `003-objective-exception-ladder` | Worker fails once → Troubleshooter recovery → original retry → review rejects twice → two fix generations → later approval → COMPLETED + GitHub MERGED (#33, r11) | **PASS** |
| `004-objective-recovery-exhaustion-escalation` | Troubleshooter fails → bounded same-Task retry/reroute → original recovered → review/merge → COMPLETED + GitHub MERGED (#35, r2) | **PASS** |
| `005-watchdog-stale-generation` | Kill worker without terminal → watchdog recovery → newer execution → stale old terminal ignored → COMPLETED + GitHub MERGED (#41, r6) | **PASS** |
| `006-provider-quota-reroute` | Controlled Adapter `model_not_found` rejection → normal failure classifier → `task.rerouting` → same Task attempt 2 succeeds → review/local merge/COMPLETED/GitHub MERGED (#44, r4) | **PASS** |
| `007-projection-isolation-retry` | Task-declared `github.projectLocalMerge` `after + throw` → local COMPLETED before transient projection failure → retry `already_projected` → GitHub MERGED (#47, r3) | **PASS** |
| `008-async-browser-handoff` | ChatGPT async implementation transport exited before progress and correlated authoritative terminal; single execution, approved review, local merge, COMPLETED, GitHub MERGED (#50, r3) | **PASS** |
| `009-daemon-restart-orphan` | Active Codex PID 88833 terminated by daemon restart (`parent-shutdown`, SIGTERM); same Task recovered execution 83e99cf8, succeeded, review/local merge/COMPLETED, GitHub MERGED (#54, r4) | **PASS** |
| `010-browser-workspace-runtime-failure` | Task-declared `browserWorkspace.command` `throw + skip` → controlled CLI rejection → Troubleshooter recovered exact original Task attempt 2 → independent review/local merge/COMPLETED + GitHub MERGED (#56, r2) | **PASS** |

## Known code gaps / architecture questions

Recovery policy revised: a recoverable Troubleshooter failure must retry and the Job must complete. Exhaustion-only termination is not E2E success. The items previously listed here were resolved/audited as follows:

1. **Troubleshooter failure policy** — bounded automatic same-Task recovery/reroute, without recursive Troubleshooter creation; scenario #004 r2 verifies eventual Job COMPLETED.
2. **No viable route** — already implemented: routing failure durably fails the Task before any execution generation is claimed; normal recovery semantics then apply.
3. **Reviewer-specific runtime recovery** — audited and covered below E2E: dedicated `task recover` preserves the same reviewer Task and immutable `reviewHeadSha`; a later correlated verdict on the recovered execution drives the normal review graph.

New CODE GAPs discovered during later E2E rounds should be added here rather than hidden as scenario-specific workarounds.

## Important E2E gaps where code already exists

These are high-value candidates after scenarios `003`–`010`:

1. **Planner failure / retry** — prove event-driven planner retry and no silent stall in production.
2. **Local merge conflict / dirty target** — prove a real production Job cannot false-complete after delivery failure.
3. **External GitHub MERGED while local work failed** — explicitly prove GitHub audit facts cannot override SQLite lifecycle authority.
4. **Reviewer runtime failure** — if the code audit confirms the path is complete, add a reviewer-specific production injection rather than relying on generic provider recovery.

## Coverage completion rule

A lifecycle branch is considered fully covered only when all three layers agree:

```text
Production code implements the invariant
        +
Focused/integration tests prove deterministic semantics
        +
Production E2E proves the real interfaces/runtime path
        =
Lifecycle branch COVERED
```

A passing unit/integration test does not substitute for a production E2E fault path, and a successful E2E cannot compensate for ambiguous or missing lifecycle semantics in code.
