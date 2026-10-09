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
    D2 -. Troubleshooter itself fails .-> T3[No automatic recovery-of-recovery policy today]

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
| Job / Planner | Happy-path planning | Planner creates executable implementation work from durable objective | Implemented | Covered | `#1 PASS`, `#2 PASS`, `#3 RUNNING` | Covered |
| Planner | Planner invalid output / transient failure | Automatic planner retry carries prior failure/context; no manual reconcile required | Implemented | `autonomous.test.js`, planner/runtime tests | None dedicated | **E2E GAP** |
| Planner | Planner unavailable / retry exhausted | Persist failure; do not fabricate implementation work or completion | Implemented | workflow/core tests | None dedicated | **E2E GAP** |
| Routing | Provider quota / rate limit | Preserve structured failure, refresh usage facts, reroute exact Task | Implemented in routing/recovery path | Router/core tests | `#6 PLANNED` | Planned E2E |
| Routing | No viable worker/model | Preserve routing evidence; route to recovery/escalation rather than silent stall | Partial / needs explicit contract review | Some routing failure tests | None | **Possible CODE GAP + E2E GAP** |
| Dispatch | Duplicate/concurrent launch | Per-Job execution slot + pool/global capacity control | Implemented | Core/local-job routing tests | Happy path exercises ordinary dispatch; stronger injection in `#5` | Mostly covered; fault E2E planned |
| Worker | Ordinary worker `task.failed` / `task.blocked` | Graph creates exactly one relevant Troubleshooter; recover exact original Task | Implemented | Troubleshooter/core/local-authority tests | `#2 PASS`, `#3 RUNNING` | Covered |
| Recovery | Recoverable blocker | Troubleshooter diagnoses event history, removes blocker, uses dedicated `task recover` | Implemented | Core/troubleshooter tests | `#2 PASS`, `#3 RUNNING` | Covered |
| Recovery | Replacement business Task instead of original retry | Reject as invalid recovery; exact original Task must reactivate | Implemented by recovery contract / tests | Core/task-action tests | `#2 PASS` | Covered |
| Recovery | Troubleshooter itself fails | Need defined recovery-of-recovery policy, retry budget, or escalation semantics | **Not implemented as automatic recovery** | Limited | None | **CODE GAP** |
| Recovery | Genuine human/external blocker | Canonical escalation graph owns `resolved / failed / needs_user` outcome | Implemented pathway exists | Escalation/component tests need audit | `#4 PLANNED` | Needs E2E proof |
| Worker runtime | Process exits without authoritative terminal | Terminal-event watchdog persists failure evidence and wakes recovery | Implemented | Strong core/workflow tests | `#5 PLANNED` | **E2E GAP** until #5 passes |
| Worker runtime | Late terminal from old execution generation | Compare event source/executionId to current generation and ignore stale terminal | Implemented | Strong core tests | `#5 PLANNED` | **E2E GAP** until #5 passes |
| Async worker | Browser submission transport exits before business completion | Transport exit is observational; wait for correlated terminal event | Implemented | Core adapter/runtime tests | `#8 PLANNED` | **E2E GAP** |
| Tool/runtime | Browser Workspace dependency failure | Classify tool/runtime defect; repair/reroute exact original Task | Recovery mechanisms exist | Partial | `#10 PLANNED` | Needs real E2E proof |
| Review | Happy-path approval | Review exact immutable head; approval is local durable fact | Implemented | Strong core/review tests | `#1 PASS`, `#2 PASS` | Covered |
| Review | `changes_required` | Create exactly one fix Task for reviewed head; fix creates new head; new independent review | Implemented | Strong core/review tests | `#3 RUNNING`, requires two rejection/fix generations | Running |
| Review | Stale approval/review after head changes | Invalidate/cancel stale review; only current-head evidence counts | Implemented | Strong core tests | `#3 RUNNING` indirectly covers successive heads | Running / partial |
| Review | Reviewer runtime/provider failure | Recover/reroute reviewer against same immutable head without human review | Generic runtime recovery exists, reviewer-specific path needs validation | Some start-ack/reviewer failure tests | No dedicated current scenario | **E2E GAP; audit for CODE GAP** |
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
| `003-objective-exception-ladder` | Worker fails once → Troubleshooter recovery → original retry → review rejects twice → two fix generations → later approval | **RUNNING** |
| `004-objective-recovery-exhaustion-escalation` | Recovery cannot safely proceed → canonical escalation → no infinite retry / false completion | **PLANNED** |
| `005-watchdog-stale-generation` | Kill worker without terminal → watchdog recovery → newer execution → stale old terminal ignored | **PLANNED** |
| `006-provider-quota-reroute` | Real provider quota/rate-limit failure → refresh routing facts → reroute exact Task | **PLANNED** |
| `007-projection-isolation-retry` | GitHub projection failure + duplicate delivery while SQLite lifecycle continues | **PLANNED** |
| `008-async-browser-handoff` | Async browser transport exits before business completion; authoritative terminal remains controlling | **PLANNED** |
| `009-daemon-restart-orphan` | Restart daemon during live execution; exactly-once live/orphan recovery | **PLANNED** |
| `010-browser-workspace-runtime-failure` | Real Browser Workspace/tool dependency failure → repair/reroute original Task | **PLANNED** |

## Known code gaps / architecture questions

These should not be treated as merely missing E2E tests.

### 1. Troubleshooter failure policy

Today automatic Troubleshooter creation intentionally excludes Tasks whose `agentName` is already `troubleshooter`. Therefore a failed Troubleshooter does **not** automatically get another Troubleshooter.

Decision required:

- retry the same Troubleshooter with a bounded retry budget;
- create a higher-level recovery generation;
- invoke canonical escalation immediately;
- or treat Troubleshooter failure as a terminal Job-level recovery failure.

Whatever policy is selected must guarantee no infinite recovery recursion.

### 2. No-viable-route terminal behavior

Routing failure is tested, but the production contract should be explicit about what happens when **no provider/worker is viable after refresh/re-decision**. It should converge to a durable recovery/escalation state rather than remaining indefinitely queued.

### 3. Reviewer-specific runtime recovery

Generic Task watchdog/recovery exists, and reviewer start-ack failure has focused coverage, but we need to verify the architecture guarantees that reviewer runtime failure recovers/re-routes **the review of the exact same immutable head** without accidentally producing implementation work or accepting stale evidence.

This may be only an E2E gap, but should be audited before declaring it so.

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
