# Tasks: Neo Project Agent Shortcut Execution

**Input**: Design documents from `specs/001-agent-shortcut-execution/`
**Prerequisites**: plan.md, spec.md, research.md

## Phase 1: Setup

- [x] T001 Record authoritative reuse inventory in `specs/001-agent-shortcut-execution/research.md`
- [x] T002 Create requirements spec and quality checklist in `specs/001-agent-shortcut-execution/`

## Phase 2: Foundational

- [x] T003 Confirm production graph/store operations available for direct execution in `src/relay-control.ts` and `src/relayd-control.ts`
- [x] T004 Define durable shortcut run and wait data model in `specs/001-agent-shortcut-execution/data-model.md`

## Phase 3: User Story 1 — Run an Agent Graph with shortcuts

- [x] T005 [US1] Implement bounded shortcut DAG runner reusing `parseAgentGraph()` in `src/agent-shortcut.ts`
- [x] T006 [US1] Add opt-in durable Job execution entrypoint in `src/cli.ts` and the owning control/action path
- [x] T007 [US1] Add tests for parser reuse, concurrent branches, async result, successful output and worker fallback in `test/agent-shortcut.test.js`

## Phase 4: User Story 2 — Resume safely after events and restarts

- [x] T008 [US2] Define graph-owned wait/resume transitions and durable correlation in `workflow/task-lifecycle.mmd` and lifecycle bindings. Resume consumes a validated SQLite Task receipt; EventBus output is wake-only. Human approval remains host-invocation-only.
- [x] T009 [US2] Add matching, duplicate, stale, restart, content-hash, and approval-boundary tests in `test/agent-shortcut.test.js`; no manual JSON can impersonate a decision.

## Phase 5: User Story 3 — Vlog Visioner shortcut

- [x] T010 [US3] Implement contract-driven Visioner code shortcut in `agents/.shortcut/visioner.agent.mjs`
- [x] T011 [US3] Add mocked CLI fixture tests for provenance, output verification and preservation in `agents/.shortcut/visioner.agent.test.mjs`
- [x] T012 [US3] Document on-demand agent shortcut authoring from `.agent.md` and supported CLI templates in `vlog/docs/agent-shortcut-generation.md`

## Phase 6: Polish

- [x] T013 Update user/CLI documentation and compatibility tests without changing default Job creation in `docs/objective-driven-jobs.md`, `src/cli-help.ts`, and `test/service.test.js`
- [x] T014 Run Relay build, focused tests, Neo tests, and final architecture self-review; record results in `specs/001-agent-shortcut-execution/quickstart.md`

## Dependencies

- T003 and T004 are gates before implementing Relay direct execution.
- T005–T007 deliver the basic shortcut path.
- T008–T009 depend on the basic run identity and persistence design.
- T010–T012 can be developed against the Vlog contracts, but their runner
  integration depends on T005.
- T014 depends on implementation scope selected after T003.

## Implementation Strategy

Establish the atomic graph/store path first. If T003 confirms that existing
transactions cannot safely claim, persist progress, wait and resume, stop short
of a fake direct-run CLI and deliver only independently useful tested shortcut
code plus a precise limitation report. Preserve the original Job/Planner path.
