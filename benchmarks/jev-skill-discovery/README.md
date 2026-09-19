# Jev skill-discovery benchmark

Task: `jev-skill-discovery-benchmark`
PR: #23
Date: 2026-09-19

## Scope

This benchmark evaluates Cloudflare Workers AI `typesafe/jev` as an optional semantic skill-discovery layer after deterministic policy. It does **not** alter production skill loading.

The fixture set contains 26 representative historical/synthetic XChat and Agents Relay tasks. Candidate sets are controlled at sizes 4, 8, 16, and 24 and include explicit `none` cases. The benchmark asks Jev one typed `Choice` question: select the skill that should be loaded first, or `none`.

Cloudflare currently documents Jev as a structured evaluation model supporting typed Noul, Choice, and Score outputs, with a 32,000-token context window and probabilities/confidence:
https://developers.cloudflare.com/ai/models/typesafe/jev/

Cloudflare dashboard pricing observed on 2026-09-19 for Jev was **$0.042 per 1M input tokens**. The harness records input/output token usage and computes an input-token-only cost estimate. It does not invent an output-token price when the model page does not show one.

## Files

- `fixtures.json` — controlled skill catalog and 26 labeled tasks.
- `run.mjs` — provider call, timing, typed-response validation, fallback policy, and metrics.
- `results-jev.json` — generated only after a successful authenticated Cloudflare run.
- `results-reasoning-baseline.json` — reasoning-model comparison notes/results.

## Metrics

The runner reports:

- exact-match accuracy;
- non-`none` precision and recall;
- false-positive loads: expected `none`, but Jev loads a skill;
- missed required skills: expected a concrete skill, but Jev chooses another skill or `none`;
- 10-bin expected calibration error (ECE) using Choice confidence;
- candidate-set-size sensitivity at 4/8/16/24 candidates;
- p50/p95 end-to-end REST latency;
- input/output token usage;
- estimated input-token cost;
- fallback rate below `JEV_CONFIDENCE_THRESHOLD` (default 0.70);
- malformed/unavailable API failures.

## Run

Use a scoped Cloudflare credential with Workers AI permission:

```sh
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_API_TOKEN=... \
JEV_REPETITIONS=3 \
JEV_CONFIDENCE_THRESHOLD=0.70 \
node benchmarks/jev-skill-discovery/run.mjs
```

The REST shape follows Cloudflare's documented universal Workers AI endpoint:

```text
POST https://api.cloudflare.com/client/v4/accounts/<account>/ai/run
{
  "model": "typesafe/jev",
  "input": {
    "state": { ... },
    "questions": {
      "selected_skill": {
        "type": "choice",
        "instructions": "...",
        "criteria": {
          "skill-name": "skill description",
          "none": "no specialized skill is required"
        }
      }
    }
  }
}
```

## Strong reasoning-model baseline

The current benchmark task is itself running on GPT-5.6 Sol with high reasoning. A first adjudication pass over the controlled fixtures selected the labeled skill/none outcome for all 26 cases (26/26 exact match). This pass is useful as a sanity baseline but **is not a blinded independent measurement**, because the same task run also curated the fixture labels. It therefore must not be treated as a production-quality superiority claim.

A stricter follow-up should run the frozen fixture file through an independently invoked reasoning-model judge after labels are hidden from the judge, then persist its raw predictions, latency, and token/cost metadata beside Jev results.

## Current execution status

The local Cloudflare dashboard session is logged in, but Wrangler is not authenticated. Starting `wrangler login` reached Cloudflare's OAuth consent screen. Per browser-safety rules, the benchmark task did not approve a new OAuth grant automatically.

Therefore the reproducible harness and fixtures are complete, but **no live Jev quality/latency/token measurements are claimed in this result yet**. Once the OAuth grant is explicitly approved (or a scoped API token is already available), the runner can produce `results-jev.json` without any production code changes.

## Decision gate

Do not enable Jev skill loading from this partial result. A production decision requires a live run with frozen fixtures and, preferably, multiple repetitions. Suggested acceptance gates for the experiment:

- zero false-positive loads on the `none` cases, or an explicit deterministic/fallback gate that makes effective false-positive loads zero;
- no missed required explicit-trigger skills;
- exact match reported separately by candidate-set size;
- confidence threshold chosen from observed calibration rather than a vendor example;
- p95 latency and cost compared with the independent reasoning-model baseline;
- malformed/unavailable responses always fall back to existing discovery behavior.

This keeps Jev optional and subordinate to deterministic loading rules.
