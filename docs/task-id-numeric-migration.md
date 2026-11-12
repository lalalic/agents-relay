# Numeric Task ID migration

Persisted Task IDs are positive decimal strings allocated from one store-global
sequence. Business identity belongs in structured Task metadata and durable
idempotency keys. DAG node identity is the tuple
`dagNode.parentTaskId` / `dagNode.nodeId` / `dagNode.graphHash`.

The explicit migration command is:

```sh
npm run build
node bin/migrate-task-ids.mjs --database /absolute/path/relay.sqlite \
  --backup /absolute/path/relay.sqlite.pre-numeric-task-ids.backup
```

It uses SQLite's online backup API, checks backup integrity, refuses to migrate
while any Job is `ACTIVE`, and then atomically rewrites every Task ID and known
structured snapshot/relational reference. A completion marker makes repeat
invocation safe. It also advances the global Task sequence to the maximum
assigned ID. Choose a backup path on persistent storage and preserve it until
the migrated store has been independently verified. This command is explicit;
it never selects or opens the canonical user store by default.

Historical duplicate Planner records retain distinct numeric IDs; ambiguous old references resolve to the first recorded Task. Historic orphaned `orchestrator` parent IDs become root Tasks. Neo Project private `.neo-project-run.json` bindings must be updated to the numeric Coordinator Task ID after SQLite migration. Shut down the owning Relay daemon for the migration and restart it only after verifying the backup and migrated references.
