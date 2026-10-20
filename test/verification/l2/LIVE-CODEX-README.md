# Real Codex Worker L2

`npm run test:verification:l2:live-codex` runs the isolated test runner. Set `RELAY_L2_LIVE=1` to invoke a real Codex CLI model. By default it does not invoke any model and reports NOT_RUN.

The runner uses the production `routeExecution` and Codex model discovery restricted to verified OpenAI/ChatGPT OAuth routes, selecting the lowest grounded combined standard text-token input/output price from the recorded pricing snapshot. Prices for custom DeepSeek/Z.ai profiles are not validated and these profiles are excluded instead of inventing costs. The price ranking is a proxy for the cheapest route, not a measured billed cost; actual tokens and plan charges can differ.

Each of four Agent roles has two cases, producing eight tests. The Job 482 test is a synthetic reproduction of contradictory MCP evidence, not a live Job recovery. Real Codex CLI is executed in disposable fixtures; decision tests use read-only sandbox; the isolated file-action case uses workspace-write and a local-only MCP events sink, enforcing the expected source.id, without touching production SQLite, GitHub or NATS. The event sink verifies transport evidence and does not independently establish Relay production state transitions.

The evidence file `evidence/live-codex-agents.json` records Router selection, model, prompt digest, test verdicts, processes, and local event types; generated fixture directories are destroyed by default. Do not interpret this L2 evidence as end-to-end production Job recovery or ChatGPT Adapter approval.

## Isolation boundary and auditability

The fixture worktree is disposable, and the model's write sandbox is restricted to that workspace with network disabled. **Read isolation is not a security guarantee:** Codex CLI must use the existing `CODEX_HOME` authentication state, and workspace-write sandboxing can still allow reads outside the fixture (including the repository's shared Agent/Event contracts). Run this harness only against synthetic, nonsensitive inputs on a trusted test node. The executable subprocess environment uses an explicit allowlist rather than inheriting environment secrets. Do not run against confidential Jobs or assume production credential read isolation.

The evidence report includes trimmed model responses (synthetic task input only) and validated local-event summaries so an independent reviewer can audit the rubrics. A non-live invocation writes a separate temporary NOT_RUN report rather than overwriting checked-in PASS evidence. The action case fails if any local event is invalid, even if other events are accepted.
