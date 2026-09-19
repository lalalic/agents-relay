# Local dogfood

```sh
npm install && npm run build
node dist/cli.js init --file /tmp/agents-relay.json --id dogfood --title "Local dogfood"
node dist/cli.js submit --file /tmp/agents-relay.json --task-id build --input "echo build" --adapter shell
node dist/cli.js reconcile --file /tmp/agents-relay.json
node dist/cli.js status --file /tmp/agents-relay.json
```

Autonomous local jobs use the same file and task tree. The mode is durable and
defaults to fixed:

```sh
node dist/cli.js init --file /tmp/agents-relay-auto.json --id auto --title "Objective" --mode autonomous
node dist/cli.js reconcile --file /tmp/agents-relay-auto.json --planner-command ./planner.sh
node dist/cli.js status --file /tmp/agents-relay-auto.json
```

`planner.sh` reads the current objective/task snapshot from stdin and prints a
typed planner result. Its `next_tasks` IDs must remain stable across retries.

For a nested task, submit `--parent build --deps build`; reconciliation releases it only after `build` succeeds.

The same flow against the dogfood PR is:

```sh
npx agents-relay init --repo lalalic/agents-relay --pr 1 --id agents-relay-dev-20260918-1302 --title "Dogfood"
npx agents-relay submit --repo lalalic/agents-relay --pr 1 --id agents-relay-dev-20260918-1302 --task-id safe-shell --input "printf dogfood" --adapter shell --capabilities shell
npx agents-relay reconcile --repo lalalic/agents-relay --pr 1 --id agents-relay-dev-20260918-1302
```
