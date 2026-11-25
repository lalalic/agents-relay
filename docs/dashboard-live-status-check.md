# Dashboard live-status verification

## Isolated pre-publication browser check

Run from the repository root on macOS with Google Chrome installed:

```sh
node dashboard/live-status.browser.mjs
```

Set `CHROME_BIN` to another Chrome/Chromium executable when needed. The script
starts a local fixture server and a fresh headless browser profile, loads the
real Dashboard files, sends an incomplete Job snapshot over SSE, and checks the
version-only header, both completed Job badges, automatic status convergence,
and absence of a page reload. It does not contact or mutate a Relay store or
publish release events.

The deterministic projection tests run with:

```sh
node --test dashboard/job-status.test.mjs dashboard/version-refresh.test.mjs dashboard/live-job-snapshot.test.mjs
```

## Post-publication handoff

**Owner:** user-facing orchestrator or release operator. **Status:**
`NOT_RUN / PENDING_POST_PUBLISH`. Production publication was not requested by
the user in this implementation Task.

After deployment is explicitly authorized, and only from a clean `main`
checkout when no active Jobs can be disrupted:

```sh
node scripts/release-native.mjs --job-id <this Job ID>
curl -fsS http://127.0.0.1:8787/api/version
curl -fsS 'http://127.0.0.1:4223/releases?package=agents-relay&limit=500'
```

Verify `/api/version` reports the release version and actual source SHA, and
Events Bus release history contains that version/SHA with the explicit
`jobId`. Then inspect the real Dashboard in Chrome: the header shows
only `v<version>`, the associated Job shows its publication version, terminal
Jobs do not show IDLE before or after reload, and status remains identical
after SSE reconnect. Record the release identity, observations, and
PASS/FAIL separately. A release without `jobId` must remain unassociated.
