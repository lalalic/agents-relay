# Worker Router, Model Router, and typed decisions

Agents Relay routes model-backed executable work in two code-driven stages:

- **worker-router** chooses the execution environment;
- **model-router** chooses the model/profile inside that environment.

Neither router delegates its decision to a free-form routing agent. Each router gathers authoritative facts in TypeScript, applies deterministic hard gates, then optionally calls the shared typed `decide(request, contract)` primitive to judge among the remaining legal choices.

```text
Task
  -> worker facts + hard gates
  -> decide(choice of eligible workers)
  -> selected worker
  -> model/profile facts + hard gates for that worker
  -> decide(choice of eligible profiles)
  -> persist worker/model decisions
  -> worker.selected
  -> model.selected
  -> launch
```

## Responsibility boundary

| Component | Owns | Must not do |
| --- | --- | --- |
| worker-router code | worker discovery, capabilities, availability, trust/runtime/resource facts, hard worker eligibility | choose a model/profile |
| model-router code | profiles usable by the selected worker, model/provider/resource facts, hard model eligibility | switch to another worker |
| `decide()` | typed judgment among caller-supplied legal choices | discover facts, weaken hard gates, know routing semantics |
| `src/usage.ts` | canonical account usage / credit observations | routing policy |

The caller constructs both the **request** (JSON-safe facts) and the **contract** (currently a bounded `choice` contract). `decide()` returns a typed result and validates that the answer stays inside the contract.

## Hard gates first

Worker eligibility is determined before a decision call. Capability, runtime, availability, trust domain, region, labels, explicit constraints, and known impossible resource state remain deterministic constraints.

After the worker is selected, model-router discovers only profiles usable by that worker. Provider/model/profile constraints and known impossible resource state are applied before a decision call.

If only one legal choice remains, the router selects it directly without invoking Laya.

## Laya CLI decision engine

`LayaCliDecisionEngine` is intentionally stateless. Each decision writes temporary JSON state/question files, starts one transient `uvx laya-mlx predict` process, reads one JSON decision from stdout, removes the files, and exits. Agents Relay does **not** run a resident Laya daemon, sidecar, socket service, PM2 process, or permanently loaded model.

Default command contract:

```text
uvx laya-mlx predict --state-file <state.json> --questions <questions.json>
```

The adapter writes the caller facts to `state.json` and the typed decision contract to `questions.json`. The questions file is shaped like:

```json
{
  "decision": {
    "type": "choice",
    "instructions": "Which eligible choice best fits this task?",
    "criteria": ["candidate-a", "candidate-b"]
  }
}
```

It must write JSON containing either a direct `choice` result or `answers.decision`, for example:

```json
{
  "answers": {
    "decision": {
      "choice": "candidate-b",
      "probabilities": {
        "candidate-a": 0.2,
        "candidate-b": 0.8
      }
    }
  }
}
```

The concrete command is replaceable without changing routing code:

- `AGENTS_RELAY_LAYA_ARGS` — JSON string array of base arguments, default `["laya-mlx","predict"]`; the adapter appends `--state-file` and `--questions` paths;
- `AGENTS_RELAY_LAYA_TIMEOUT_MS` — per-decision timeout, default 30000 ms.

The default CLI is the `laya-mlx` package executed transiently through `uvx`; no project venv or resident model process is required. Routing still fails closed to the deterministic policy if `uvx`/Laya is unavailable or invalid.

## Active decision behavior

Laya decisions are authoritative whenever more than one legal candidate remains. The runtime always uses active mode; there is no production `off`/`shadow` configuration switch.

If Laya exits non-zero, times out, emits malformed JSON, or returns a choice outside the caller's contract, routing falls back to the deterministic policy. Hard gates remain authoritative and an invalid Laya answer can never make an ineligible worker or model eligible.

## Model profile discovery

For the built-in Codex worker, model-router reads the actual local Codex configuration at routing time:

- the top-level model from `$CODEX_HOME/config.toml` (or `~/.codex/config.toml`);
- `*.config.toml` profiles and their configured provider/model/reasoning values.

For ChatGPT Browser Worker, the account-default model profile remains the single usable profile unless a richer configured profile surface is introduced later. Registered workers that explicitly pin provider/model metadata stay pinned to that configured route.

This keeps model selection after worker selection and removes the previous worker-router behavior that pre-populated provider/model defaults.

## Failure behavior

Routing does not depend on Laya availability. Non-zero exit, timeout, malformed JSON, contract violation, or unavailable CLI all return to the existing deterministic ranking. No task should fail solely because the optional decision engine is unavailable.

## Environment policy and decision audit

The model router loads one current, human-maintained JSON policy at decision time. Set
`AGENTS_RELAY_ROUTING_POLICY` or place `.agents-relay-routing-policy.json` in the
current project directory. Supported fields are `disabledProviders`,
`disabledProfiles`, `preferredProviders`, `preferredProfiles`,
`qualityByTaskKind`, and `recovery.penalizePriorRoute`. The policy refines legal
choices; it cannot override capability, privacy, task, continuity, or health hard
gates. No policy registry or policy-version lifecycle is created. Each audit record
stores the sanitized policy snapshot and SHA-256 content hash.

Every routed model decision can be persisted as JSONL through
`JsonlDecisionAuditStore`. Relay uses `AGENTS_RELAY_DECISION_AUDIT_PATH` when set,
otherwise `~/.agents-relay/decision-audit.jsonl`. Records use schema version 1 and
contain the correlation identifiers, task classification, worker, contract, policy,
all discovered candidates, gate-filtered candidates, resource windows, engine
evidence, fallback, selected route, and optional prior failure. Outcome records are
append-only and reference a decision ID, so historical decision facts are never
mutated. Secret-like fields are redacted before writing. The JSONL stream can be
replayed directly for evaluation or training fixtures without schema translation.

Troubleshooter recovery uses `redecideFailedTask`: it first requires durable event
and log evidence classified as `model_provider_runtime`, then takes a fresh usage
snapshot, rediscovers candidates, reloads the current policy, and invokes the same
worker-to-model router with structured prior-failure evidence. The action updates
the exact failed Task's routing and writes a linked audit record; it never retries
the Task. Troubleshooter separately reactivates/retries the original Task. Worker,
tool, infrastructure, semantic, and evidence-insufficient failures do not trigger
model re-decision automatically.
