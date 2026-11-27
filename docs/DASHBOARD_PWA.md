# Dashboard and PWA

The framework-free `dashboard/` tree is the frontend authority. `rust/src/dashboard.rs` serves HTTP/static/PWA/SSE; `dashboard_api.rs`, `dashboard_actions.rs` and `dashboard_data.rs` translate API requests to canonical runtime facts/actions. The UI must not own independent lifecycle state. Keep live API filters, ordering before pagination, explicit accessible Refresh, client-side filtering between refreshes and newest-20 display limit.

Mobile: one Search/Status/Repository/Refresh row without Reset; borderless accessible header icons; durable status coloring; native selects and visible focus; no horizontal overflow at 320–430 CSS pixels. Keep visual layout and interaction consistent across desktop/mobile.

Serve the shell without stale runtime state. The service worker may cache allowlisted static resources, never navigation, live API, events or credentials. Version and refresh consult the live backend. Use an authenticated trusted HTTPS boundary for remote devices; do not expose local Relay API publicly.

Job Detail, Task Detail and JEL use one Report action to generate and immediately display a fresh scoped execution report. Detailed traces are loopback-only; the authenticated remote Dashboard does not expose them. The report iframe remains sandboxed.

Workflow inspection is a read-only presentation of canonical graphs and their registered symbols. `docs/workflow-symbol-index.md` is consumed by the Dashboard; keep its contract references valid. Do not make explanatory diagrams executable.

Run `scripts/test-dashboard-browser.sh` for UI, HTTP/SSE, runtime-status and publication changes before review/merge/release. Use isolated native fixtures and real Chrome, including desktop and mobile widths. Native tests include `native_dashboard_api`, `native_dashboard_pwa`, `native_dashboard_browser`, `native_dashboard_jel`. Real remote-device checks must be reported separately.

Read-only Dashboard requests are bounded and transient failures retain the last verified Job/runtime view. Initial failures, missed events and SSE disconnects recover through authoritative inventory refresh, including periodic refresh while the stream is connected; an empty filtered result remains a valid empty result. Slow SSE clients cannot block the daemon or other subscribers.

Normal Job listing selects the newest 20 after applying the existing filters and ordering to compact SQLite metadata, then hydrates those IDs with joined PR facts and publication state in the same read transaction. The explicit full-inventory request retains its full snapshot contract. Status uses COUNT, runtime summary reads ACTIVE jobs, and SSE observes compact revision metadata and hydrates changed jobs only. Derived SQLite indexes support active and pending-delivery queries.
