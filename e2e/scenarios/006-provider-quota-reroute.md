# E2E-006 — Provider quota exhaustion and reroute

## Objective

Trigger a genuine structured quota/rate-limit failure for the selected provider without globally damaging other providers.

## PASS

- structured provider failure is preserved
- usage/routing facts refresh
- failed route is excluded or deprioritized according to policy
- original Task is recovered/rerouted to a viable provider
- no manual provider selection or replacement business Task
- Job completes normally after recovery
