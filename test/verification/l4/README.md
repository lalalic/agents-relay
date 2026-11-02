# L4 Prompt Evals

L4 runs **real-model behavioral evaluations** using generated production Graph Action Prompts and immutable Agent snapshots. Static Builder contract checks are prerequisites, not a substitute for reasoning/effective role behavior.

```sh
# Full suite: build -> deterministic Prompt/CLI parity -> model behavior through authenticated Codex Luna
npm run test:verification:l4
# Static-only contract suite (no model invocation)
RELAY_L4_OUTPUT_DIR=/tmp/relay-l4-prompts npm run test:verification:l4:contracts
# Change model and report path without modifying fixtures:
RELAY_L4_MODEL=gpt-6-luna RELAY_L4_REPORT=/tmp/l4-luna-report.json npm run test:verification:l4
```

The behavioral suite uses `model-cases.json` with 10 read-only scenarios: Planner apply and stale fencing, Implementation ChatGPT/Z startup, Reviewer negative and evidence failures, Troubleshooter history diagnosis, Vlog stage approval, and QA playback evidence. `run-model-evals.mjs` sends the actual generated Prompt and pinned Agent snapshot to the configured model, then grades structured decisions and explicit behavior markers without performing real Task actions. The report records full responses and failures; never count model dry-run responses as accepted Task events.

Saved L4 model responses can be independently regraded using `node test/verification/l4/run-model-evals.mjs --regrade /tmp/old-report.json --output /tmp/new-report.json`. This explicitly records provenance and is not a new provider execution.

## 1. Generate, audit and compare all real Builder prompts

The optional output directory receives `matrix.json` and all 14 actual
production-Builder Prompt texts (`<role>-<adapter>.txt`, mode 0600). Four
unsupported runtime combinations have no fabricated prompt file.

| Agent role | Codex | ChatGPT Web | Z Web | Required files |
|---|---|---|---|---|
| Planner (Vlog-specific) | Production Planner | Preview only (no dispatch) | Preview only (no dispatch) | Merged Vlog Planner Agent, Task/Job Contract. Zero Context files |
| Implementation | Worker | Worker | Worker | Selected Agent, 3 runtime Contracts; one project AGENTS for Web |
| Reviewer | Worker | Worker | Worker | Reviewer verdict/head SHA rules, 3 runtime Contracts; project AGENTS for Web |
| Troubleshooter | Worker | Runtime rejected | Runtime rejected | Recovery policy, 3 runtime Contracts; project AGENTS for Web |
| Vlog Producer | Runtime rejected | Interactive Worker | Runtime rejected | Producer Agent, stage contract referenced on demand; project AGENTS for Web |
| Vlog Final QA | Needs media playback evidence | Worker | Needs media playback evidence | QA Agent, project consent/privacy rules available on demand; project AGENTS for Web |

All 18 role/adapter pairs are checked. 14 variants can be generated as
Prompt Builder output; four are rejected at the Graph Action boundary because
the selected Agent or Task declares a hard runtime requirement. The other
Prompt variants must be generated from the same Graph Action Builder that
the live runtime uses. The CLI output is compared **byte-for-byte** for
every variant. The test resolves, reads, and SHA-verifies every referenced file.
It rejects stale execution IDs on real isolated SQLite, duplicated inherited
context, irrelevant README files, and unneeded event rules in Planner.

The local Project is `/Users/chengli/Workspace/neo/vlog` by default. It can
be overridden with `RELAY_L4_VLOG_PROJECT` if another real Vlog project has
its own `agents/planner.agent.md`, `AGENTS.md`, and `graph.mmd`.

## 2. Verify external Bootstrap transport

```sh
npm run test:verification:l4:live
```

Optional independent model probes:

```sh
RELAY_L4_CODEX_MODEL_EVIDENCE_FILE=/tmp/<verified-codex-response> \
RELAY_L4_CHATGPT_TOOL_PROBE_FILE=/tmp/<verified-neo-mcp-file> \
npm run test:verification:l4:live
```

Live checks verify actual CLI/Chrome readiness, Z's one-hour OAuth, Neo MCP
`fs` access to the **same immutable Agent snapshot**, and Neo shell Bootstrap.
The JSON report is redacted and private. A model read-only tool probe is
stronger than browser submission alone; still not a Task terminal event.

The matching `dist/cli.js` is resolved from the Prompt-pinned Skill; never
assume the globally installed CLI has the same capabilities. Web Browser
delivery IDs and attachments must not be appended to generated Prompt text.

The separate Relay L3 tests validate lifecycle and SQLite event transitions;
model-backed provider E2E must independently prove correlated `task.started`,
progress as necessary, exactly one accepted terminal event, and durable
Output for an isolated real Task. An L4 bootstrap probe must never publish
fabricated task lifecycle events or mutate a user's real Job.

## Role feasibility and known limits

A valid Prompt is NOT evidence that the selected Adapter can fulfill the
role. The Graph/Router must honor hard `task.workerRequirements.runtime` and
Agent `runtime`; `managedWorkerInput` rejects mismatches rather than sending
a doomed Worker. Vlog Producer needs an interactive ChatGPT Preview gate; the
real Job 537 Producer Task 476 correctly pins `runtime: chatgpt`. Job 537
Final QA Task 477 currently lacks an explicit worker capability requirement,
and its real playback/audio inspection on Codex or Z is NOT_VERIFIED.
A compatible Bootstrap still requires the model to perform real work and
publish the exact `task.started`, optional `task.progress`, and one accepted
terminal event. This L4 suite never creates success events for fake Tasks.
