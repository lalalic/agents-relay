import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const API = 'https://openrouter.ai/api/alpha/decisions';
const MODEL = 'typesafe/jev-1.13';
const ROUTES = [
  'codex::openrouter:openrouter/auto@medium',
  'codex::zai:glm-5.3-flash@high',
  'codex::openai:gpt-5.6-sol@medium',
  'chatgpt::chatgpt:account-defaults',
];
const RULES = 'Use zai first. Never use openrouter provider or openrouter/auto. ChatGPT worker is broken.';
const outDir = process.env.JEV_EVAL_OUTPUT || '/tmp/agents-relay-jev-evals';

export function createRequest({ choices, rules = RULES, size = 'M', usage = {}, task = {} }) {
  return {
    model: MODEL,
    state: { task_size: size, usage_by_provider: usage, ...task },
    questions: { route: {
      type: 'choice',
      instructions: `User routing instructions have highest priority. Candidate order has no priority. ${rules} Select one compliant route. If there is no compliant route, do not pretend that a forbidden choice is compliant.`,
      criteria: Object.fromEntries(choices.map((route, i) => [`route_${i + 1}`, route])),
    } },
  };
}

export function parseResponse(body, request) {
  const answer = body?.answers?.route;
  const choices = request.questions.route.criteria;
  if (!answer || typeof answer.choice !== 'string' || !Object.hasOwn(choices, answer.choice)) {
    throw new Error('invalid_or_out_of_contract_decision');
  }
  return { selected: choices[answer.choice], probabilities: answer.probabilities ?? null };
}

export async function decide(request, { fetcher = fetch, key = process.env.OPENROUTER_API_KEY, timeoutMs = 12000 } = {}) {
  if (!key) throw new Error('missing_api_key');
  const started = performance.now();
  const response = await fetcher(API, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(request), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`jev_http_${response.status}`);
  const raw = await response.json();
  const parsed = parseResponse(raw, request);
  return { ...parsed, usage: raw.usage ?? null, latencyMs: Math.round(performance.now() - started), model: raw.model ?? null };
}

export function safeFallback(choices, forbidden = ['openrouter']) {
  return choices.find(c => !forbidden.some(x => c.toLowerCase().includes(x))) ?? null;
}

export function auditEntry(request, outcome) {
  return { engine: MODEL, question: request.questions.route.instructions,
    taskFacts: request.state, candidates: request.questions.route.criteria,
    selected: outcome.selected ?? null, probabilities: outcome.probabilities ?? null,
    usage: outcome.usage ?? null, latencyMs: outcome.latencyMs ?? null,
    error: outcome.error ?? null, fallback: outcome.fallback ?? false };
}

async function run() {
  await mkdir(outDir, { recursive: true });
  const records = [];
  const emit = async (name, request, fn, check) => {
    const start = performance.now();
    let outcome;
    try {
      outcome = await fn();
      const pass = check(outcome);
      records.push({ name, pass, ...auditEntry(request, outcome) });
    } catch (error) {
      records.push({ name, pass: false, ...auditEntry(request, { error: String(error) }), latencyMs: Math.round(performance.now() - start) });
    }
    console.log(`${records.at(-1).pass ? 'PASS' : 'FAIL'} ${name}: ${records.at(-1).selected ?? records.at(-1).error}`);
  };
  const base = createRequest({ choices: ROUTES });
  await emit('invalid_output_rejected', base, async () => { assert.throws(() => parseResponse({ answers: { route: { choice: 'not_a_choice' } } }, base)); return { selected: 'rejected' }; }, x => x.selected === 'rejected');
  await emit('http_failure_handled', base, async () => { await assert.rejects(decide(base, { key: 'fake', fetcher: async () => ({ ok: false, status: 503 }) }), /jev_http_503/); return { selected: 'handled' }; }, x => x.selected === 'handled');
  await emit('timeout_handled', base, async () => { await assert.rejects(decide(base, { key: 'fake', fetcher: async () => { throw new DOMException('request timed out', 'TimeoutError'); } }), /TimeoutError/); return { selected: 'handled' }; }, x => x.selected === 'handled');
  await emit('fallback_respects_known_exclusions', base, async () => ({ selected: safeFallback(ROUTES, ['openrouter', 'chatgpt']) }), x => x.selected === ROUTES[1]);
  await emit('audit_roundtrip', base, async () => { const e = auditEntry(base, { selected: ROUTES[1], usage: { input_tokens: 42, cost: 0.01 } }); assert.deepEqual(JSON.parse(JSON.stringify(e)).candidates, base.questions.route.criteria); return { selected: e.selected, usage: e.usage }; }, x => x.selected === ROUTES[1] && x.usage.input_tokens === 42);
  if (!process.env.JEV_LIVE) {
    console.log('Live tests skipped. Run JEV_LIVE=1 with OPENROUTER_API_KEY for API behavior tests.');
  } else {
    const lowZai = { 'codex::zai': { five_hour: { remaining_percent: 0, reset_in_minutes: 120 }, weekly: { remaining_percent: 0, reset_in_minutes: 200 } }, 'codex::openai': { five_hour: { remaining_percent: 85, reset_in_minutes: 180 }, weekly: { remaining_percent: 91, reset_in_minutes: 4500 } } };
    await emit('usage_exhausted_zai', createRequest({ choices: ROUTES, rules: 'ZAI quota is exhausted. Do not use ZAI or OpenRouter or ChatGPT. Use OpenAI.', usage: lowZai }), () => decide(createRequest({ choices: ROUTES, rules: 'ZAI quota is exhausted. Do not use ZAI or OpenRouter or ChatGPT. Use OpenAI.', usage: lowZai })), x => x.selected === ROUTES[2]);
    await emit('forbid_default_provider', base, () => decide(base), x => x.selected === ROUTES[1]);
    const impossible = createRequest({ choices: [ROUTES[0]], rules: 'Never choose OpenRouter. There are no acceptable routes.' });
    await emit('no_legal_choice_detected', impossible, () => decide(impossible), () => false);
    for (const n of [10, 20, 50]) {
      const extra = Array.from({ length: n - 2 }, (_, i) => `codex::openai:alternative-model-${i}@medium`);
      const choices = [ROUTES[0], ...extra, ROUTES[1]];
      const q = createRequest({ choices, rules: 'Only choose codex::zai:glm-5.3-flash@high. Never choose OpenRouter or any OpenAI alternative.' });
      await emit(`choice_scale_${n}`, q, () => decide(q), x => x.selected === ROUTES[1]);
    }
  }
  await writeFile(`${outDir}/audit.json`, JSON.stringify(records, null, 2));
  console.log(JSON.stringify({ total: records.length, passed: records.filter(r => r.pass).length, failed: records.filter(r => !r.pass).length, audit: `${outDir}/audit.json` }));
  if (records.some(r => !r.pass)) process.exitCode = 1;
}
if (process.argv[1]?.endsWith('jev-decision-evals.mjs')) await run();
