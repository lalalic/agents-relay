# Local dogfood

```sh
npx agents-relay init --file /tmp/agents-relay.json --id dogfood --title "Local dogfood"
npx agents-relay task create --file /tmp/agents-relay.json --output local-git --input "Perform the build task and publish a terminal event"
npx agents-relay reconcile --file /tmp/agents-relay.json
npx agents-relay status --file /tmp/agents-relay.json
```

Autonomous local jobs use the same file and task tree. The mode is durable and
defaults to fixed:

```sh
npx agents-relay init --file /tmp/agents-relay-auto.json --id auto --title "Objective"
npx agents-relay reconcile --file /tmp/agents-relay-auto.json
npx agents-relay status --file /tmp/agents-relay-auto.json
```

`planner.sh` reads the current objective/task snapshot from stdin and prints a
typed planner result. Its `next_tasks` IDs must remain stable across retries.

For a nested task, use `task create --parent NUMERIC_PARENT_TASK_ID --deps NUMERIC_PARENT_TASK_ID` with the actual ID returned from the first create; reconciliation releases it only after that parent succeeds.

For durable repository Jobs, use the numeric Job ID and local Git basename:

```sh
printf '%s\n' '# Dogfood\n\nVerify the build and report evidence.' > /tmp/relay-dogfood-objective.md
npx agents-relay job create --repo agents-relay --project-root "$PWD" --title "Dogfood" \
  --objective-file /tmp/relay-dogfood-objective.md --initial-plan
# Use the Job ID returned by create for subsequent operations:
npx agents-relay job show --id JOB_ID
npx agents-relay task list --repo agents-relay --id JOB_ID
```

Existing PR-bound Jobs remain readable by durable ID; the CLI does not import external PRs.
