# Local dogfood

```sh
npx agents-relay init --file /tmp/agents-relay.json --id dogfood --title "Local dogfood"
npx agents-relay submit --file /tmp/agents-relay.json --task-id build --input "echo build" --adapter shell
npx agents-relay reconcile --file /tmp/agents-relay.json
npx agents-relay status --file /tmp/agents-relay.json
```

Autonomous local jobs use the same file and task tree. The mode is durable and
defaults to fixed:

```sh
npx agents-relay init --file /tmp/agents-relay-auto.json --id auto --title "Objective" --mode autonomous
npx agents-relay reconcile --file /tmp/agents-relay-auto.json --planner-command ./planner.sh
npx agents-relay status --file /tmp/agents-relay-auto.json
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
