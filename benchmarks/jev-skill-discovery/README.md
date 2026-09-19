# Jev skill-discovery benchmark

Task: `jev-skill-discovery-benchmark`
PR: #23
Date: 2026-09-19

## Scope

This benchmark evaluates Cloudflare Workers AI `typesafe/jev` as an optional semantic skill-discovery layer after deterministic policy. It does **not** alter production skill loading.

The frozen fixture set contains 26 representative historical/synthetic XChat and Agents Relay tasks, including explicit `none` cases. Every case is replayed against controlled total Choice-set sizes of **4, 8, 16, and 24** (including the synthetic `none` choice), for **104 Jev calls per repetition**. This makes candidate-set-size sensitivity a within-case comparison rather than a comparison between different task mixes.

Cloudflare documents Jev as a structured evaluation model supporting typed Noul, Choice, and Score outputs, a 32,000-token context window, probabilities/confidence, and token usage:
https://developers.cloudflare.com/ai/models/typesafe/jev/

Cloudflare's public model page routes pricing to the dashboard. The runner therefore exposes `JEV_INPUT_USD_PER_MTOKENS`; its current default, `0.042`, is the input-token price observed in the Cloudflare dashboard on 2026-09-19. The generated report labels this as an input-token-only estimate and never invents an output-token price.

## Files

- `fixtures.json` — controlled skill catalog, 26 labeled tasks, and the 4/8/16/24 replay sizes.
- `run.mjs` — provider call, timing, typed-response validation, confidence fallback policy, and metrics.
- `results-jev.json` — generated only after a successful authenticated Cloudflare run.
- `results-reasoning-baseline.json` — current high-reasoning sanity baseline and its limitations.

## Cloudflare API shape

The runner uses the Workers AI universal REST endpoint:

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

A valid response must contain a typed Choice answer. The runner records the selected choice, confidence/probabilities, returned model identifier, input/output tokens, and end-to-end REST latency.

## Metrics

The generated summary reports:

- exact-match accuracy;
- non-`none` precision and recall;
- false-positive loads: expected `none`, but Jev loads a skill;
- missed required skills: expected a concrete skill, but Jev chooses another skill or `none`;
- 10-bin expected calibration error (ECE) using Choice confidence;
- exact match, false-positive loads, missed skills, mean confidence, and fallback rate by candidate-set size;
- p50/p95 end-to-end REST latency;
- input/output token usage;
- estimated input-token cost;
- effective fallback rate, where both low-confidence results and API/transport failures require fallback;
- malformed/unavailable API failures.

## Run

Use a scoped Cloudflare credential with Workers AI permission:

```sh
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_API_TOKEN=... \
JEV_REPETITIONS=3 \
JEV_CONFIDENCE_THRESHOLD=0.70 \
JEV_INPUT_USD_PER_MTOKENS=0.042 \
node benchmarks/jev-skill-discovery/run.mjs
```

## Strong reasoning-model baseline

The current task itself runs on GPT-5.6 Sol with high reasoning. A first adjudication pass selected the gold skill/`none` outcome for all 26 cases. This is only a **sanity baseline**, not an independent blinded benchmark, because that same task run curated the fixture labels. Its latency/token/cost fields are therefore intentionally null, and it does not claim candidate-set-size sensitivity.

A production-quality comparison should freeze these fixtures, hide gold labels from an independently invoked reasoning-model judge, replay the same 4/8/16/24 candidate sets, and persist its raw predictions, latency, token use, and cost beside Jev results.

## Current execution status

On this machine, `wrangler whoami` reports that Wrangler 4.135.0 is not authenticated. The task environment does not have usable Workers AI credentials. The previous attempt reached Cloudflare OAuth consent but did not approve a new account grant automatically.

Therefore the fixture matrix, harness, metrics, and baseline methodology are complete, but **no live Jev accuracy, calibration, latency, token, or cost measurement is claimed yet**. The benchmark must remain explicit about this rather than fabricating provider measurements.

## Decision gate

Do not enable Jev skill loading from this partial result. A production decision requires a live replay over the frozen matrix. Suggested gates:

- zero effective false-positive loads on `none` cases after deterministic/fallback policy;
- no missed required explicit-trigger skills;
- candidate-size degradation measured on the same cases, especially at 24 choices;
- confidence threshold calibrated from observed Jev outputs rather than copied from examples;
- p95 latency and cost compared with an independently invoked reasoning-model baseline;
- malformed/unavailable responses always fall back to existing discovery behavior.

This keeps Jev optional and subordinate to deterministic skill-loading rules.
