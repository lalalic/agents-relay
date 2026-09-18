# Local dogfood

```sh
npm install && npm run build
node dist/cli.js init --file /tmp/agents-relay.json --id dogfood --title "Local dogfood"
node dist/cli.js submit --file /tmp/agents-relay.json --task-id build --input "echo build" --adapter shell
node dist/cli.js reconcile --file /tmp/agents-relay.json
node dist/cli.js status --file /tmp/agents-relay.json
```

For a nested task, submit `--parent build --deps build`; reconciliation releases it only after `build` succeeds.

The same flow against the dogfood PR is:

```sh
node dist/cli.js init --repo lalalic/agents-relay --pr 1 --id agents-relay-dev-20260918-1302 --title "Dogfood"
node dist/cli.js submit --repo lalalic/agents-relay --pr 1 --id agents-relay-dev-20260918-1302 --task-id safe-shell --input "printf dogfood" --adapter shell --capabilities shell
node dist/cli.js reconcile --repo lalalic/agents-relay --pr 1 --id agents-relay-dev-20260918-1302
```
