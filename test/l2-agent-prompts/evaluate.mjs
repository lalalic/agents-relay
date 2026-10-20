import { evaluateWithModelOnlyApi } from './model-only-openai.mjs';
import { resolve } from 'node:path';
import { managedWorkerInput } from '../../dist/managed-worker-input.js';
import { resolveExecutionContext } from '../../dist/execution-context.js';
import { scenarios } from './scenarios.mjs';

const enabled = process.env.AGENTS_RELAY_L2_LIVE === '1';
const adapters = ['codex', 'chatgpt'];
const projectPath = resolve('.');
const context = await resolveExecutionContext(projectPath, 'worker');
const all = [];

function finalMessage(output) {
  let answer = '';
  for (const line of output.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') answer = event.item.text;
      if (event.type === 'event_msg' && event.payload?.type === 'task_complete' && typeof event.payload.last_agent_message === 'string') answer = event.payload.last_agent_message;
    } catch { /* ignore runtime diagnostics */ }
  }
  if (answer) return answer;
  return output.trim();
}

function evaluate(response, evidence, acceptance) {
  let value;
  try { value = JSON.parse(response); } catch { return { status: 'FAIL', reason: 'provider did not return the requested JSON evaluation' }; }
  const rationale = typeof value.rationale === 'string' ? value.rationale.trim() : '';
  const claims = Array.isArray(value.claims) ? value.claims.filter(item => typeof item === 'string') : [];
  const score = Number.isInteger(value.score) && value.score >= 0 && value.score <= 4;
  const evidenceTerms = [...new Set(evidence.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(term => term.length > 4);
  const groundedTerms = evidenceTerms.filter(term => `${rationale} ${claims.join(' ')}`.toLowerCase().includes(term));
  const answer = `${rationale} ${claims.join(' ')}`;
  const supportedCriteria = acceptance.filter(pattern => pattern.test(answer)).length;
  const unsupportedAction = /publish (?:task\.)|task\.(?:started|completed|failed)|run commands|edit files|contact production/i.test(`${rationale} ${claims.join(' ')}`);
  const grounded = rationale.length >= 60 && claims.length > 0 && groundedTerms.length >= 2 && !unsupportedAction;
  const status = score && value.score === 4 && grounded && supportedCriteria === acceptance.length ? 'PASS' : 'FAIL';
  return { status, score: score ? value.score : null, rationale, claims, evidenceTerms: groundedTerms, supportedCriteria, criteriaCount: acceptance.length, unsupportedAction };
}


for (const scenario of scenarios) for (const adapter of adapters) {
  const task = {
    id: `l2-${scenario.role}`, jobId: 'l2-prompt-evaluation', parentTaskId: null,
    title: `Evaluate ${scenario.role} prompt`, kind: 'work', agentName: scenario.role === 'worker' ? 'implementation' : scenario.role,
    adapter, input: `${scenario.evidence}\n\nEvaluate what the assigned role should do from this evidence. Return JSON only: {"score":0-4,"rationale":"evidence-based explanation","claims":["specific factual or role-guidance claims"]}. Score 4 only when the response follows the role's evidence and safety standards; lower scores should name the concrete gap. Do not quote rubric labels or invent facts.`,
    output: { kind: 'task_pr' }, executionId: `l2-${scenario.role}`, attempt: 1, maxAttempts: 1,
    dependencies: [], state: 'QUEUED', error: null,
  };
  task.input += '\n[Evaluation record identity]\n' + task.executionId;
  const job = { id: 'l2-prompt-evaluation', repository: 'example/prompt-evaluation', title: 'Prompt evaluation', objective: 'Evaluate assembled role prompts', state: 'ACTIVE', localMerge: { sourceRef: 'l2-prompt-evaluation' }, tasks: [task], plans: [] };
  const prompt = (await managedWorkerInput(job, task, context, 'evaluation')).replace(/adapter: (?:codex|chatgpt)/g, 'adapter: blinded');
  if (!enabled) { all.push({ role: scenario.role, adapter, status: 'NOT_RUN', reason: 'AGENTS_RELAY_L2_LIVE not enabled' }); continue; }
  // The public ChatGPT UI has no model-only API transport. A different model
  // cannot be substituted for ChatGPT to manufacture passing L2 evidence.
  if (adapter === 'chatgpt') { all.push({ role: scenario.role, adapter, status: 'NOT_RUN', reason: 'ChatGPT model-only evaluation transport unavailable' }); continue; }
  const result = await evaluateWithModelOnlyApi({
    prompt,
    apiKey: process.env.AGENTS_RELAY_L2_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
    model: process.env.AGENTS_RELAY_L2_OPENAI_MODEL,
  });
  if (result.status !== 'OK') { all.push({ role: scenario.role, adapter, status: result.status, reason: result.reason }); continue; }
  all.push({ role: scenario.role, adapter, verifiedModel: result.verifiedModel,
    ...evaluate(result.answer, scenario.evidence, scenario.acceptance) });
}
console.log(JSON.stringify(all, null, 2));
if (enabled && all.some(result => result.status !== 'PASS')) process.exitCode = 1;
