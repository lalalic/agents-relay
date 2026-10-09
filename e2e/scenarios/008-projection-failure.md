# E2E-008 — GitHub projection failure

With GitHub integration enabled, make an external audit/projection write fail transiently.

Expected: local lifecycle continues from SQLite authority; projection retry is durable/idempotent; no duplicate Plan/Task records; GitHub failure never blocks core completion.
