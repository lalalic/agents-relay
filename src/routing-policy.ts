import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type RoutingPolicy = {
  disabledProfiles?: string[];
  disabledProviders?: string[];
  preferredProviders?: string[];
  preferredProfiles?: string[];
  qualityByTaskKind?: Record<string, string[]>;
  recovery?: { penalizePriorRoute?: boolean };
};

export type LoadedRoutingPolicy = {
  path: string | null;
  hash: string;
  policy: RoutingPolicy;
  snapshot: RoutingPolicy;
  rules: { path: string; hash: string; text: string };
};

const EMPTY_POLICY: RoutingPolicy = {};

function safePolicy(value: unknown): RoutingPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const strings = (item: unknown): string[] | undefined => Array.isArray(item) && item.every(value => typeof value === 'string') ? [...item] : undefined;
  const result: RoutingPolicy = {};
  result.disabledProfiles = strings(source.disabledProfiles);
  result.disabledProviders = strings(source.disabledProviders);
  result.preferredProviders = strings(source.preferredProviders);
  result.preferredProfiles = strings(source.preferredProfiles);
  if (source.qualityByTaskKind && typeof source.qualityByTaskKind === 'object' && !Array.isArray(source.qualityByTaskKind)) {
    result.qualityByTaskKind = {};
    for (const [key, value] of Object.entries(source.qualityByTaskKind as Record<string, unknown>)) {
      const parsed = strings(value);
      if (parsed) result.qualityByTaskKind[key] = parsed;
    }
  }
  if (source.recovery && typeof source.recovery === 'object' && !Array.isArray(source.recovery)) {
    const penalize = (source.recovery as Record<string, unknown>).penalizePriorRoute;
    if (typeof penalize === 'boolean') result.recovery = { penalizePriorRoute: penalize };
  }
  return result;
}

export function policyPath(explicit?: string): string {
  return explicit ?? process.env.AGENTS_RELAY_ROUTING_POLICY ?? join(process.cwd(), '.agents-relay-routing-policy.json');
}

type RouterRules = { path: string; hash: string; text: string };

async function loadRouterRules(path: string): Promise<RouterRules> {
  try {
    const text = await readFile(path, 'utf8');
    return { path, hash: createHash('sha256').update(text).digest('hex'), text };
  } catch {
    return { path, hash: 'none', text: '' };
  }
}

async function saveRouterRules(path: string, text: string): Promise<RouterRules> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
  return { path, hash: createHash('sha256').update(text).digest('hex'), text };
}

export function modelRouterRulesPath(explicit?: string): string {
  return explicit ?? process.env.AGENTS_RELAY_MODEL_ROUTER_RULES ?? join(process.cwd(), '.agents-relay-model-router-rules.md');
}

export function workerRouterRulesPath(explicit?: string): string {
  return explicit ?? process.env.AGENTS_RELAY_WORKER_ROUTER_RULES ?? join(process.cwd(), '.agents-relay-worker-router-rules.md');
}

export async function loadModelRouterRules(explicit?: string): Promise<RouterRules> {
  return await loadRouterRules(modelRouterRulesPath(explicit));
}

export async function saveModelRouterRules(text: string, explicit?: string): Promise<RouterRules> {
  return await saveRouterRules(modelRouterRulesPath(explicit), text);
}

export async function loadWorkerRouterRules(explicit?: string): Promise<RouterRules> {
  return await loadRouterRules(workerRouterRulesPath(explicit));
}

export async function saveWorkerRouterRules(text: string, explicit?: string): Promise<RouterRules> {
  return await saveRouterRules(workerRouterRulesPath(explicit), text);
}

export async function loadRoutingPolicy(explicit?: string, explicitRules?: string): Promise<LoadedRoutingPolicy> {
  const path = policyPath(explicit);
  const rules = await loadModelRouterRules(explicitRules);
  try {
    const text = await readFile(path, 'utf8');
    const policy = safePolicy(JSON.parse(text));
    return { path, hash: createHash('sha256').update(text).digest('hex'), policy, snapshot: JSON.parse(JSON.stringify(policy)) as RoutingPolicy, rules };
  } catch {
    return { path: null, hash: 'none', policy: EMPTY_POLICY, snapshot: {}, rules };
  }
}

export function policyAllows(candidate: { provider: string; profile?: string }, policy: RoutingPolicy): boolean {
  if (policy.disabledProviders?.includes(candidate.provider)) return false;
  if (candidate.profile && policy.disabledProfiles?.includes(candidate.profile)) return false;
  return true;
}

export function policyRank(candidate: { id: string; provider: string; profile?: string }, taskKind: string | undefined, policy: RoutingPolicy): number {
  const preferred = new Set([...(policy.preferredProviders ?? []), ...(policy.preferredProfiles ?? [])]);
  const quality = taskKind ? new Set(policy.qualityByTaskKind?.[taskKind] ?? []) : new Set<string>();
  return (preferred.has(candidate.provider) || (candidate.profile && preferred.has(candidate.profile)) ? 2 : 0) + (quality.has(candidate.id) ? 1 : 0);
}
