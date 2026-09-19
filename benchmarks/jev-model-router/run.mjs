import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";

const fixtures = JSON.parse(await fs.readFile(new URL("./fixtures.json", import.meta.url), "utf8"));
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const repetitions = Number(process.env.JEV_REPETITIONS ?? "1");
const confidenceThreshold = Number(process.env.JEV_CONFIDENCE_THRESHOLD ?? "0.75");

const routeCriteria = {
  fast_medium: "Use the fastest eligible model at medium reasoning for narrow, low-risk, well-scoped implementation or validation.",
  balanced_medium: "Use a balanced general model at medium reasoning for multi-file implementation, debugging, compatibility, or moderate architectural work.",
  reasoning_high: "Use the strongest eligible reasoning model at high reasoning for high-risk, broad, ambiguous, architecture/review/security/evaluation work.",
  thinking_standard: "Use an extended-thinking profile when the task benefits from deliberate reasoning but does not clearly require the strongest high-reasoning route."
};

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function currentMetrics() {
  const exact = fixtures.filter((f) => f.currentRoute === f.reasoningBaseline).length;
  const succeeded = fixtures.filter((f) => f.downstreamOutcome === "succeeded");
  const succeededAgreement = succeeded.filter((f) => f.currentRoute === f.reasoningBaseline).length;
  return {
    cases: fixtures.length,
    exactAgreementWithReasoningBaseline: exact / fixtures.length,
    downstreamQualityProxy: {
      definition: "fraction of succeeded durable tasks whose current route agrees with the reasoning baseline; descriptive only because outcome is heavily confounded by implementation/tooling",
      succeededCases: succeeded.length,
      agreementAmongSucceeded: succeeded.length ? succeededAgreement / succeeded.length : null
    }
  };
}

function buildInput(fixture) {
  const eligibleCriteria = Object.fromEntries(fixture.eligibleRoutes.map((route) => [route, routeCriteria[route]]));
  return {
    state: {
      task: fixture.task,
      requirements: fixture.requirements,
      risk: fixture.risk,
      deterministic_eligibility: fixture.eligibleRoutes,
      note: "Eligibility is fixed by deterministic policy. Select only among listed routes."
    },
    questions: {
      route: { type: "choice", instructions: "Which eligible semantic route tier best fits this task? Do not override deterministic eligibility.", criteria: eligibleCriteria },
      complexity: { type: "score", instructions: "How much reasoning depth does this task require after eligibility is fixed?", criteria: ["Narrow/routine: low ambiguity and low risk","Moderate: multi-step or multi-file but conventional","High: architecture, difficult debugging, security, evaluation, or broad integration","Very high: deep cross-cutting review or unusually ambiguous/high-consequence reasoning"] },
      needs_reasoning_fallback: { type: "noul", instructions: "Should this decision be escalated to the strong reasoning-model fallback rather than trusted as a cheap semantic routing decision?", criteria: { true: "Ambiguous/high-risk/cross-cutting task where a routing mistake can materially reduce quality", false: "The semantic fit is clear enough to use the selected eligible route without a separate reasoning-model routing review" } }
    }
  };
}

async function invoke(fixture) {
  const start = performance.now();
  const response = await fetch("https://api.cloudflare.com/client/v4/accounts/" + accountId + "/ai/run", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "typesafe/jev", input: buildInput(fixture) })
  });
  const latencyMs = performance.now() - start;
  const body = await response.json();
  if (!response.ok || body?.success === false) throw new Error("Cloudflare Workers AI error " + response.status + ": " + JSON.stringify(body));
  return { latencyMs, result: body?.result ?? body };
}

function brier(probabilities, expected) {
  if (!probabilities) return null;
  const labels = Object.keys(probabilities);
  if (!labels.length) return null;
  return labels.reduce((sum, label) => {
    const target = label === expected ? 1 : 0;
    const p = Number(probabilities[label] ?? 0);
    return sum + (p - target) ** 2;
  }, 0);
}

const output = { generatedAt: new Date().toISOString(), model: "typesafe/jev", transport: "Cloudflare Workers AI REST", repetitions, confidenceThreshold, currentPolicy: currentMetrics(), jev: null };

if (!accountId || !token) {
  output.jev = { status: "blocked_authentication", reason: "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN with Workers AI Read/Edit permissions.", results: [] };
  console.log(JSON.stringify(output, null, 2));
  process.exit(2);
}

const runs = [];
for (const fixture of fixtures) {
  for (let i = 0; i < repetitions; i += 1) {
    try {
      const { latencyMs, result } = await invoke(fixture);
      const route = result?.answers?.route;
      const fallback = result?.answers?.needs_reasoning_fallback;
      const confidence = Number(route?.confidence ?? 0);
      runs.push({ id: fixture.id, repetition: i + 1, expected: fixture.reasoningBaseline, current: fixture.currentRoute, choice: route?.choice ?? null, confidence, probabilities: route?.probabilities ?? null, complexityScore: result?.answers?.complexity?.score ?? null, fallbackNoul: fallback?.noul ?? null, shouldFallback: confidence < confidenceThreshold || Number(fallback?.noul ?? 0) >= 0.5, brier: brier(route?.probabilities, fixture.reasoningBaseline), latencyMs, inputTokens: result?.usage?.input_tokens ?? null, outputTokens: result?.usage?.output_tokens ?? null, modelVersion: result?.model ?? null });
    } catch (error) {
      runs.push({ id: fixture.id, repetition: i + 1, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

const successful = runs.filter((r) => !r.error);
const latencies = successful.map((r) => r.latencyMs);
const exact = successful.filter((r) => r.choice === r.expected).length;
const currentAgreement = successful.filter((r) => r.choice === r.current).length;
const fallbackCount = successful.filter((r) => r.shouldFallback).length;
const briers = successful.map((r) => r.brier).filter((v) => typeof v === "number");
const inputTokens = successful.map((r) => r.inputTokens).filter((v) => typeof v === "number");
const outputTokens = successful.map((r) => r.outputTokens).filter((v) => typeof v === "number");

output.jev = {
  status: successful.length ? "completed" : "failed",
  successfulRuns: successful.length,
  failedRuns: runs.length - successful.length,
  exactMatchWithReasoningBaseline: successful.length ? exact / successful.length : null,
  agreementWithCurrentRouter: successful.length ? currentAgreement / successful.length : null,
  meanMulticlassBrier: briers.length ? briers.reduce((a, b) => a + b, 0) / briers.length : null,
  fallbackRate: successful.length ? fallbackCount / successful.length : null,
  latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
  usage: { inputTokens: inputTokens.reduce((a, b) => a + b, 0), outputTokens: outputTokens.reduce((a, b) => a + b, 0), costUsd: null, costNote: "Cloudflare public Jev model docs point to dashboard pricing; token usage is recorded and cost remains null rather than inventing a token price." },
  runs
};

console.log(JSON.stringify(output, null, 2));
