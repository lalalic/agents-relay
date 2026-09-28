# Execution Router and typed decisions

Agents Relay routes model-backed executable work with one **Execution Router** decision. The router chooses a complete executable route: worker + provider/model/profile/reasoning.

```text
Task + workerRequirements + resource/runtime facts + free-text rules
  -> discover workers and configured/authorized models
  -> build complete worker+model routes
  -> remove only impossible routes
  -> decide(one route)
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

Free-text guidance is the primary policy surface. The Execution Router rules file is the single free-text policy surface; it cannot invent routes because route discovery happens before the decision call. Non-OpenAI Codex profiles remain eligible only when their configured provider/model is explicitly authorized by the model rules.

## Codex fallback

Codex is the deterministic safety fallback, not the default winner. When the typed decision succeeds, any listed route may be selected. When the decision engine is unavailable, fails, times out, returns malformed data, or returns an out-of-contract choice, the router chooses a usable Codex route and prefers Codex's configured default profile. If no Codex route is executable, the first remaining executable route is used rather than fabricating a route.

The fallback deliberately does not reproduce the intelligent policy layer. Its job is to preserve execution, not optimize it.

## Typed Laya decision

`LayaCliDecisionEngine` remains stateless. Each routing decision invokes one transient `uvx laya-mlx predict` subprocess with a JSON state file and a bounded choice contract. Laya sees only route IDs supplied by Relay and therefore cannot select an unconfigured worker, provider, model, or profile.

There is no production resident Laya service and no second model-selection decision after worker selection.

## Durable compatibility and observability

The unified decision still persists the existing durable fields separately: `workerSelection` identifies the chosen execution worker and `routing` identifies provider/model/profile/reasoning. Existing consumers therefore do not need a schema migration.

For compatibility and UI clarity Relay still emits `worker.selected` before `model.selected`, even though both values come from the same Execution Router decision. The decision evidence is shared by both persisted results.

Final reviewers use the same unified route selection as ordinary executable tasks. Reviewer diversity is soft context and does not override explicit user guidance.

## Recovery and audit

Normal task launch uses Execution Router. Existing model re-decision support remains available for evidence-backed provider/model runtime recovery so failed routes can be excluded without retrying blindly. Decision audit records continue to retain task correlation, policy/rules snapshot, selected route/model facts, engine evidence, and fallback evidence.

Legacy `routeWorker` / `routeModel` helpers remain compatibility/recovery utilities; they are not the normal reconciler routing pipeline.
