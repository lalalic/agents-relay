# Implementation Plan: Neo Project Agent Shortcut Execution

**Branch**: `001-agent-shortcut-execution` | **Date**: 2026-11-03 | **Spec**: [spec.md](spec.md)

## Summary

Add an opt-in direct execution mode for a Relay Job's existing Agent Graph,
reusing `parseAgentGraph()` and Relay V2 SQLite lifecycle authority. Code-first
shortcuts are discovered from project `.shortcut/` before Neo shared
`agents/.shortcut/`; absent or failed shortcuts fall back asynchronously to
the existing Worker lifecycle. The concrete Neo shortcut is Visioner for Vlog,
implemented as a thin wrapper around Markcut Vision and the existing Vlog index
script. Human approval and publication remain explicit external gates.

## Architecture Lens

1. **Workflow decision**: Opted-in code-first execution and node readiness,
   fallback, waiting, and resume decisions.
2. **Owning graph**: The stable Relay Task lifecycle graph owns Job/Task states;
   a stable shortcut DAG graph may own node-level readiness and wait policy.
   The Agent Graph source remains parsed by `parseAgentGraph()`.
3. **Effect**: Shortcut discovery/invocation, artifact validation and
   asynchronous fallback are effects selected by the graph.
4. **Durable state**: Existing Relay SQLite Job/Task records and leases only.
5. **No duplicate authority**: No second Job store, DAG parser, EventBus or
   lifecycle state machine; graph changes must use dispatcher facade.
6. **Entry points**: A small CLI opt-in must converge on the same action path;
   default `job create` remains unchanged.
7. **Ownership**: DAG edges express execution order; Job/Task records preserve
   semantic ownership of the outcome.

## Technical Context

**Language/Version**: TypeScript in Relay; Node.js ES modules in Neo
**Primary Dependencies**: Existing Relay V2 Graph/SQLite store; existing Markcut CLI and Vlog index script
**Storage**: Existing Relay SQLite Job/Task records
**Testing**: Node test runner; TypeScript build; isolated `AGENTS_RELAY_STORE_DIR`
**Target Platform**: Existing Agents Relay CLI/runtime and Neo Project workspace
**Project Type**: CLI/runtime plus project-local Node shortcut
**Performance Goals**: Independent ready nodes overlap with a fixed concurrency bound
**Constraints**: Preserve existing Job/Planner behavior; no real input media or paid/external calls in tests; no auto-merge or publishing
**Scale/Scope**: Fixed DAGs; Visioner is the only shipped project shortcut; all other agents use the existing asynchronous Worker route

## Research Decisions

See [research.md](research.md) for the authoritative reuse inventory completed
before runtime changes.

- Existing TaskState does not include `WAITING_EVENT`; a shortcut wait remains a
  RUNNING Task with its lease released through the canonical Task graph.
- The checkpoint stores wait identity and a validated result receipt bound to
  the current execution, revision, and content hash in the existing SQLite
  Task result. EventBus results are wake signals and never supply output.
- Reconciliation consumes only matching durable receipts through the Task
  Lifecycle graph; authenticated human decisions remain on the existing
  host-invocation authority.
- The execution policy is stored on Job before Task materialization. The
  canonical Task graph selects direct shortcut launch or original Worker
  fallback from durable mode, fallback, and Graph facts.

## Constitution Check

- **Pass**: SQLite remains the sole lifecycle authority; graph transitions go
  through the dispatcher; existing prompt context and worker router remain
  unchanged; TypeScript uses explicit types.
- **Pass**: Reuse parser waves and dependencies; no generated vendor skill
  packs or new dependencies are required.
- **Pass with scope gate**: Human approval, event waits, and fallback must use
  existing durable Relay operations. If not available through a transactional
  graph path, mark that slice deferred rather than implementing local state.

## Project Structure

```text
src/
├── agent-shortcut.ts              # discovery, bounded DAG scheduling, result contract
├── cli.ts                         # opt-in CLI dispatch only
├── workflow/shortcut-lifecycle.mmd # stable node/run policy if required
└── ...
test/
├── agent-shortcut.test.js         # parser reuse, concurrency, fallback, restart/events
└── ...

Neo worktree:
agents/.shortcut/visioner.agent.mjs
agents/.shortcut/visioner.agent.test.mjs
vlog/docs/agent-shortcut-generation.md
```

**Structure Decision**: Keep Relay mechanics in its existing TypeScript runtime
and CLI, and keep the concrete Vlog shortcut beside shared Neo Agents. Do not
move Markdown contracts or add agent-specific directories elsewhere.

## Complexity Tracking

No architecture exception is approved. General event wait/resume must be
deferred if the current transactional store/graph boundary cannot safely
implement it in this hotfix.

## 2026-11-04 Direct runner revised implementation plan

1. Reuse Relay SQLite lifecycle, `parseAgentGraph`, direct shortcut graph executor, and event bus. Avoid duplicate scheduler or graph parser.
2. Neo CLI creates/verifies binding and invokes Relay direct shortcut execution in the foreground with inherited/streamed stdout and stderr, observing real terminal state.
3. Relay direct path suppresses scheduler wake/Worker fallback, supports direct Codex default-model adapter resolution where needed, and records node-level provenance and terminal events.
4. Enforce a durable first-start 1200-second deadline across retries/resumes; propagate interrupt/timeout without false PASS.
5. Test parallel dependency waves, waits/receipts, missing shortcut, model adapter, explicit mode change, resume/idempotence, streaming events, exit codes, and 20-minute timeout.
6. Run existing Vlog canonical Run end to end with real outputs; independently audit evidence and only then consider merge.

**Supersession**: Earlier plan statements forbidding `job run` and requiring automatic Worker fallback do not apply to direct shortcut mode.
