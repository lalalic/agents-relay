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
