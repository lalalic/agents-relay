# Agents Relay Skill evals

Real goal: select and use durable Relay Jobs/Tasks only when needed, plan and verify work safely, inspect authoritative results, recover failures, and escalate genuine human blockers. These cases test the **agent's decision**, not the Relay implementation.

## Capability matrix

The provider-independent `capabilities.json` contains 35 cases across:
- direct vs managed routing (including unauthorized job creation);
- create/create-only/adopt/local-only and durable dependency handoffs;
- Planner apply, rejected candidate, and unknown/stale execution;
- role-specific Spec Kit selection, assigned-Task boundaries, read-only review, and non-spec fallbacks;
- Task event and status authority, correct execution identity;
- Reviewer completed-negative verdict vs unavailable review evidence;
- Troubleshooter diagnosis, recovered Task, shared defect/P0 blocker, human escalation and resumption;
- project-specific content approval and service management.

Run with Codex's existing login and a chosen model:

```sh
npm run test:skill:luna
# Or any supported Codex model:
node skills/agents-relay/evals/run-codex.mjs --model gpt-6-luna --batch 5 --output /tmp/relay-skill-results.json
```

The runner sends the real `SKILL.md` plus user requests to the target model in **read-only dry-run mode**; it collects intended action, verification, and avoided hazards. It checks decisions, required CLI commands/flags, and explicitly prohibited actions deterministically. Output includes each failed case and the full model response for review. If an assertion is too strict (e.g. demanding the text `plan apply` when `apply_cli` is the correct bound command), fix the eval specification, not the skill.

Regrade a saved, immutable Luna response transcript after fixing a demonstrably over-strict evaluator (without calling the model again): `node skills/agents-relay/evals/run-codex.mjs --regrade /tmp/old-report.json --output /tmp/regraded-report.json`. The new report records `source_run` and `regraded_at`; it is **not** a fresh model pass.

The source-level `test/agents-relay-skill-evals.test.js` verifies fixture completeness only. Do **not** report its passing status as successful model evaluations.

## Separate L4 role Prompt Evals

`npm run test:verification:l4` now runs real generated role/adapter Prompt checks **and** model-based dry-run behavioral scenarios against the generated Prompt and immutable referenced Agent snapshot. `npm run test:verification:l4:contracts` is the deterministic contract suite without model calls; `npm run test:verification:l4:live` probes actual browser/MCP bootstrap. See `test/verification/l4/README.md`.

No dry-run eval can prove a terminal Worker event was persisted or a GitHub PR merged. True provider E2E tests must use an isolated Job and independently verify correlated events and durable output. Do not let an eval perform real GitHub/Job actions.

Role-specific cases load the current agent Markdown alongside the Relay Skill, so the model chooses behavior against actual role contracts. Use `--only spec-planner-select-plan,spec-implementation-bounded,spec-implementation-entire-feature,spec-reviewer-readonly,spec-recovery-gap,nonspec-planner-no-speckit` for focused selection checks.
