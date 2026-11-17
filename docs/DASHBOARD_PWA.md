# Dashboard PWA / Node-to-Rust server boundary

## Frontend authority

The browser UI has one source: dashboard/. The Node and Rust transports serve
the same index.html, dashboard.js, dashboard.css, manifest.webmanifest, pwa.js,
service-worker.js and icon bytes. No Node/Rust-specific frontend fork is allowed.

- Browser code remains framework-free. The Node dashboard HTML template was
  compiled to its rendered HTML/CSS/JS before extraction, so regex escaping
  and other template string semantics were preserved.
- dashboard/jel-function.js is a generated browser-compatible projection of
  src/dashboard-jel.ts (jobJelDiagram.toString). A test enforces byte equality
  and prevents unreviewed divergence.
- dashboard-config.js is a no-store runtime script providing version,
  validated source revision, default status filters and the JEL function.
  Node and Rust render identical output, verified by a differential test.
- src/dashboard-html.ts and src/dashboard-style.ts remain compatibility
  adapters for existing consumers and Node/Rust parity tests, not the HTTP
  source of truth.

## HTTP and caching

The shell is served at / with no-store. Static resources use no-cache and
an exact route allowlist. Manifest and service worker are first-party paths.
The Service Worker caches only allowlisted static assets, using network-first
refresh with cache fallback. It never handles navigation, /api/*, /events,
or /dashboard-config.js. No Job, Task, execution, event, user, credential or
API response can be served from the Service Worker cache.

Node: src/dashboard.ts serves the static routes before business routes.
Rust: rust/src/dashboard.rs supplies identical public assets and transport
routes; a DashboardBackend must be connected to the authoritative Rust Graph,
SQLite store and event bus before production cutover. It is not an independent
source of lifecycle truth. It does not imply the Rust backend is operational
or ready for live cutover on its own.

Rust transport inputs are capped, static routes are exact-matched and
API/webhook routes delegate to an injected backend. SSE frames come only from
the backend event subscription. The Node/Rust API parity and restart/recovery
gates are mandatory before replacing the Node service.

### Rust native API integration (Dashboard-only)

- The existing `rust/src/dashboard.rs` is still the *only* native HTTP/static/PWA/SSE transport. Do not replace it with the serial migration branch's obsolete, single-HTML-file HTTP listener.
- `rust/src/dashboard_api.rs` translates the original server-side Dashboard routes into the injected `DashboardApiServices` interface. Its injected implementation must call the same authoritative SQLite transactions, Graph actions and event bus as the CLI; this module has no independent workflow policy or persisted lifecycle state.
- The HTTP adapter preserves lowercase incoming headers for webhook verification, rejects duplicate header fields, bounds request bodies, checks HMAC-SHA256 before parsing the GitHub event, and records a delivery ID as accepted **only after** durable webhook handling succeeds. Uncommitted wakes must be retryable.
- Existing browser files `dashboard/index.html`, `dashboard/dashboard.js`, `dashboard/dashboard.css`, service worker, manifest and icons remain unchanged. Both transports serve the same authoritative assets.
- Focused evidence: `rust/tests/native_dashboard_api.rs` tests job filters/refresh, actions, webhook signature/duplicate/retry and physical TCP PWA serving; `rust/tests/native_dashboard_pwa.rs` keeps the original asset, SSE and Node-config byte parity. The existing Node Dashboard and Rust differential suites also pass.
- **Not a production cutover:** the native adapter requires a concrete Graph/SQLite service provider and a live SSE subscription to be wired into the production daemon. Provider/browser-device E2E and remote PWA installation remain separate gates.

## Installation and release

- npm package includes dashboard/ alongside dist/; files are resolved
  relative to the package installation, not process.cwd().
- localhost is a secure development context on desktop browsers.
  iPhone and other remote clients require a trusted HTTPS reverse proxy
  with authentication; do not expose the 127.0.0.1 Relay API publicly.
- Install using the browser's Add to Home Screen / Install App action.
  Offline cached app shell does not mean offline Job data is available.
- Preserve existing Dashboard UI interactions and API/SSE contracts.
  Version polling and API refresh must always consult the live backend.

## Verification gates

1. npm run build and Node Dashboard regression suite.
2. Node PWA routes, static byte equality, service worker exclusions and
   package dry-run verification.
3. Native Rust static route, API delegation, SSE and exact Node/Rust runtime
   config tests.
4. Full Node and Rust regressions.
5. Real browser UI at desktop and 320–430 CSS pixels; PWA installation and
   HTTPS iPhone testing when trusted device/endpoint are available.
6. Native backend Graph/SQLite/API/SSE parity, restart/reconnect and live
   cutover: NOT VERIFIED by asset/transport tests alone.
