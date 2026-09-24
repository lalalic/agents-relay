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

`LayaCliDecisionEngine` is intentionally stateless. Each decision starts one transient process, writes a JSON request to stdin, reads one JSON decision from stdout, and exits. Agents Relay does **not** run a resident Laya daemon, sidecar, socket service, PM2 process, or permanently loaded model.

Default command contract:

```text
npx -y laya decide --json
```

The process receives one JSON object shaped like:

```json
{
  "state": { "task": {}, "candidates": [] },
  "questions": {
    "decision": {
      "type": "choice",
      "instructions": "Which eligible choice best fits this task?",
      "criteria": ["candidate-a", "candidate-b"]
    }
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

- `AGENTS_RELAY_LAYA_COMMAND` — executable, default `npx`;
- `AGENTS_RELAY_LAYA_ARGS` — JSON string array of arguments, default `["-y","laya","decide","--json"]`;
- `AGENTS_RELAY_LAYA_TIMEOUT_MS` — per-decision timeout, default 30000 ms.

At the time this integration was added, the public npm package named `laya` did not expose a runnable executable in this environment. Therefore the default command currently fails closed and routing uses its deterministic fallback unless an actual compatible CLI/wrapper is installed or configured. This does not affect Relay availability.

## Rollout modes

`AGENTS_RELAY_DECISION_MODE` controls authority:

- `off` — deterministic routing only; no Laya invocation;
- `shadow` — invoke Laya and persist its proposed choice/evidence, but keep the deterministic route authoritative;
- `active` — use a valid Laya decision; any process, timeout, JSON, or contract failure falls back deterministically.

Invalid/out-of-contract choices can never bypass hard gates. The normal durable routing objects may include compact decision evidence (mode, engine, proposed choice, probabilities, fallback/error) for later evaluation.

## Model profile discovery

For the built-in Codex worker, model-router reads the actual local Codex configuration at routing time:

- the top-level model from `$CODEX_HOME/config.toml` (or `~/.codex/config.toml`);
- `*.config.toml` profiles and their configured provider/model/reasoning values.

For ChatGPT Browser Worker, the account-default model profile remains the single usable profile unless a richer configured profile surface is introduced later. Registered workers that explicitly pin provider/model metadata stay pinned to that configured route.

This keeps model selection after worker selection and removes the previous worker-router behavior that pre-populated provider/model defaults.

## Failure behavior

Routing does not depend on Laya availability. Non-zero exit, timeout, malformed JSON, contract violation, or unavailable CLI all return to the existing deterministic ranking. No task should fail solely because the optional decision engine is unavailable.
