# Jev skill-discovery benchmark

## Status

Live Jev measurement is **blocked on Cloudflare authentication** on this machine. The controlled fixtures and runner are ready, but no Jev accuracy, calibration, latency, cost, or fallback measurements are reported because extrapolating them without a live run would invalidate the benchmark.

Observed on 2026-09-19:

- Wrangler 4.135.0 is installed.
- `wrangler whoami` reports unauthenticated.
- Cloudflare account ID/API token variables are not present in the worker shell.
- Wrangler OAuth reaches a Cloudflare login wall. The worker did not enter credentials, approve account access, or create a broad API token implicitly.
- Cloudflare's temporary preview accounts currently do not list Workers AI as a supported temporary-account product, so `wrangler deploy --temporary` is not a substitute for this benchmark.

## Cloudflare Jev API shape

Cloudflare documents Jev as `typesafe/jev` with a 32,000-token context window. Requests provide a `state` and typed `questions`; Choice responses include `choice`, `confidence`, and `probabilities`, and responses include token usage. The Cloudflare model page currently shows provider model `jev-latest` and an example response model identifier `jev-1.13.0`.

This benchmark represents skill discovery as one Choice question over controlled skill names/descriptions plus a synthetic `__none__` option. The instruction is conservative: load exactly one skill only when it is materially required; otherwise choose none.

## Frozen fixtures

`benchmarks/jev/skill-discovery-fixtures.json` contains 18 representative historical/synthetic XChat and Agents Relay cases.

It has:
- an 8-skill compact candidate set;
- a 16-skill extended candidate set;
- positive cases covering model routing, event observability, authenticated browser work, durable relay tasks, Mermaid diagrams, NotebookLM, iPhone media, Markcut, daemon management, phone UI control, social publishing, skill evaluation, speech transcription, image/video analysis, WeChat, and iterative experimentation;
- two explicit no-skill cases to measure false-positive loads.

Expected labels are controlled gold labels authored from the exact candidate descriptions in the fixture.

## Runner and metrics

`benchmarks/jev/run-skill-discovery.mjs` sends the frozen cases to the Cloudflare Workers AI REST endpoint and records per case:

- expected and predicted skill;
- Choice confidence and probability distribution;
- candidate-set size;
- request latency;
- input/output token usage;
- returned Jev model identifier;
- transport/API error status.

Its aggregate summary reports:

- exact-match accuracy;
- precision and recall for skill selection;
- false-positive skill loads;
- missed required skills;
- fallback/error rate;
- p50 and p95 latency;
- input/output token totals.

After live outputs exist, calibration should be added over correctness (for example reliability bins and Brier score). Candidate-set sensitivity should also be strengthened by replaying the same cases at multiple set sizes, rather than using only different cases in compact vs extended sets.

## Strong reasoning-model baseline

The baseline has not been executed because the primary Jev run is blocked. It should run over the identical frozen fixture and return only one candidate name or `__none__` per case, with no access to the gold label. A strong reasoning model should be compared on the same exact-match/precision/recall metrics; its latency and token usage should be recorded separately.

## Reproduction

Once explicit Cloudflare authentication is available:

~~~sh
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
  node benchmarks/jev/run-skill-discovery.mjs
~~~

The runner writes `benchmarks/jev/skill-discovery-results.json`.

## Current conclusion

No production skill-loading change is justified from this task yet. The benchmark harness is ready and production behavior remains untouched, but the empirical Jev comparison is incomplete until Cloudflare authentication is explicitly established and the live Jev + strong reasoning-model runs are executed.
