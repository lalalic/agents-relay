# Native service operation

Use the installed native `agents-relay` CLI and `agents-relayd` daemon from the same immutable release. See root [README](../README.md) for build, CLI, service and release commands. PM2 manages the Relay daemon; Node scripts are management tools, not a backend. No npm Relay backend, workspace scan or implicit caller-specific dependency.

`skills/agents-relay/bin/services.mjs status` and `doctor` inspect service health/configuration. Verify CLI and daemon revisions and actual HTTP `/api/version` before declaring installation successful. Use `node scripts/release-native.mjs` for authorized deployment; the script verifies clean main, publication and exact live package. Do not restart a production service to test a source change or disrupt active Jobs. Use isolated stores for local tests.

SQLite owns lifecycle state; remote Git delivery and authenticated external fact ingress do not define Job completion. Preserve existing authentication, redaction and receipt verification boundaries.

The live daemon has one mutable orchestration owner. Dashboard mutations enter a bounded command queue and await the actual Graph/SQLite result; independent read-only observation ports never wait on that owner. SSE fan-out has its own channel owner with bounded ingress and per-client buffering; ingress overflow or a lagging client closes affected streams so clients reconnect and reload committed state. Persisted release observations publish directly to this observation channel. Provider usage is an immutable atomic snapshot with one in-flight refresh and explicit unknown/expired observations. Scheduler routing and normal Dashboard Usage never await a provider refresh; explicit detached diagnostics can await the same bounded observation.
