# Shared execution context

Agents Relay and the XChat bootstrap use one resolution contract at execution time:

```ts
resolveExecutionContext(projectPath, role, explicitSkills?, explicitAgents?)
```

The result contains the bound project, inherited instruction text and files, visible skills, visible agents, runtime capabilities, and the Relay-only nested delegation rule. Paths are resolved when a task launches; durable task markers store names and selections, never resolved absolute paths.

Resolution order is project-local, then Neo shared, then global `~/.agents`. Duplicate skill or agent names resolve to the first visible entry in that order. Explicit selections are name-based and fail closed when a requested entry is not visible. The resolver accepts configured Neo/global roots through options or `AGENTS_RELAY_NEO_ROOT`, `AGENTS_RELAY_NEO_SKILLS`, `AGENTS_RELAY_GLOBAL_SKILLS`, and `AGENTS_RELAY_GLOBAL_AGENTS`; it does not assume a particular user or checkout path.

Ownership is deliberately split:

- The shared resolver owns project instructions, skill/agent visibility, precedence, and runtime metadata.
- Relay owns durable GitHub task state, lineage, leases, retries, event lifecycle, routing, and review gates.
- Planner, reviewer, normal worker, and nested worker prompts consume the resolved context.
- Workers may inspect visible agents, but nested work must be created as a durable Agents Relay child task with `parentTaskId`; workers must not spawn arbitrary child agents directly.
- The ChatGPT adapter resolves `chatgpt-browser-worker` from the context and loads its agent/scripts from that resolved skill. Relay does not bundle a second copy.

XChat should call this resolver (or the equivalent shared lower-level implementation) during bootstrap and pass the resulting context into Relay. Leaf workers receive the generic resolved context, not the full XChat orchestrator skill or its top-level lifecycle responsibilities.
