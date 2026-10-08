# E2E-001 fresh autonomous lifecycle run B

Implement the deterministic change in `lalalic/agents-relay-e2e`: create `fixtures/autonomy-loop-b-20261008.json` containing `{ "scenario": "autonomy-loop-b-20261008", "result": "pass" }` and add a Node.js test asserting its contents. Preserve unrelated files and run `npm test`.

The production Agents Relay must autonomously plan the work, dispatch an implementation worker, publish the implementation, perform independent pre-merge review of the current immutable PR head, automatically merge the PR, and persist the Job as COMPLETED. Do not require post-merge evidence as a pre-merge review prerequisite. No manual Task retries or merges. The independent E2E watcher verifies the final GitHub MERGED state, durable COMPLETED state, successful implementation and review, and EventsBus progression; on failure it escalates to the existing external ChatGPT Thread rather than self-repairing within Agents Relay. Never modify unrelated production Jobs.
