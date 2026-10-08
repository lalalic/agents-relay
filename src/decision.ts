import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ChoiceDecisionContract = {
  type: 'choice';
  question: string;
  choices: readonly string[];
};

export type DecisionContract = ChoiceDecisionContract;
export type DecisionRequest = { facts: JsonValue };
export type ChoiceDecisionResult = { type: 'choice'; choice: string; probabilities?: Record<string, number>; usage?: { input_tokens?: number; output_tokens?: number; cost?: number }; latencyMs?: number; model?: string };
export type DecisionResult = ChoiceDecisionResult;
export type DecisionMode = 'off' | 'shadow' | 'active';

export interface DecisionEngine {
  readonly name: string;
  decide(request: DecisionRequest, contract: DecisionContract): Promise<DecisionResult>;
}

export type DecisionEvidence = {
  mode: DecisionMode;
  engine?: string;
  proposed?: string;
  probabilities?: Record<string, number>;
  fallback: boolean;
  error?: string;
};

export type DecisionChoice = {
  choice: string;
  evidence: DecisionEvidence;
};

function validateContract(contract: DecisionContract): void {
  if (contract.type !== 'choice') throw new Error(`Unsupported decision contract ${(contract as { type?: unknown }).type}`);
  if (!contract.question.trim()) throw new Error('Decision choice question is required');
  if (contract.choices.length === 0) throw new Error('Decision choice contract requires at least one choice');
  if (new Set(contract.choices).size !== contract.choices.length) throw new Error('Decision choice contract contains duplicate choices');
  if (contract.choices.some(choice => !choice.trim())) throw new Error('Decision choice contract contains an empty choice');
}

function assertJson(value: unknown, path = 'facts'): asserts value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJson(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) throw new Error(`${path}.${key} is undefined`);
      assertJson(item, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} is not JSON-safe`);
}

export function validateDecisionRequest(request: DecisionRequest, contract: DecisionContract): void {
  validateContract(contract);
  assertJson(request.facts);
}

function probabilities(value: unknown, choices: readonly string[]): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const choice of choices) {
    const score = source[choice];
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) return undefined;
    result[choice] = score;
  }
  return Object.keys(result).length === choices.length ? result : undefined;
}

export function parseChoiceDecision(raw: unknown, contract: ChoiceDecisionContract): ChoiceDecisionResult {
  validateContract(contract);
  if (!raw || typeof raw !== 'object') throw new Error('Decision output must be a JSON object');
  const envelope = raw as Record<string, unknown>;
  const nested = envelope.answers && typeof envelope.answers === 'object' && !Array.isArray(envelope.answers)
    ? (envelope.answers as Record<string, unknown>).decision
    : undefined;
  const answer = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : envelope;
  const choice = typeof answer.choice === 'string' ? answer.choice : '';
  if (!contract.choices.includes(choice)) throw new Error(`Decision choice ${choice || '<missing>'} is outside the contract`);
  const result: ChoiceDecisionResult = { type: 'choice', choice };
  const parsedProbabilities = probabilities(answer.probabilities, contract.choices);
  if (parsedProbabilities) result.probabilities = parsedProbabilities;
  return result;
}

export type JevDecisionOptions = {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
};

/** OpenRouter Decisions API adapter; the choice contract remains engine-independent. */
export class JevDecisionEngine implements DecisionEngine {
  readonly name = 'openrouter-jev';
  constructor(private readonly options: JevDecisionOptions = {}) {}

  async decide(request: DecisionRequest, contract: DecisionContract): Promise<DecisionResult> {
    validateDecisionRequest(request, contract);
    const apiKey = this.options.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for Jev');
    const choices = Object.fromEntries(contract.choices.map((choice, index) => [`route_${index + 1}`, choice]));
    const started = Date.now();
    const response = await (this.options.fetcher ?? fetch)(this.options.endpoint ?? 'https://openrouter.ai/api/alpha/decisions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.options.model ?? 'typesafe/jev-1.13',
        state: request.facts,
        questions: { decision: { type: 'choice', instructions: contract.question, criteria: choices } },
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 12_000),
    });
    if (!response.ok) throw new Error(`Jev Decisions API returned HTTP ${response.status}`);
    const raw: unknown = await response.json();
    const envelope = raw as { answers?: { decision?: { choice?: unknown; probabilities?: unknown } } };
    const answer = envelope?.answers?.decision;
    if (!answer || typeof answer.choice !== 'string' || !Object.hasOwn(choices, answer.choice)) {
      throw new Error('Jev returned a choice outside the decision contract');
    }
    const mappedProbabilities = answer.probabilities && typeof answer.probabilities === 'object'
      ? Object.fromEntries(Object.entries(answer.probabilities as Record<string, unknown>)
        .filter(([id]) => Object.hasOwn(choices, id)).map(([id, p]) => [choices[id], p]))
      : undefined;
    return {
      ...parseChoiceDecision({ choice: choices[answer.choice], probabilities: mappedProbabilities }, contract),
      usage: (raw as { usage?: ChoiceDecisionResult['usage'] }).usage,
      latencyMs: Date.now() - started,
      model: (raw as { model?: string }).model,
    };
  }
}

/** Select router engine without changing caller-owned hard gates. */
export function executionDecisionEngine(): DecisionEngine {
  return new JevDecisionEngine();
}

export type LayaCliOptions = {
  command?: string;
  args?: readonly string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

/**
 * Stateless Laya invocation. The adapter materializes the caller's JSON state
 * and question contract as temporary files for `uvx laya-mlx predict`. It is
 * intentionally a subprocess per
 * decision: no daemon, resident model, socket, or PM2 lifecycle is introduced.
 */
export class LayaCliDecisionEngine implements DecisionEngine {
  readonly name = 'laya-cli';
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly timeoutMs: number;
  private readonly env?: NodeJS.ProcessEnv;

  constructor(options: LayaCliOptions = {}) {
    this.command = options.command ?? 'uvx';
    this.args = options.args ?? layaArgsFromEnv();
    this.timeoutMs = options.timeoutMs ?? Number(process.env.AGENTS_RELAY_LAYA_TIMEOUT_MS ?? 30_000);
    this.env = options.env;
  }

  async decide(request: DecisionRequest, contract: DecisionContract): Promise<DecisionResult> {
    validateDecisionRequest(request, contract);
    const questions = {
      decision: {
        type: contract.type,
        instructions: contract.question,
        criteria: [...contract.choices],
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'agents-relay-laya-'));
    try {
      const statePath = join(dir, 'state.json');
      const questionsPath = join(dir, 'questions.json');
      await Promise.all([
        writeFile(statePath, JSON.stringify(request.facts), 'utf8'),
        writeFile(questionsPath, JSON.stringify(questions), 'utf8'),
      ]);
      const stdout = await this.run(['--state-file', statePath, '--questions', questionsPath]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new Error('Laya CLI returned invalid JSON');
      }
      return parseChoiceDecision(parsed, contract);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async run(extraArgs: readonly string[]): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(this.command, [...this.args, ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'], env: this.env ?? process.env });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const finish = (error?: Error, output?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(output ?? '');
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error(`Laya CLI timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
      child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
      child.once('error', error => finish(error));
      child.once('close', code => {
        if (code !== 0) {
          const detail = Buffer.concat(stderr).toString('utf8').trim();
          finish(new Error(`Laya CLI exited ${code}${detail ? `: ${detail}` : ''}`));
          return;
        }
        finish(undefined, Buffer.concat(stdout).toString('utf8').trim());
      });
    });
  }
}

function layaArgsFromEnv(): readonly string[] {
  const configured = process.env.AGENTS_RELAY_LAYA_ARGS;
  if (!configured) return ['laya-mlx', 'predict'];
  try {
    const parsed = JSON.parse(configured) as unknown;
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error('not a string array');
    return parsed;
  } catch {
    throw new Error('AGENTS_RELAY_LAYA_ARGS must be a JSON string array');
  }
}

export function decisionMode(): DecisionMode {
  return 'active';
}

export async function chooseWithDecision(
  engine: DecisionEngine | undefined,
  mode: DecisionMode,
  request: DecisionRequest,
  contract: ChoiceDecisionContract,
  fallback: () => string,
): Promise<DecisionChoice> {
  validateDecisionRequest(request, contract);
  const deterministic = fallback();
  if (!contract.choices.includes(deterministic)) throw new Error('Deterministic fallback is outside the decision contract');
  if (mode === 'off' || !engine) return { choice: deterministic, evidence: { mode, fallback: true } };
  try {
    const result = await engine.decide(request, contract);
    if (result.type !== 'choice') throw new Error(`Unexpected decision result ${result.type}`);
    if (mode === 'shadow') {
      return {
        choice: deterministic,
        evidence: { mode, engine: engine.name, proposed: result.choice, probabilities: result.probabilities, fallback: true },
      };
    }
    return {
      choice: result.choice,
      evidence: { mode, engine: engine.name, proposed: result.choice, probabilities: result.probabilities, fallback: false },
    };
  } catch (error) {
    return {
      choice: deterministic,
      evidence: { mode, engine: engine.name, fallback: true, error: error instanceof Error ? error.message : String(error) },
    };
  }
}
