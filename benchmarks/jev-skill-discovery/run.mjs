import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";

const fixturePath = new URL("./fixtures.json", import.meta.url);
const fixtureData = JSON.parse(await fs.readFile(fixturePath, "utf8"));
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const threshold = Number(process.env.JEV_CONFIDENCE_THRESHOLD ?? "0.70");
const repetitions = Number(process.env.JEV_REPETITIONS ?? "1");
const inputUsdPerMillion = Number(process.env.JEV_INPUT_USD_PER_MTOKENS ?? "0.042");
const candidateSetSizes = fixtureData.candidateSetSizes ?? [4, 8, 16, 24];

if (!accountId || !apiToken) {
  console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.");
  process.exit(2);
}

const catalog = fixtureData.catalog.filter((entry) => entry.name !== "none");
const fixtures = fixtureData.fixtures;

function hashString(value) {
  let hash = 2166136261;
  for (const ch of value) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function candidatesFor(fixture, candidateSetSize) {
  const target = fixture.expected === "none"
    ? null
    : catalog.find((entry) => entry.name === fixture.expected);
  const distractors = catalog.filter((entry) => !target || entry.name !== target.name);
  const start = hashString(fixture.id) % distractors.length;
  const rotated = [...distractors.slice(start), ...distractors.slice(0, start)];
  // candidateSetSize includes the synthetic `none` choice appended below.
  const wanted = Math.max(0, candidateSetSize - 1 - (target ? 1 : 0));
  const candidates = rotated.slice(0, wanted);
  if (target) {
    const insertAt = hashString(fixture.task) % (candidates.length + 1);
    candidates.splice(insertAt, 0, target);
  }
  return candidates.slice(0, Math.max(0, candidateSetSize - 1));
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function calibrationError(rows) {
  const bins = Array.from({ length: 10 }, () => []);
  for (const row of rows) {
    const idx = Math.min(9, Math.floor(row.confidence * 10));
    bins[idx].push(row);
  }
  let weighted = 0;
  for (const bin of bins) {
    if (!bin.length) continue;
    const avgConfidence = bin.reduce((sum, row) => sum + row.confidence, 0) / bin.length;
    const accuracy = bin.reduce((sum, row) => sum + (row.correct ? 1 : 0), 0) / bin.length;
    weighted += Math.abs(avgConfidence - accuracy) * (bin.length / rows.length);
  }
  return weighted;
}

async function runJev(fixture, candidateSetSize) {
  const candidates = candidatesFor(fixture, candidateSetSize);
  const criteria = Object.fromEntries(candidates.map((entry) => [entry.name, entry.description]));
  criteria.none = "No listed skill is required. The request should be handled directly without loading a specialized skill.";

  const body = {
    model: "typesafe/jev",
    input: {
      state: {
        task: fixture.task,
        candidates,
        instruction: "Select exactly one skill only when its description is materially needed for the task. Otherwise select none. Do not load merely related skills."
      },
      questions: {
        selected_skill: {
          type: "choice",
          instructions: "Which candidate skill should be loaded first for this task?",
          criteria
        }
      }
    }
  };

  const started = performance.now();
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
  const latencyMs = performance.now() - started;
  const payload = await response.json();

  if (!response.ok || payload.success === false) {
    const message = payload?.errors?.map((error) => error.message).join("; ")
      || `HTTP ${response.status}`;
    throw new Error(message);
  }

  const result = payload.result ?? payload;
  const answer = result.answers?.selected_skill;
  if (!answer || answer.type !== "choice") {
    throw new Error("Missing typed Choice answer for selected_skill");
  }

  const predicted = answer.choice;
  const confidence = Number(answer.confidence ?? answer.probabilities?.[predicted] ?? 0);
  return {
    id: fixture.id,
    expected: fixture.expected,
    predicted,
    confidence,
    probabilities: answer.probabilities ?? {},
    candidateSetSize,
    latencyMs,
    inputTokens: Number(result.usage?.input_tokens ?? 0),
    outputTokens: Number(result.usage?.output_tokens ?? 0),
    model: result.model ?? "unknown",
    fallback: confidence < threshold,
    candidates: candidates.map((entry) => entry.name)
  };
}

const rows = [];
const failures = [];
for (let rep = 0; rep < repetitions; rep += 1) {
  for (const fixture of fixtures) {
    for (const candidateSetSize of candidateSetSizes) {
      try {
        rows.push(await runJev(fixture, candidateSetSize));
      } catch (error) {
        failures.push({
          id: fixture.id,
          repetition: rep,
          candidateSetSize,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
}

for (const row of rows) {
  row.correct = row.predicted === row.expected;
}

const nonNonePredictions = rows.filter((row) => row.predicted !== "none");
const nonNoneExpected = rows.filter((row) => row.expected !== "none");
const truePositives = rows.filter((row) => row.expected !== "none" && row.predicted === row.expected).length;
const falsePositiveLoads = rows.filter((row) => row.expected === "none" && row.predicted !== "none").length;
const missedRequiredSkills = rows.filter((row) => row.expected !== "none" && row.predicted !== row.expected).length;
const inputTokens = rows.reduce((sum, row) => sum + row.inputTokens, 0);
const outputTokens = rows.reduce((sum, row) => sum + row.outputTokens, 0);
const totalAttempts = rows.length + failures.length;
const lowConfidenceFallbacks = rows.filter((row) => row.fallback).length;

const byCandidateSetSize = {};
for (const size of [...new Set(rows.map((row) => row.candidateSetSize))].sort((a, b) => a - b)) {
  const group = rows.filter((row) => row.candidateSetSize === size);
  byCandidateSetSize[size] = {
    n: group.length,
    exactMatch: group.filter((row) => row.correct).length / group.length,
    falsePositiveLoads: group.filter((row) => row.expected === "none" && row.predicted !== "none").length,
    missedRequiredSkills: group.filter((row) => row.expected !== "none" && row.predicted !== row.expected).length,
    meanConfidence: group.reduce((sum, row) => sum + row.confidence, 0) / group.length,
    fallbackRate: group.filter((row) => row.fallback).length / group.length
  };
}

const summary = {
  generatedAt: new Date().toISOString(),
  model: rows[0]?.model ?? null,
  confidenceThreshold: threshold,
  repetitions,
  completedCalls: rows.length,
  failedCalls: failures.length,
  exactMatch: rows.length ? rows.filter((row) => row.correct).length / rows.length : null,
  precision: nonNonePredictions.length ? truePositives / nonNonePredictions.length : null,
  recall: nonNoneExpected.length ? truePositives / nonNoneExpected.length : null,
  falsePositiveLoads,
  missedRequiredSkills,
  calibrationEce10: rows.length ? calibrationError(rows) : null,
  p50LatencyMs: percentile(rows.map((row) => row.latencyMs), 50),
  p95LatencyMs: percentile(rows.map((row) => row.latencyMs), 95),
  inputTokens,
  outputTokens,
  estimatedInputCostUsd: (inputTokens / 1_000_000) * inputUsdPerMillion,
  costNote: "Input-token estimate only; default uses the Cloudflare Jev dashboard price observed on 2026-09-19 ($0.042 / 1M input tokens).",
  fallbackRate: totalAttempts ? (lowConfidenceFallbacks + failures.length) / totalAttempts : null,
  fallbackBreakdown: {
    lowConfidence: lowConfidenceFallbacks,
    apiOrTransportFailure: failures.length,
    totalAttempts
  },
  byCandidateSetSize,
  failures
};

const out = { summary, rows };
const outPath = process.argv[2] ?? new URL("./results-jev.json", import.meta.url);
await fs.writeFile(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
