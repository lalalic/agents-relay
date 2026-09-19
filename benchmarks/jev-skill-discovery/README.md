# Jev skill-discovery benchmark

Task: `jev-skill-discovery-benchmark`
PR: #23
Date: 2026-09-19

## Scope

This benchmark evaluates `typesafe/jev` as an optional semantic skill-discovery/selection layer after deterministic policy. It does **not** alter production skill loading.

The frozen dataset contains 26 representative historical/synthetic XChat and Agents Relay tasks. Each case is replayed against controlled total choice-set sizes of **4, 8, 16, and 24** (including `none`). Jev is repeated three times per case/size (312 decisions); the strong reasoning baseline is run once on the same 104 case/size combinations.

## Files

- `fixtures.json` — 24-skill controlled catalog, 26 labeled tasks, candidate-set sizes.
- `run.mjs` — direct Cloudflare Workers AI runner.
- `run_openrouter.py` — behavioral replay against the same Jev 1.13 build through OpenRouter.
- `run_strong_judge.py` — independent GPT-5.6 Sol / high-reasoning baseline on the same matrix.
- `openrouter-results.json` — raw Jev behavioral proxy results.
- `strong-judge-results.json` — raw strong-reasoning results.
- `results-reasoning-baseline.json` — original non-blinded sanity adjudication retained for provenance.
- `report-2026-09-19.md` — benchmark interpretation and recommendation.

## Cloudflare API shape

The direct runner targets Workers AI:

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

Cloudflare-specific transport was validated by the sibling result-review benchmark in this PR, but the signed-in account returned **HTTP 402 / code 2021 (insufficient balance)**. No funds, billing settings, or production configuration were changed. Therefore Cloudflare-specific latency, token usage, cost, and success-rate measurements are not claimed here.

For behavioral measurement only, the benchmark uses the same Jev release through the already-configured OpenRouter account:

- route: `typesafe/jev-1.13`
- returned build: `typesafe/jev-1.13-20260917`
- endpoint: OpenRouter Decisions API

These proxy measurements must not be presented as Cloudflare transport performance.

## Results

| Metric | Jev 1.13 behavioral proxy | GPT-5.6 Sol high |
| --- | ---: | ---: |
| Decisions | 312 (3 repeats) | 104 |
| Exact match | **98.72%** | 97.12% |
| False-positive skill loads on expected `none` | **0** | **0** |
| Missed required-skill decisions | 4 | 3 |
| Jev confidence ECE (10-bin) | **0.0302** | n/a |
| Fallback rate at confidence < 0.70 | **5.77%** | n/a |
| p50 latency | **370.8 ms** | 1586.7 ms |
| p95 latency | **934.6 ms** | 3038.8 ms |
| Reported API cost | **$0.01692 / 312** | $0.16848 / 104 |

The Jev proxy is about **4.3× faster at p50** in this small run. Reported cost per decision is about **30× lower** than the strong reasoning baseline. Those latency/cost numbers are provider-specific and are not Cloudflare measurements.

### Candidate-set-size sensitivity

| Choices | Jev exact match | Jev misses | Jev mean confidence | Jev fallback | Strong exact match | Strong misses |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 4 | 96.15% | 3 | 0.968 | 3.85% | 100% | 0 |
| 8 | 100% | 0 | 0.963 | 3.85% | 100% | 0 |
| 16 | 100% | 0 | 0.953 | 7.69% | 92.31% | 2 |
| 24 | 98.72% | 1 | 0.944 | 7.69% | 96.15% | 1 |

Mean Jev confidence declines as the candidate set grows, but accuracy does not degrade monotonically. This fixture set is too small to claim a general candidate-count scaling law.

### Jev errors and fallback behavior

All four Jev errors were below the configured 0.70 fallback threshold:

- `historical-managed-pr`, 4 choices, all three repeats: selected `agents-relay` instead of `xchat-orchestrator` at confidence 0.54–0.56.
- `synthetic-minimal-code`, 24 choices, one repeat: selected `none` instead of `ponytail` at confidence 0.47.

There were **0 high-confidence Jev errors** in this replay. Eighteen of 312 calls (5.77%) would fall back; 4 of those 18 were incorrect and 14 were correct but uncertain. This is encouraging for an escalation design, but the threshold is calibrated on the same small fixture set and is not production-ready.

## Interpretation

The strongest observed use is **semantic preselection after deterministic skill rules**, not autonomous skill loading.

Recommended experimental boundary:

```text
explicit trigger / mandatory deterministic rules
  -> candidate skill set
  -> Jev typed Choice
  -> confidence + policy gate
       high confidence, low risk -> semantic recommendation
       low confidence / malformed / unavailable -> existing reasoning discovery
  -> existing skill loader remains authoritative
```

Do not let Jev override:

- explicit `#skill-name` requests;
- mandatory skills specified by AGENTS/bootstrap contracts;
- security/runtime eligibility;
- exact project-local override precedence;
- deterministic `none` rules where applicable.

## Reproduction

Behavioral Jev proxy:

```sh
python3 benchmarks/jev-skill-discovery/run_openrouter.py --repeats 3 --workers 12
```

Independent strong reasoning baseline:

```sh
python3 benchmarks/jev-skill-discovery/run_strong_judge.py
```

Direct Cloudflare Workers AI (requires a funded/authorized account):

```sh
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_API_TOKEN=... \
JEV_REPETITIONS=3 \
JEV_CONFIDENCE_THRESHOLD=0.70 \
node benchmarks/jev-skill-discovery/run.mjs
```

All runners read credentials from environment variables and do not persist them.

## Recommendation

**Do not change production skill loading from this benchmark.** Jev is promising enough to continue as an optional semantic recommendation/escalation layer because the proxy produced zero false-positive `none` loads, high exact match, low calibration error, and all observed errors were below the fallback threshold. Before enabling it, rerun the frozen matrix through Cloudflare directly, expand to at least 200 independently labeled historical tasks, and calibrate the confidence threshold on a held-out set.
