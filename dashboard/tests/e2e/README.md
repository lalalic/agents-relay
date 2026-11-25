# Dashboard browser regression

Run from the repository root:

```sh
scripts/test-dashboard-browser.sh
```

Requires Node.js 22.13+ (node:sqlite), npm, Cargo and installed Google Chrome.
Uses the pinned test-only playwright-core dependency and the Node test runner.
No Playwright browser downloads, separate browser service, existing Chrome
profile, or production Node backend. Set CHROME_BIN to an explicit Chrome
executable for a nonstandard installation.

The Rust test seeds the real SQLite schema in a temporary directory. The
suite launches the real native daemon and a loopback-only Events Bus fixture,
and drives the actual Dashboard UI in isolated headless Chrome. A transparent
test proxy permits disconnecting SSE and restarting the daemon at the same
browser origin. No production Jobs or credentials are used.

Cases: Job list and filters; mixed runtime states; version from a correlated
publication and rejection of stale/jobless releases; reload and durable restart;
SSE reconnect; slow/unavailable release history; revision upgrade; existing UI
selection and refresh plus graph-authorized retry/cancel through the browser's
HTTP client. Dashboard does not expose pause/resume or retry buttons; the latter
is an API assertion, not a claim of a tested UI control.

The release script runs this suite before activation when Dashboard assets,
HTTP/SSE projection or publication-related code changes. For a live smoke test,
use read-only checks of /api/version, /api/jobs and the actual Dashboard page.
