# E2E-007 — GitHub projection isolation, retry, and duplicate delivery

## Objective

Inject a transient GitHub audit/projection write failure while local SQLite lifecycle continues. During recovery also replay one duplicate projection/webhook delivery.

## PASS

- local implementation/review/local merge can reach `COMPLETED` independently
- projection failure is durable and observable but never gates core lifecycle
- retry converges after transport restoration
- duplicate delivery is idempotent
- no duplicate Plan/Task/publication records

## E2E-only Planner option

The Job Objective tells the Planner to place `"--test-injection":"github_projection_failure"` on its original implementation Task as a JSON field (not in Task input). Relay leaves this option untouched at the Worker checkpoint; the GitHub local-merge projection execution spot imports the same injection module and consumes it durably before the projection write. The first projection fails, the normal sync loop retries without the option and converges. This is a controlled transport failure, not an actual GitHub outage. Watcher must only observe ordinary projection failures, retries, and lifecycle facts.
