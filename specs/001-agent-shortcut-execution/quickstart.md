# Shortcut execution quickstart

Select shortcut execution when creating a content-only Job, before creating its
Tasks. Do not use `--initial-plan`; shortcut Jobs do not create Planner rounds.

```sh
npx agents-relay job create --repo OWNER/REPO --project-path vlog \
  --objective-file objective.md --shortcut-execution
```

Create a Task with its Agent Graph after the Job exists, then run it through the
normal Reconciler dispatch path. The manual command remains available for an
explicit run of the same durably opted-in Job:

```sh
npx agents-relay job run --mode shortcut --repo OWNER/REPO --id JOB_ID \
  --task-id TASK_ID --project-path /path/to/project \
  [--neo-root /path/to/neo] [--concurrency 4]
```

Project shortcuts at `agents/.shortcut/<agent>.agent.mjs` override the
corresponding Neo shared shortcut. Independent ready nodes execute concurrently
within the configured limit, and dependent nodes receive only declared
predecessor outputs. A missing shortcut falls back to the original Worker
route. Shortcut modules are arbitrary Node code and may perform direct effects,
so once a module is imported, an error is treated as ambiguous and goes through
Troubleshooter recovery rather than Worker replay. Relay checkpoints each
module as in-flight before import and refuses to replay an interrupted node
after restart. Host `runCommand` calls track owned subprocess effects and
receive cancellation when the exact Task lease is fenced. The exact Task lease
renews while module code is pending. After completed node output, failure stays
on the Task; Relay does not replay the graph automatically.

A `WAITING_EVENT` wait must declare `kind: "nonhuman_result"` with a node ID,
wait ID, revision, and expected content SHA256. The asynchronous producer records
the completed shortcut result through the local CLI, which validates the result
contract and atomically stores a receipt in the existing SQLite Task checkpoint:

```sh
npx agents-relay job shortcut-receipt --repo OWNER/REPO --id JOB_ID \
  --task-id TASK_ID --node-id NODE_ID --wait-id WAIT_ID \
  --revision REVISION --execution-id EXECUTION_ID \
  --output-file result.json --content-sha256 SHA256
```

The JSON file must contain `{ "status": "COMPLETED", "output": {},
"artifacts": [] }` (or the structured artifact-map form). SHA256 is over the
canonical JSON result object and must equal the expected hash in the persisted
wait. Recording a receipt does not complete the node. Reconciliation consumes
the matching receipt through the Task Lifecycle graph, rechecks the Task input,
Agent Graph, shortcut source, wait and active execution, and checkpoints the
validated output before advancing dependents. The receipt and consumption are
idempotent; an already recorded identical receipt is accepted, while conflicting
or stale identities are rejected. A restart can consume a durable receipt
without event delivery.

`shortcut.result` EventBus messages are wake/identity signals only. Their output
payload is ignored, including when source ID and every identity field match.
Receipt discovery reads the current SQLite wait directly. Human approval remains
on Relay's authenticated `task.interactive_decision` host-invocation authority;
manual `--event-json` injection remains disabled.
The checkpoint pins Task input, Agent Graph, and resolved shortcut source
hashes. Resumed artifact paths must resolve inside the project and retain their
recorded hashes. A mismatch or missing artifact fails closed. Job completion
still requires the durable shortcut content-only gate: no PR, merge, review,
Planner plan, or outstanding event wait.

Visioner requires structured evidence, index, and metadata artifacts. The
shortcut and existing Vlog index script check approved source hashes, metadata
hashes when pinned by the manifest, path containment, and unreviewed evidence
status. Fixtures mock Markcut and do not perform media inference or uploads.

## Verification

Verification after implementation and the final local architecture review:

- `npm run build` — passed.
- `node --import ./test/test-store-env.mjs --test test/agent-shortcut.test.js test/workflow-v2-lifecycle-parity.test.js test/local-sqlite-jobid.test.js test/task-recovery-human.test.js test/workflow-lifecycle.test.js test/task-resolution.test.js` — 51 passed.
- `node --test agents/.shortcut/visioner.agent.test.mjs` in the Neo worktree — 8 passed.
- `git diff --check` — passed.

Provider/browser/UI checks remain `NOT_RUN`; no service was
started and no production state, real media inference, upload, or publish was
used.
