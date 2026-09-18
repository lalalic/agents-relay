# Agents Relay

Durable async agent jobs coordinated through GitHub pull requests.

Agents Relay treats a pull request as the durable job container, agent executions as ephemeral workers, and an event bus as a low-latency notification channel. The runtime reconciles durable PR state into executions and writes results back to the PR.

Development is currently managed through the project's own first PR.
