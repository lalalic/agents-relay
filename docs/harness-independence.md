# Harness-independent Agents Relay boundary

**Status:** agreed target architecture; the inventory below distinguishes implemented
boundaries from remaining Neo-specific runtime coupling. This is a design and
migration specification, **not** a claim that full decoupling has shipped.

## Ownership

| Owner | Owns | Must not own |
| --- | --- | --- |
| Neo.app (`neox`) | Native macOS host, signed permissions, MCP gateway, managed Harness installation/updates, Setup UI | Generic Relay lifecycle state or a second project Git repository |
| Neo Harness (`neo`) | Installed `neo` CLI, bootstrap, shared Agents/Skills, Neo Project discovery and validation, execution-context preparation | Relay's Graph Engine or Job/Task/Review lifecycle |
| Agents Relay | Generic durable Job/Task/DAG scheduling, SQLite lifecycle, worker routing and execution, recovery, review, event semantics and adapters | Neo.app installation, Neo CLI, specific project names, fixed Neo directories, Markcut product policy |
| Independent Neo Project | Its own `.git`, `AGENTS.md`, `README.md`, `graph.mmd`, local Agents/Shortcuts, contracts, scripts and ignored private `runs/` | Shared Harness source ownership or another project's Runs |

**Direction of integration:** Neo may call Relay; Relay must not require Neo to
install, discover, execute, review or recover a Job. A non-Neo caller must be
able to supply equivalent context. The Harness source repository and the
installed Harness are separate from both Relay and user Projects.

## External inputs to Relay

Only two categories of caller-owned information are needed:

1. **Shared capabilities:** configured Agent/Skill sources and the Shortcuts
   attached to resolved Agents. The Relay built-in layer remains its own.
2. **Job Execution Context:** owning project path and Git root, DAG, contracts,
   task inputs, instructions, runtime capabilities, worker/provider configuration,
   and event/review adapters when needed.

Illustrative caller-side contract, **not** a new persisted Relay JSON schema:

```json
{
  "projectPath": "/home/user/Workspace/vlog",
  "sharedRoot": "/path/to/installed/harness",
  "workspaceBoundary": "/home/user/Workspace",
  "agent": "vlog-visioner",
  "runtime": "codex"
}
```

`resolveExecutionContext(projectPath, role, options)` currently takes generic
`sharedRoot`, `globalRoot`, and `workspaceRoot` options. Its `workspaceRoot` is
**Relay's bounded instruction/discovery context**, not the removed Neo
`workspaceRoot` configuration field. Never reconstruct `<workspaceRoot>/neo` to
find shared capabilities. In CLI paths, `AGENTS_RELAY_SHARED_ROOT` can select
an installed shared root; the invoking Harness is responsible for passing it.

## Hierarchy and Shortcut provenance

Effective Agent/Skill precedence, low to high:

1. Relay built-ins (for Agent roles provided by Relay);
2. global sources, normally `~/.agents`;
3. explicitly configured shared sources;
4. each ancestor directory within the configured workspace boundary;
5. project-local source.

`AGENTS.md` instruction inheritance is separate from Agent definition
selection: it follows the bounded directory ancestry and applies instructions
in order; Agent Markdown must not be implicitly concatenated across names.
Agent inheritance through `extends:` is explicit, including `relay/<name>` and
`shared/<name>` (the shared base name may differ from the local Agent name).
A Shortcut is looked up **only through the effective Agent's source and
explicit inheritance chain**: `agents/<name>.agent.md` pairs with
`agents/.shortcut/<name>.agent.mjs` in that *same source*. A local Agent override
without `extends:` cannot accidentally execute a same-named shared Shortcut.
Prevent path escapes, symlink escapes, cycles and unauthorized executable
inheritance. Pin resolved sources and hashes in the execution/review evidence.

## Repository and Run isolation

A Neo Project is a **direct child of `NEO_ROOT` with its own Git root**, not a
subdirectory tracked by Neo Harness Git. `NEO_ROOT` belongs to Neo's caller-side
configuration; Relay receives the selected `projectPath` and discovers its
owning Git repository. Local-only project Git repositories are valid: a GitHub
origin is optional, and GitHub PR/review/merge is a separate adapter.

Source Git must ignore canonical `runs/`; private media, receipts, reviews and
nested per-Run `.git` histories remain in place. Source checkout, managed
worktrees and canonical private Runs are different paths/ownership layers.
Never rebind a pre-existing durable Job to a different repository identity
merely because its project directory acquired a new `.git`. Legacy Jobs/Run
bindings require a separate verified migration decision.

## Event, browser, review and escalation interfaces

- **Events:** Relay owns the lifecycle event *meaning* and correlation; the
  provider/transport (NATS, HTTP, etc.) is configurable. No fixed Neo endpoint,
  subject prefix or `NEO_*` environment variable is part of the target core.
- **Browser:** the browser-workspace name, session lifecycle and site actions
  are parameters/adapter capabilities. No fixed workspace named `Neo`.
- **Review:** Relay owns durable review/wait/decision state. Preview capture,
  video provenance, notifications and specific UI clients are capabilities of
  caller-provided adapters, not Relay-wide rules.
- **Escalation:** graph-owned escalation may invoke a configured executor, but
  the core cannot require a `neo` executable on `PATH`.
- **Workers:** a Job must complete without Neo.app installed, if its configured
  workers, event transport and external adapters are available.

## Remaining implementation gaps (verified 2026-11-09)

| Runtime source | Observed Neo coupling | Target change |
| --- | --- | --- |
| `src/cli-escalation.ts` | No Neo import or fixed executable | `AGENTS_RELAY_ESCALATION_COMMAND` selects the external CLI; missing/broken executor yields `technical_failure` |
| `src/browser-worker-runtime.ts` | WebHelm-specific transport/session protocol | Workspace defaults to `Relay`, overridable by `AGENTS_RELAY_WEBHELM_WORKSPACE`; future adapter extraction should make browser providers interchangeable |
| `src/events-bus-runtime.ts`, `src/events.ts` | Migrated to `EVENTS_BUS_*` and `relay.events.job` in source | Coordinate publisher, recorder and consumers before live subject cutover |
| `src/agent-shortcut.ts` | Vlog-specific validation removed; generic artifact hashing and stage gate retained | Project Vlog Shortcut and Stage contract now own Visioner checks; verify when migrating durable waits |
| `src/relayd-control.ts`, `src/interactive-request.ts` | Generic lifecycle and `interactive-review` event component | Host-owned media/notification integrations remain outside Relay; no new Preview adapter needed |
| `src/managed-worker-input.ts`, `src/agent-prompt-builder.ts` | Worker prompts now accept provider guidance from execution context | Repo Git root is supplied as cwd; verify each adapter's actual workspace execution |
| `src/cli-help.ts`, `src/relayd-utilities.ts` | Some CLI descriptions still claim implicit Neo shared roots | Align help text with explicit shared-root contract |

### Implementation order

1. **Browser workspace ownership (implemented locally):** use `Relay` as the
   default workspace and allow an operator-configured name. An existing `Neo`
   browser workspace is left untouched; neither open Sessions nor idle groups
   are silently migrated. Later, extract WebHelm provisioning as an adapter.
2. **Event transport (Neo Master cutover verified):** `EVENTS_BUS_*`
   variables and `relay.events.job` are the configured event settings. The
   deployed recorder, Relay, and Chat Gateway were verified on the new
   namespace with actual NATS publication and history read-back. Other
   deployments must still follow
   `neo/skills/events-bus/references/relay-namespace-cutover.md`;
   preserve existing history and durable identity.
3. **Escalation (implemented):** the single environment variable
   `AGENTS_RELAY_ESCALATION_COMMAND` accepts an absolute executable path or a
   JSON argv vector for a command prefix. Relay appends the generic handoff
   contract flags and captures `resolved`, `failed` or `needs_user` results.
   Example: `["/opt/homebrew/bin/neo","escalation"]` in Neo's deployment,
   not Relay source. Missing, broken or malformed executors resolve to
   `technical_failure`, never optimistic completion.
4. **Domain policy (implemented locally):** Visioner/Markcut provenance
   checks moved to Vlog `lib/validate-visioner-result.mjs` and its existing
   project-owned Stage gate. Relay retains only generic receipt, identity,
   hash and path checks plus opt-in declared Stage validation.
5. **Interactive Review (implemented):** Relay issues host-neutral waiting
   events with `component: interactive-review`; its existing begin, wait,
   ready, fail and abort operations remain unchanged. Neo's Markcut wrapper
   and mobile Review Inbox supply media, delivery and decisions separately.
   There is no need for a new generic Preview Provider framework.
6. **Worker prompt (implemented locally):** the same generic bootstrap applies
   to Codex, ChatGPT and Z. Provider-specific instructions are an explicit
   Job Execution Context option. The owning Git root is surfaced as cwd,
   and local Codex defaults to that directory when routing lacks a cwd.
   Other legacy help/telemetry references are separate cleanup.

Each phase must have read-back tests and must not alter live jobs or transport
bindings without an explicit migration plan. No one-shot replacement of all
providers is needed to make the core generic.

The residual coupling list is deliberately explicit so a docs-only change
cannot be mistaken for a completed runtime hotfix. Domain-specific adapters
may continue to support Neo and Markcut **under configured integrations**;
the violation is requiring or defaulting to them in generic Relay.

## Acceptance gates for the eventual runtime cleanup

- Relay builds and executes a complete local-only Git Job without a Neo
  installation, Neo source checkout or `NEO_*` environment variables.
- Effective Agent, Skill, explicit Agent `extends:` and source-owned Shortcut
  selection agree across worker, planner, reviewer and Shortcut dispatch.
- Nested independent Git repos are discovered by their actual owning Git
  root; private Run Git histories are neither staged nor migrated implicitly.
- Event, escalation, browser and review providers are configurable and can be
  absent for workflows that do not need them.
- Durable Jobs and historical Run bindings retain their identity until
  explicitly migrated with verified read-back.
- Tests exercise non-Neo callers and real managed execution, not just
  configuration parsing or prompt construction.

Changes to this boundary must also satisfy the canonical Relay
[Design Principles](../DESIGN-PRINCIPLES.md) and workflow graphs. This page
is the integration specification, not a second lifecycle state machine.
