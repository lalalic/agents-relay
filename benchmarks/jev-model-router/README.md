# Jev model-router benchmark

This benchmark evaluates `typesafe/jev` as an **optional semantic decision layer after deterministic model eligibility**. It does not change Agents Relay production routing.

## Fixed boundary

Deterministic policy remains authoritative for provider/model availability, capability, context/tool/modality fit, privacy, quota/health, and explicit user constraints. Jev sees only already-eligible semantic route tiers.

The benchmark uses four semantic tiers:

- `fast_medium`: narrow/routine low-risk work.
- `balanced_medium`: conventional multi-step coding/debugging/compatibility work.
- `reasoning_high`: broad/high-risk architecture, review, security, evaluation, or integration work.
- `thinking_standard`: deliberate reasoning when appropriate but not clearly strongest-route work.

A later integration could map these tiers onto the model-router's dynamically discovered eligible profiles. Jev must never invent a provider or bypass a hard gate.

## Fixtures

`fixtures.json` contains representative **real durable Agents Relay task inputs** from PRs #9, #23, and #26-#29. Each fixture records the actual current route normalized to a semantic tier, a strong-reasoning baseline label, deterministic eligible tiers, task requirements/risk, and durable downstream state as a weak quality proxy.

The strong-reasoning label is a benchmark reference, not universal truth. Disagreements must be reviewed, especially where both routes produced successful work.

## Cloudflare API shape

Workers AI exposes Jev as `typesafe/jev` via the standard Workers AI run endpoint. The request body uses one shared `state` and a typed question map:

```json
{
  "model": "typesafe/jev",
  "input": {
    "state": {
      "task": "...",
      "requirements": ["..."],
      "risk": "high",
      "deterministic_eligibility": ["balanced_medium", "reasoning_high"]
    },
    "questions": {
      "route": {
        "type": "choice",
        "instructions": "...",
        "criteria": {
          "balanced_medium": "...",
          "reasoning_high": "..."
        }
      },
      "complexity": {
        "type": "score",
        "instructions": "...",
        "criteria": ["...", "...", "...", "..."]
      },
      "needs_reasoning_fallback": {
        "type": "noul",
        "instructions": "...",
        "criteria": {
          "true": "...",
          "false": "..."
        }
      }
    }
  }
}
```

The documented Jev response includes a model version, typed answers, probabilities/confidence for Choice/Score, a Noul probability, and input/output token usage.

## Run

```sh
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_API_TOKEN=... \
JEV_REPETITIONS=3 \
node benchmarks/jev-model-router/run.mjs > /tmp/jev-model-router-results.json
```

The API token needs Workers AI Read and Workers AI Edit permissions.

Optional benchmark-only fallback threshold:

```sh
JEV_CONFIDENCE_THRESHOLD=0.75
```

This threshold is not a production recommendation until calibrated from live results.

## Metrics

The runner reports exact match against the strong-reasoning baseline, agreement with the current router, multiclass Brier score, fallback rate, p50/p95 end-to-end REST latency, input/output token usage, and failure summaries.

The current-router downstream quality proxy is deliberately weak: it reports whether succeeded durable tasks used the same tier as the strong-reasoning baseline. Task success is heavily confounded by implementation quality, retries, transport failures, and cancellation, so it is not treated as causal evidence about routing quality.

Cloudflare's public Jev model page currently points to account-dashboard pricing instead of publishing a Jev-specific token price. The harness records token usage and leaves dollar cost null rather than inventing a rate.

## Interpretation boundary

A safe candidate path is:

`deterministic eligibility -> Jev semantic tier -> confidence/fallback gate -> model-router final profile mapping`

Do not enable this path in production until a live Cloudflare run establishes acceptable routing quality, calibration, latency, cost, and failure behavior. A signed-in Cloudflare dashboard smoke request on 2026-09-19 reached the Jev endpoint but returned HTTP 402 / code 2021 (`Insufficient balance; add money to your gateway or use BYOK`), so the benchmark currently has connectivity evidence but no Jev inference results.
