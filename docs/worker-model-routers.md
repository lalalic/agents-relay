# Execution Router and typed decisions

Agents Relay routes model-backed executable work with one **Execution Router** decision. The router chooses a complete executable route: worker + provider/model/profile/reasoning.

```text
Task + workerRequirements + resource/runtime facts + Router Rules
  -> discover workers and configured/authorized models
  -> profile defaults + explicit [choices] (deduplicated, merged)
  -> remove only impossible routes (hard gates)
  -> decide(one merged choice list)   [routing-instruction passed verbatim]
  -> persist workerSelection + routing
  -> worker.selected
  -> model.selected
  -> launch

Decision unavailable/invalid/fails
  -> usable Codex default route fallback
```

## Decision boundary

The router keeps hard gates intentionally narrow. Explicit runtime/provider/model/profile constraints, an explicitly offline worker, zero Browser Workspace allocatable capacity, an unconfigured or unauthorized model, and a provider/profile known unable to execute may remove a candidate route.

Everything else is normally soft decision context: task capabilities, task kind, trust/region/labels, quota pressure and reset horizon, cost, latency, quality, runtime load, reviewer diversity, and human-maintained free-text guidance. The complete `workerRequirements` object is passed into the decision facts even when its fields are soft.

The Execution Router rules file is the single policy surface and uses two explicit sections:

```text
[choices]
openai: sol medium, luna high
zai: glm-5.3-flash high

[routing-instruction]
Prefer zai until its quota resets; otherwise use the openai default.
```

`[choices]` is an additive list of `provider: model [reasoning]` routes. Relay merges it with the discovered profile defaults, deduplicates the result, and applies the authoritative hard gates; the surviving set becomes exactly one merged choice list that Laya chooses from. Runtime catalog models are **not** auto-added: a catalog model becomes a choice only when an explicit `[choices]` entry names it. Relay does not parse or repair user intent beyond reading these explicit entries.

`[routing-instruction]` is opaque guidance forwarded to Laya verbatim; the active one-stage decision reads it as `facts.routing_instruction`. The section body is preserved byte-for-byte: leading/trailing whitespace, blank lines, and line endings are not trimmed or normalized, and the header line's own terminator is not attached to the instruction. Text outside both sections is ignored, so legacy free-text files remain valid but no longer influence routing. Non-OpenAI Codex profiles remain eligible only when their configured provider/model is present in the discovered profile defaults or an explicit `[choices]` entry.

## Job routing preferences (durable soft hints)

`agents-relay job create` and `job update` accept `--prefer-adapter`, `--prefer-provider`, `--prefer-model`, `--prefer-profile`, and `--prefer-reasoning`. The values are exact, case-sensitive route identifiers but **advisory**: Relay persists a `routingPreferences` object in the canonical Job, considers it when ranking *already eligible* Worker+Model routes for unpinned normal Tasks, and records `execution-router:job-preference` as the deterministic selection source. Preference mismatches cannot make an ineligible route executable. An explicit Task route or authenticated decision choice takes precedence; if no eligible route matches a hint, the normal Codex fallback applies. Partial matches rank by adapter, provider/model, profile, then reasoning, and the previous deterministic fallback wins ties. Final Review uses its independent reviewer routing and does not inherit the Job hint. Updating a Job affects only future Task route decisions; existing selected/running routes are unchanged. `--clear-routing-preferences` clears hints.

The Decision Engine receives the exact Job preferences both as structured facts and as an appended routing instruction explicitly above conflicting global `[routing-instruction]` guidance and Agent/default hints. Candidate labels identify configured profiles; the Engine can still choose any eligible route. Hard gates and explicit Task constraints remain authoritative. When no typed decision is available, Relay's deterministic fallback can use Job hints without interpreting free-text global routing instructions.

## Agent model preference (soft hint)

An Agent may declare `model: openai/gpt-6` and/or `reasoning: high` in [frontmatter](../skills/agents-relay/contracts/agent-contract.md). Relay passes these preferences to the unified Router **decision prompt**; they are not Worker prompt instructions, hard requirements, or new `[choices]` entries. Explicit Job preferences and global user-authored `[routing-instruction]` take precedence, and the same availability, hard gates, eligible candidates, and deterministic fallback still apply. A missing preference leaves routing unchanged.

## Codex fallback

Codex is the deterministic safety fallback, not the default winner. When the typed decision succeeds, any listed route may be selected. When the decision engine is unavailable, fails, times out, returns malformed data, or returns an out-of-contract choice, the router chooses a usable Codex route and prefers Codex's configured default profile. If no Codex route is executable, the first remaining executable route is used rather than fabricating a route.

The fallback deliberately does not reproduce the intelligent policy layer. Its job is to preserve execution, not optimize it.

## Typed Laya decision

`LayaCliDecisionEngine` remains stateless. Each routing decision invokes one transient `uvx laya-mlx predict` subprocess with a JSON state file and one bounded choice contract. Relay sends exactly one merged choice list per decision, so Laya cannot select an unconfigured worker, provider, model, or profile, and a single decision covers worker and model together.

There is no production resident Laya service and no separate worker/provider/model/reasoning decision chain for the normal pipeline.

## Durable compatibility and observability

The unified decision still persists the existing durable fields separately: `workerSelection` identifies the chosen execution worker and `routing` identifies provider/model/profile/reasoning. Existing consumers therefore do not need a schema migration.

For compatibility and UI clarity Relay still emits `worker.selected` before `model.selected`, even though both values come from the same Execution Router decision. The decision evidence is shared by both persisted results.

Final reviewers use the same unified route selection as ordinary executable tasks. Reviewer diversity is soft context and does not override explicit user guidance.

## Recovery and audit

Normal task launch uses Execution Router. Existing model re-decision support remains available for evidence-backed provider/model runtime recovery so failed routes can be excluded without retrying blindly. Decision audit records continue to retain task correlation, policy/rules snapshot, selected route/model facts, engine evidence, and fallback evidence.

Legacy `routeWorker` / `routeModel` helpers remain compatibility/recovery utilities; they are not the normal reconciler routing pipeline.

## Detached routing CLI

Any component can select a local Model Worker and its configured model using
the **same Execution Router as Relay Workers**, without creating a Job.
The live daemon supplies the shared provider observations (default loopback
port 8787; `--port` selects an isolated or explicitly configured local daemon):

```sh
agents-relay route --input-file request.json
```

```json
{
  "taskFacts": {"task": {"taskCapabilities": ["vision"], "storySize": "S"}},
  "routingPreferences": {"profile": "neo"},
  "routingInstruction": "For this request prefer visual quality over latency."
}
```

The CLI calls canonical profile discovery, hard-gate evaluation, Jev selection,
and deterministic fallback. The local Codex executable must be on PATH. It uses
`CODEX_HOME` (default `~/.codex`), the same configured profile discovery,
`~/.agents-relay/routing-policy.json`, and global router rules (explicit
`--execution-router-rules PATH`, `AGENTS_RELAY_EXECUTION_ROUTER_RULES`, then
`~/.agents-relay/execution-router-rules.md`).

All fields are optional. `routingPreferences` uses the same advisory fields
and fallback matching as Job preferences. `routingInstruction` is higher
priority than conflicting global guidance, structured preferences and defaults,
but does not override hard eligibility or interpret free text on fallback.
`routingConstraints` accepts exact provider/model/profile/reasoning constraints;
`eligibleProfiles` further limits candidates to verified profile identifiers
(use `default` for the implicit base profile). `excludedRoutes` removes known
failed provider/model/profile combinations. `workerRequirements` uses the
same Worker constraints as Relay. By default, detached callers (including
Outcome/Preflight Reviewers) read the daemon-owned provider observation and
the same bounded route history as managed agents. A failed observation request
is reported instead of silently routing without quota context. Explicit
`usage` and `recentRouteResults` (at most ten) permit isolated tests. These
are facts, not additional profiles or choices.

The output contains the canonical `selection`, `model` and `routing` objects,
including `routing.decisionEvidence`. Single eligible routes bypass Jev;
engine failures use the same eligible-route fallback and structured preference
ranking as Workers. No eligible route is an error. `--input-file -` accepts
JSON on stdin, up to 1 MiB. Routing facts, instructions and eligible choices
are sent to the configured Jev engine; provide authorized routing metadata
only, not secrets or private inference payloads. The command makes a route
decision, not a model invocation; the caller owns execution, retries and
any audit persistence. The CLI does not access Job state or create Job events.
