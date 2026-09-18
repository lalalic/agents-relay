# Local dogfood

```sh
npm install && npm run build
node dist/cli.js init --file /tmp/agents-relay.json --id dogfood --title "Local dogfood"
node dist/cli.js submit --file /tmp/agents-relay.json --id build --input "echo build" --adapter shell
node dist/cli.js reconcile --file /tmp/agents-relay.json
node dist/cli.js status --file /tmp/agents-relay.json
```

For a nested task, submit `--parent build --deps build`; reconciliation releases it only after `build` succeeds.
