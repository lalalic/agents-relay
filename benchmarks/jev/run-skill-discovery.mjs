import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !apiToken) {
  console.error("Cloudflare account ID and API token are required.");
  process.exit(2);
}

const fixtures = JSON.parse(await fs.readFile("benchmarks/jev/skill-discovery-fixtures.json", "utf8"));
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;
const rows = [];

for (const testCase of fixtures.cases) {
  const candidates = fixtures.candidateSets[testCase.set];
  const criteria = Object.fromEntries(candidates.map((c) => [c.name, c.description]));
  criteria.__none__ = "No listed skill is materially needed.";
  const body = {
    model: "typesafe/jev",
    input: {
      state: { task: testCase.task, candidates },
      questions: {
        selection: {
          type: "choice",
          instructions: "Select exactly one skill only when materially required. Otherwise choose __none__.",
          criteria
        }
      }
    }
  };

  const start = performance.now();
  let response;
  let payload;
  let status = "ok";
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Authorization": "Bearer " + apiToken, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    payload = await response.json();
    if (!response.ok || payload?.success === false) status = "error";
  } catch (error) {
    payload = { error: String(error) };
    status = "transport_error";
  }
  const latencyMs = performance.now() - start;
  const result = payload?.result ?? payload;
  const answer = result?.answers?.selection;
  const predicted = answer?.choice === "__none__" ? null : answer?.choice ?? null;
  rows.push({
    id: testCase.id,
    candidateSetSize: candidates.length,
    expected: testCase.expected,
    predicted,
    confidence: answer?.confidence ?? null,
    probabilities: answer?.probabilities ?? null,
    latencyMs,
    usage: result?.usage ?? null,
    model: result?.model ?? null,
    status,
    httpStatus: response?.status ?? null
  });
}

const ok = rows.filter((r) => r.status === "ok");
const tp = ok.filter((r) => r.expected !== null && r.predicted === r.expected).length;
const predictedPositive = ok.filter((r) => r.predicted !== null).length;
const expectedPositive = ok.filter((r) => r.expected !== null).length;
const latencies = ok.map((r) => r.latencyMs).sort((a,b) => a-b);
const percentile = (p) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)] : null;
const summary = {
  cases: rows.length,
  completed: ok.length,
  exactMatch: ok.length ? ok.filter((r) => r.predicted === r.expected).length / ok.length : null,
  precision: predictedPositive ? tp / predictedPositive : null,
  recall: expectedPositive ? tp / expectedPositive : null,
  falsePositiveLoads: ok.filter((r) => r.expected === null && r.predicted !== null).length,
  missedRequiredSkills: ok.filter((r) => r.expected !== null && r.predicted === null).length,
  fallbackRate: rows.length ? rows.filter((r) => r.status !== "ok").length / rows.length : null,
  p50LatencyMs: percentile(0.5),
  p95LatencyMs: percentile(0.95),
  inputTokens: ok.reduce((sum, r) => sum + (r.usage?.input_tokens ?? 0), 0),
  outputTokens: ok.reduce((sum, r) => sum + (r.usage?.output_tokens ?? 0), 0)
};

await fs.writeFile("benchmarks/jev/skill-discovery-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), summary, rows }, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
