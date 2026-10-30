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

## Task lifecycle

A Task with adapter `z` is routed to `z/webhelm` and model
`Z / GLM-5.3-Flash`. The adapter:
1. Obtains an OAuth credential and produces the Neo MCP curl bootstrap.
2. Submits the complete Relay task contract to a new, durable Z.ai thread.
3. Verifies WebHelm's durable submission receipt; closes its owned browser session.
4. **Does not mark the Task done.** The Z worker must publish correlated
   `task.started` and `task.completed` or `task.failed` through Neo's
   `events` MCP tool. Relay validates execution identity and lifecycle state.

All currently exposed Neo MCP tools are allowed under the server's `mcp`
scope. One-hour access tokens can expire during a long Task. There is no
automatic mid-task renewal in the browser worker yet; do not claim indefinite
execution from one submission. Z's cloud chat history includes the one-hour
worker credential, so treat it as transient and do not reuse it.

## Verification

- Browser platform: `pytest skills/webhelm/platforms/z/tests/test_contract.py`
  and a real `webhelm platform run z new-thread` receipt.
- Relay: `npm run build`, `node --test test/z-oauth.test.js`,
  `npm test`.
- NeoY: `xcodebuild test -project NeoY.xcodeproj -scheme NeoY -destination platform=macOS`.
- Production proof requires a real Z worker calling `tools/list`,
  `tools/call`, and publishing a terminal event accepted by the Relay
  store. A successful browser submission alone is not that proof.
