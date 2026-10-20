# Unified Agent PromptBuilder

## Scope

Planner, Reviewer, Troubleshooter, and Implementation Workers share `src/agent-prompt-builder.ts`.
The builder creates a logical `system` (role instructions/contracts) and `user` (durable task evidence) bundle, independently of whether the target adapter exposes an API system role. ChatGPT receives a single rendered user message. The Codex Planner and managed Worker paths use the same builder. Existing `plan apply` and first `task.started` event requirements remain in force.

## References

Effective, merged contracts are snapshotted to private content-addressed Markdown files (`sha256.md`, directory mode 0700, file mode 0600). Prompts include absolute paths and SHA-256 for accessible snapshots, otherwise fall back to inline instructions. The ChatGPT threaded delivery path includes verified snapshot contents inline because threaded browser delivery does not attach local files. The adapter reads only runtime-assembled manifests before the untrusted Task data boundary and only canonical paths within the configured snapshot directory; malformed, forged, or out-of-root entries cannot authorize file reads.

## Test levels

- L1 covers bundle rendering, isolation boundaries, hash integrity, snapshot access, Planner contract, Event contract, and both adapter renderings.
- L2 is `npm run test:l2:agents`. It prepares cases for all four roles on both renderings. The default is `NOT_RUN` rather than a fabricated PASS.
- Optional model-only L2 requires `AGENTS_RELAY_L2_LIVE=1`, an OpenAI API key (`AGENTS_RELAY_L2_OPENAI_API_KEY` or `OPENAI_API_KEY`), and `AGENTS_RELAY_L2_OPENAI_MODEL`. The runner calls the fixed OpenAI Responses endpoint with no tools, `tool_choice: none`, no storage, and verifies the provider model identity. The public ChatGPT UI does not currently expose a model-only transport through this test harness, so its real-model cases are explicitly `NOT_RUN`. Do not substitute Codex responses for ChatGPT.
- L3 remains the authoritative lifecycle integration suite (`npm test`) and does not treat prompt-only checks as proof of Worker recovery or full objective completion.

The separate `evaluation` mode removes production lifecycle instructions and retains role guidance as read-only evaluation criteria. It does not call Relay actions, event tools, or browser sessions. In production the Relay Graph and CLI remain authoritative for Action Guards, persisted state, and verified completion.
