# E2E-007 — GitHub projection isolation, retry, and duplicate delivery

## Objective

Inject a transient GitHub audit/projection write failure while local SQLite lifecycle continues. During recovery also replay one duplicate projection/webhook delivery.

## PASS

- local implementation/review/local merge can reach `COMPLETED` independently
- projection failure is durable and observable but never gates core lifecycle
- retry converges after transport restoration
- duplicate delivery is idempotent
- no duplicate Plan/Task/publication records
