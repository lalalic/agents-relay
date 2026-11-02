# Agents Relay Skill capability evaluations

These cases evaluate **agent decisions**, not whether the Relay implementation functions. They are derived from the user capabilities: route direct vs durable work, create/adopt, plan, inspect/review, recover/escalate, execute with a pinned context, and manage services.

Use `capabilities.json` as a provider-neutral case set. For each case, supply the active `SKILL.md` and `request` to the target agent, ask for a **dry-run** decision (no CLI side effects), and normalize its answer to:

```json
{"decision":"direct|create|adopt|inspect|plan|task_create|review|recover|escalate|service|worker_context","action":"intended CLI subcommand or direct operation","verification":"required evidence","avoid":"unsafe assumption to avoid"}
```

Check `expected.decision` and, when present, `expected.command` / `expected.flags` deterministically. An answer fails when it recommends any `forbidden` behavior. Use a qualitative rubric only if an answer is ambiguous despite having correct structured fields. Cross-provider execution may use any authenticated harness but must not silently change case expectations.

`test/agents-relay-skill-evals.test.js` checks **fixture integrity and coverage only**, not model compliance. The generated-prompt L4 tests check prompt references and runtime bootstrap, not the model's semantic decisions. Do not report these as live-provider behavioral passes.

Separately, real integration tests must verify CLI create/show, generated role prompts on each supported adapter, event correlation and start/progress/terminal state, reviewer changes-required, planner apply receipt, recovery, and failed/unknown outcomes. Never run real integration tests with the canonical user Job store or create remote PRs without explicit authorization.
