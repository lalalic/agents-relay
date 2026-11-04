# ZCode Desktop Worker

## Architecture

The persisted adapter name stays 'z' for existing SQLite tasks; runtime id is 'zcode/desktop'. The previous Z.ai WebHelm adapter is no longer constructed by the CLI or daemon. ChatGPT's WebHelm integration is unchanged.

ZCode must be installed and signed in on Neo Master. The adapter controls the existing ZCode.app Electron renderer via local Chrome DevTools Protocol (CDP). The GUI performs Host -> V4 CLI commands. Relay neither starts a second ZCode CLI instance nor writes ZCode session state.

Start ZCode Desktop with local CDP:

    open -a /Applications/ZCode.app --args --remote-debugging-port=9237 --remote-debugging-address=127.0.0.1

The adapter uses localhost:9237 by default; AGENTS_RELAY_ZCODE_CDP_PORT can select another port. It verifies one ZCode.app renderer and a loopback WebSocket address, and fails closed if the app is not debuggable.

SECURITY: CDP is unauthenticated. Never expose the debugging port on another interface or forward it to untrusted systems. Do not restart a running ZCode app just to enable CDP when it may have active work.

## Sessions and queue

New thread creates a real ZCode New Task, sends the input using the native composer, and records the rendered session ID. New turn selects the exact existing session ID and verifies it before submitting. Concurrent Relay processes use a short cross-process UI lease to prevent composing into the wrong thread.

During a running turn, the native Send button is hidden until the follow-up is typed; then ZCode exposes Queue message. The adapter waits for that control before dispatch. Physical V4 queued receipt with queue ID was observed on Neo Master.

ZCode's native follow-up mode defaults to queue. When the current V4 session is busy, a normal follow-up is sent to its authoritative V4 queue; the adapter reads queued item IDs from the ZCode UI projection and records queue receipt information. An admitted queued item is not the same as a completed Relay task.

A 'zcode-thread' Relay continuation sends to that same session, even if it is busy. A known queued input can be withdrawn by its exact queue item ID. A failed or uncertain Send is never blindly retried. Relay SQLite and terminal task events remain the sole sources of Relay task state.

## Workspace and limitations

The current Desktop UI does not expose a supported external set-cwd API. Relay injects the absolute routing.cwd into the worker prompt, but this is NOT OS-level path isolation. The user's macOS and Neo MCP permissions are the actual security boundary. The adapter refuses ambiguous multiple ZCode windows or nonempty unsent drafts rather than guessing.

ZCode Neo MCP is configured at ~/.zcode/cli/config.json with protocolVersion 'legacy', using the authenticated local Neo Master MCP URL and 0600 file permissions. Never print or commit its token.

## Verification

    npm run build
    node --import ./test/test-store-env.mjs --test test/z-bootstrap.test.js

A complete Relay E2E requires an actual model answer, a real Neo MCP tool call and correlated Relay terminal event. Native Desktop create/continue and V4 queued-then-drained follow-up have passed using a temporary one-tool diagnostic MCP fixture. The resulting queued item had a real ZCode queue ID, and its reply arrived after the prior turn.

**Production release blockers:** The original Neo MCP tool catalog (23 Neo tools; 78 overall model-request tools) caused Z.ai provider error 1210; five raw Neo tools (61 overall) and even the same five without Schema examples also failed. A minimal one-tool diagnostic fixture and a two-tool (status + events) fixture allowed the model to answer, isolating a Neo tool Schema compatibility issue but not yet proving a production-safe workaround. Further tests reached the Z.ai Coding Plan five-hour usage limit (the UI displayed reset at 2026-11-04 12:06:53, timezone unspecified). The original authenticated 23-tool Neo MCP config was restored; all temporary diagnostic fixtures were removed. Keep this feature branch unmerged and out of live Relay until full provider, real Neo tool call, cancellation, and task-terminal E2E pass.
