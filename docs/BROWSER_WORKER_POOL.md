# Browser Worker Pool: executable Graph and verification

## Authority and implementation

`workflow/browser-worker-pool.mmd` is the executable Graph for Browser Worker resource admission, bounded FIFO waiting, health rejection, exclusive WebHelm Session leasing, verified output/activity, terminal-event recovery, and quarantine. The production Graph runtime is `src/browser-worker-pool-graph.ts` through `dispatchWorkflowGraphSync`.

- **Graph** decides `pool.assign`, `pool.enqueue`, `pool.reject`, `pool.dequeue`, `pool.touch`, `pool.extendTimeout`, `pool.recoverTurn`, `pool.release`, `pool.quarantine`, and `pool.releaseQuarantine` transitions.
- **BrowserWorkerPoolManager** implements atomic SQLite claims with generation fencing. It owns **resource state only**. Provider circuits and queue entries persist in its isolated resource database.
- **BrowserWorkerRuntime** creates the shared Neo workspace (six-tab maximum) through WebHelm application daemon IPC and leases/stops Sessions using the same daemon API. ChatGPT and Z.ai share the Neo group, with three logical slots per provider. The agent WebHelm CLI is restricted to the WebHelm workspace; it must never be given a custom workspace override.

WebHelm reclaims stale Sessions on demand when a new tab is requested (session start or new_tab), not via a timed sweep. Relay renews active Session last_used_at with daemon heartbeats every 45 seconds by default. Heartbeats do not imply model progress and never extend Task deadlines. Normal terminal release returns the Tab to helm.html?workspace=Neo&role=idle. Cancelled uncertain deliveries stop heartbeats but retain quarantined Relay slots until independently verified stopped. The runtime additionally owns browser output fingerprints, bounded recoveries and verified-site completion evidence.
- **Agents Relay Task Graph** remains the sole authority for Task `task.started` / `task.progress` / `task.completed` / `task.failed`. Provider submission and browser session release cannot synthesize Task completion.

## Failure and recovery rules

| Situation | Expected Pool result | Task rule |
|---|---|---|
| No available Slot, provider healthy | FIFO `WAITING`, bounded expiry | No duplicate website submission |
| Pre-submission provider preflight failed | `PROVIDER_UNAVAILABLE`, circuit | Safe reroute if another eligible Worker exists |
| Local prompt builder failed | Reject pre-submission without tripping provider circuit | Do not report a false site outage |
| Submitted response ambiguous | `QUARANTINED`, no resend, retain Session | Troubleshooter or externally verified stop needed |
| Session stop failed | Quarantine original lease | No reuse until verified stopped |
| Provider restored after cooldown | New provider probe may run | Health checked by real subsequent successful submission |
| Stale model spinner, unchanged DOM or tab activation | No `task.progress` | Inactivity deadline stays unchanged |
| Fresh output from original Thread | `pool.extendTimeout` | Relay accepts correlated `task.progress`, extends deadline |
| SSE completion but no terminal event | Wait completion grace, recover in SAME Thread | Recovery submission itself is **not** progress |
| CDP failed and no completion evidence | Fail closed, keep lease; do not send new Turn | Relay Task watchdog and Troubleshooter remain authoritative |
| Recovery submission ambiguous | Quarantine, no second automatic send | Do not duplicate output or release Slot |
| Process restart with persisted lease | Preserve owner/generation | Release only after independently verified stop |

**Limitations:** CDP/network failures can prevent idle detection. Browser heartbeats cannot override a genuine site/transport failure. Under uncertain submission, the Pool does not claim to have healed the Worker: the Slot remains quarantined for verified recovery. The current provider health breaker returns to HEALTHY after its cooldown, without a separate persisted half-open probe state.

## Test gates

```sh
npm run test:verification:l1
npm run test:verification:l2
npm run test:verification:l3
npm run test:full
RELAY_BROWSER_POOL_LIVE=1 npm run test:verification:browser-pool:live
RELAY_BROWSER_POOL_LIVE=1 node test/live/browser-worker-pool-recovery.e2e.mjs
```

- Normal tests run with isolated SQLite + fake CLI, validate Graph branches, atomic generation leases, FIFO, provider fail-fast/circuit, stop-failure quarantine, restart preservation, bounded same-thread recovery, uncertain recovery, spinner-only rejection and correlated timeout extension.
- The opt-in browser E2E provisions the Neo group through daemon IPC and opens real, **owned** WebHelm Sessions. It submits harmless ChatGPT and Z.ai messages, exercises 3+1 ChatGPT slots, a simultaneous Z lease, FIFO wakeup, controlled pre-submit failure and cooldown, and verifies all test Sessions close. No existing user Session is stopped.
- The opt-in recovery E2E waits for real Z.ai webpage SSE completion before sending the next Turn on the original Thread. It does not treat a mere submitted receipt as worker progress.
- Site outages are deliberately **injected**, not induced by disconnecting or modifying a user's Chrome Session. Model completion evidence is separately verified by the browser platform.

When an E2E fails, retain its logs as evidence and report `FAIL`, not `PASS`; never silently run a mock in place of the live gate.
