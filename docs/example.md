# Local dogfood

```sh
npx agents-relay init --file /tmp/agents-relay.json --id dogfood --title "Local dogfood"
npx agents-relay task create --file /tmp/agents-relay.json --task-id build --output task-pr --input "Perform the build task and publish a terminal event"
npx agents-relay reconcile --file /tmp/agents-relay.json
npx agents-relay status --file /tmp/agents-relay.json
```

Autonomous local jobs use the same file and task tree. The mode is durable and
defaults to fixed:

```sh
npx agents-relay init --file /tmp/agents-relay-auto.json --id auto --title "Objective" --mode autonomous
npx agents-relay reconcile --file /tmp/agents-relay-auto.json
npx agents-relay status --file /tmp/agents-relay-auto.json
```

`planner.sh` reads the current objective/task snapshot from stdin and prints a
typed planner result. Its `next_tasks` IDs must remain stable across retries.

For a nested task, use `task create --parent build --deps build`; reconciliation releases it only after `build` succeeds.

The same flow against the dogfood PR is:

```sh
npx agents-relay init --repo lalalic/agents-relay --pr 1 --id agents-relay-dev-20260918-1302 --title "Dogfood"
npx agents-relay task create --repo lalalic/agents-relay --pr 1 --id agents-relay-dev-20260918-1302 --task-id verify-dogfood --output task-pr --input "Verify the dogfood flow and publish a terminal event"
npx agents-relay reconcile --repo lalalic/agents-relay --pr 1 --id agents-relay-dev-20260918-1302
```
