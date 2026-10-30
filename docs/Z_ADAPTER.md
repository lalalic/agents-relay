# Z.ai Full-Stack worker adapter (feature branch)

The `z` worker adapter executes a real Agents Relay Task using Z.ai Full-Stack through
WebHelm's persistent Z platform. This is a browser worker, not the Z.ai API.

## Authorization

The Relay process performs Neo's OAuth Authorization Code + PKCE flow with a
local-only callback (`http://127.0.0.1:8765/neo/oauth/callback`).
The operator consent credential stays on Neo Master; the browser worker receives
**only a one-hour OAuth access token**, and Relay revokes the unused refresh token.

The default operator credential source is the NeoY-owned
`~/Library/Application Support/NeoY/core-token`, read by Relay on the same host.
Optional overrides: `AGENTS_RELAY_Z_NEO_OPERATOR_TOKEN_FILE`,
`AGENTS_RELAY_Z_NEO_OPERATOR_TOKEN`, and `AGENTS_RELAY_Z_NEO_ORIGIN`.
Never place the operator token in a Z.ai conversation or command arguments.

Until the WebHelm Z fix is installed globally, set
`AGENTS_RELAY_Z_WEBHELM_PLATFORM_DIR` to the checked-out
`browser-workspace/skills/webhelm/platforms` directory.

## Task lifecycle and prompt order

A Task with adapter `z` is routed to `z/webhelm` and the Z.ai Full-Stack
model `GLM-5.3-Flash`. The prompt is ordered to avoid a start-ack timeout:

1. State the boundary: Z cloud Bash is separate from Neo Master; use the authenticated HTTPS Neo MCP endpoint to change Neo files.
2. **FIRST ACTION:** run a single real Bash invocation that sets the short-lived OAuth token and publishes `task.started` via the Neo `events` MCP tool using the exact server-issued `job/<id>/task/<id>/execution/<id>` source. Inspect its JSON-RPC receipt.
3. Via Neo MCP, run `neo bootstrap` and read the canonical events-bus and Agents Relay contracts. The Neo bootstrap provides the Global AGENTS.md rules, XChat defaults, and dynamic Skills.
4. Execute the concise Task brief on Neo Master through Neo MCP. Local SQLite Task briefs are authoritative; do not detour to GitHub issues or inspect unrelated repositories. GitHub tasks retain their full normal contract.
5. Independently read back the output and verify every explicit acceptance criterion (e.g. required exact markers), not merely file existence.
6. **LAST ACTION:** publish exactly one `task.completed` with evidence or `task.failed` with a concrete reason, using the same exact execution source. Relay (not the worker) decides and persists the Task terminal state.

The Z WebHelm Session stays open until Relay observes the correlated terminal
event (`after-terminal` release policy). A browser submission receipt, code
build, or a worker's text response does **not** mark a Task successful. Start-ack
and terminal waits fail closed if no authoritative event arrives.

OAuth access tokens expire after one hour, are not silently renewed, and appear
only in the authorized Z worker chat (not the Neo operator/master token).
Keep them out of generated files, Git history, event payloads, and logs.

## Verification

- Browser platform: `pytest skills/webhelm/platforms/z/tests/test_contract.py`
  and a real `webhelm platform run z new-thread` receipt.
- Relay: `npm run build`, `node --test test/z-oauth.test.js`,
  `npm test`.
- NeoY: `xcodebuild test -project NeoY.xcodeproj -scheme NeoY -destination platform=macOS`.
- Production proof requires a real Z worker calling `tools/list`,
  `tools/call`, and publishing a terminal event accepted by the Relay
  store. A successful browser submission alone is not that proof.

## Live isolated E2E evidence (2026-10-30)

- Neo OAuth credential issued and Z.ai Full-Stack used the real authenticated Neo MCP `events`, `fs`, and `shell` tools.
- Isolated SQLite Job `4`, Task `z-local-html-v4`: real `task.started` was accepted (Task became `RUNNING`), Z wrote the HTML on Neo Master and then published `task.completed`; authoritative Task became `SUCCEEDED`.
- Independent acceptance review found the initially written HTML omitted the exact marker requested by Task. Isolated corrective Job `5`, Task `verify-exact-marker`, added `Z_RELAY_V4_DONE`, read back and verified it, published a correlated terminal event, and also became SQLite `SUCCEEDED`.
- Final verified file: `/Users/chengli/Workspace/z-adapter-e2e/relay-v4.html`. This is a small test fixture, not a production webpage.
- `npm run build`, targeted Z tests, and `npm run test:fast` passed. Test services ran on an isolated port and SQLite directory, not the live Relay instance.
- An additional one-pass load/reliability probe (Job `6`) remained in Z.ai generation without issuing a start event, and was explicitly cancelled after several minutes. Do not interpret Jobs 4/5 as proof of deterministic launch latency or automatic recovery from a stalled provider. Its test browser session was closed.
- The feature branch is not evidence of a production Relay deployment. Merge/release still requires the project's normal delivery process.
