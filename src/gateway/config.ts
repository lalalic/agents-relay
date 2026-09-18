import { readFileSync } from 'node:fs';

export type GatewayRouting = { provider: string; model: string; profile?: string; reasoning?: string };
export type GatewayAdapter = 'codex';
export type GatewayProject = {
  name: string;
  repository: string;
  localPath: string;
  baseBranch: string;
  adapter: GatewayAdapter;
  capabilities: string[];
  routing: GatewayRouting;
  maxAttempts: number;
  timeoutMs: number;
  maxConcurrent: number;
  trustedAuthors: string[];
  label: string;
  branchPrefix: string;
  dashboardUrl: string | null;
};
export type GatewayEventsConfig = { enabled: boolean; natsUrl: string; subjectPrefix: string };
export type GatewayConfig = {
  token: string;
  bind: string;
  port: number;
  maxBodyBytes: number;
  maxActiveJobs: number;
  createTimeoutMs: number;
  idleTtlMs: number;
  watchdogMs: number;
  publicBaseUrl: string | null;
  codexCommand: string;
  events: GatewayEventsConfig;
  projects: GatewayProject[];
};

export const GATEWAY_DEFAULTS = {
  bind: '127.0.0.1',
  port: 8790,
  maxBodyBytes: 65536,
  maxActiveJobs: 8,
  createTimeoutMs: 5000,
  idleTtlMs: 1800000,
  watchdogMs: 60000,
  codexCommand: 'codex',
  natsUrl: 'nats://127.0.0.1:4222',
  subjectPrefix: 'agents-relay.events.job',
} as const;

export const CODEX_CAPABILITIES: readonly string[] = ['model', 'codex'];
export const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type RawObject = Record<string, unknown>;
type Environment = Record<string, string | undefined>;

function asObject(value: unknown, label: string): RawObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ConfigError(`${label} must be a JSON object`);
  return value as RawObject;
}
function rejectUnknownKeys(value: RawObject, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length > 0) throw new ConfigError(`${label} has unsupported keys: ${unknown.join(', ')}`);
}
function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ConfigError(`${label} must be a non-empty string`);
  return value;
}
function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireNonEmptyString(value, label);
}
function requireStringArray(value: unknown, label: string, minimum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum) throw new ConfigError(`${label} must be an array with at least ${minimum} entr${minimum === 1 ? 'y' : 'ies'}`);
  return value.map((item, index) => requireNonEmptyString(item, `${label}[${index}]`));
}
function intFrom(value: unknown, label: string, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isInteger(numeric) || numeric <= 0) throw new ConfigError(`${label} must be a positive integer`);
  return numeric;
}
function optionalHttpsUrl(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = requireNonEmptyString(value, label);
  if (!text.startsWith('https://')) throw new ConfigError(`${label} must be an https:// URL`);
  return text.replace(/\/+$/, '');
}
function arg(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function parseProject(value: unknown, label: string): GatewayProject {
  const raw = asObject(value, label);
  rejectUnknownKeys(raw, ['name', 'repository', 'local_path', 'base_branch', 'adapter', 'capabilities', 'routing', 'max_attempts', 'timeout_ms', 'max_concurrent', 'trusted_authors', 'label', 'branch_prefix', 'dashboard_url'], label);
  const name = requireNonEmptyString(raw.name, `${label}.name`);
  if (!PROJECT_NAME_PATTERN.test(name)) throw new ConfigError(`${label}.name must match ${PROJECT_NAME_PATTERN.source}`);
  const repository = requireNonEmptyString(raw.repository, `${label}.repository`);
  if (!REPOSITORY_PATTERN.test(repository)) throw new ConfigError(`${label}.repository must look like owner/name`);
  const localPath = requireNonEmptyString(raw.local_path, `${label}.local_path`);
  if (!localPath.startsWith('/')) throw new ConfigError(`${label}.local_path must be an absolute path`);
  const baseBranch = requireNonEmptyString(raw.base_branch, `${label}.base_branch`);
  const adapter = requireNonEmptyString(raw.adapter, `${label}.adapter`);
  if (adapter !== 'codex') throw new ConfigError(`${label}.adapter must be "codex"`);
  const capabilities = requireStringArray(raw.capabilities, `${label}.capabilities`, 1);
  const unsupported = capabilities.filter(capability => !CODEX_CAPABILITIES.includes(capability));
  if (unsupported.length > 0) throw new ConfigError(`${label}.capabilities unsupported by codex: ${unsupported.join(', ')}`);
  const routingRaw = asObject(raw.routing, `${label}.routing`);
  rejectUnknownKeys(routingRaw, ['provider', 'model', 'profile', 'reasoning'], `${label}.routing`);
  const routing: GatewayRouting = { provider: requireNonEmptyString(routingRaw.provider, `${label}.routing.provider`), model: requireNonEmptyString(routingRaw.model, `${label}.routing.model`) };
  const profile = optionalNonEmptyString(routingRaw.profile, `${label}.routing.profile`);
  if (profile !== undefined) routing.profile = profile;
  const reasoning = optionalNonEmptyString(routingRaw.reasoning, `${label}.routing.reasoning`);
  if (reasoning !== undefined) routing.reasoning = reasoning;
  const branchPrefix = raw.branch_prefix === undefined ? 'agents-relay/' : requireNonEmptyString(raw.branch_prefix, `${label}.branch_prefix`);
  if (!branchPrefix.endsWith('/')) throw new ConfigError(`${label}.branch_prefix must end with "/"`);
  return {
    name,
    repository,
    localPath,
    baseBranch,
    adapter: 'codex',
    capabilities,
    routing,
    maxAttempts: intFrom(raw.max_attempts, `${label}.max_attempts`, 3),
    timeoutMs: intFrom(raw.timeout_ms, `${label}.timeout_ms`, 900000),
    maxConcurrent: intFrom(raw.max_concurrent, `${label}.max_concurrent`, 1),
    trustedAuthors: requireStringArray(raw.trusted_authors, `${label}.trusted_authors`, 1),
    label: raw.label === undefined ? 'agents-relay' : requireNonEmptyString(raw.label, `${label}.label`),
    branchPrefix,
    dashboardUrl: optionalHttpsUrl(raw.dashboard_url, `${label}.dashboard_url`),
  };
}

export function loadGatewayConfig(env: Environment, argv: readonly string[] = []): GatewayConfig {
  const path = env.AGENTS_RELAY_GATEWAY_CONFIG ?? arg(argv, '--config');
  if (!path) throw new ConfigError('AGENTS_RELAY_GATEWAY_CONFIG (or --config) is required');
  const token = env.AGENTS_RELAY_GATEWAY_TOKEN ?? '';
  if (token.length < 32) throw new ConfigError('AGENTS_RELAY_GATEWAY_TOKEN must be at least 32 characters');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new ConfigError(`Unable to read gateway config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = asObject(parsed, 'config');
  rejectUnknownKeys(raw, ['public_base_url', 'max_active_jobs', 'create_timeout_ms', 'idle_ttl_ms', 'watchdog_ms', 'projects'], 'config');
  if (!Array.isArray(raw.projects) || raw.projects.length === 0) throw new ConfigError('config.projects must be a non-empty array');
  const projects = raw.projects.map((value, index) => parseProject(value, `projects[${index}]`));
  const seen = new Set<string>();
  for (const project of projects) {
    if (seen.has(project.name)) throw new ConfigError(`Duplicate project name: ${project.name}`);
    seen.add(project.name);
  }
  return {
    token,
    bind: env.AGENTS_RELAY_GATEWAY_BIND ?? arg(argv, '--bind') ?? GATEWAY_DEFAULTS.bind,
    port: intFrom(env.AGENTS_RELAY_GATEWAY_PORT ?? arg(argv, '--port'), 'port', GATEWAY_DEFAULTS.port),
    maxBodyBytes: intFrom(env.AGENTS_RELAY_GATEWAY_MAX_BODY_BYTES ?? arg(argv, '--max-body-bytes'), 'max_body_bytes', GATEWAY_DEFAULTS.maxBodyBytes),
    maxActiveJobs: intFrom(raw.max_active_jobs ?? arg(argv, '--max-active-jobs'), 'max_active_jobs', GATEWAY_DEFAULTS.maxActiveJobs),
    createTimeoutMs: intFrom(raw.create_timeout_ms ?? arg(argv, '--create-timeout-ms'), 'create_timeout_ms', GATEWAY_DEFAULTS.createTimeoutMs),
    idleTtlMs: intFrom(raw.idle_ttl_ms ?? arg(argv, '--idle-ttl-ms'), 'idle_ttl_ms', GATEWAY_DEFAULTS.idleTtlMs),
    watchdogMs: intFrom(raw.watchdog_ms ?? arg(argv, '--interval'), 'watchdog_ms', GATEWAY_DEFAULTS.watchdogMs),
    publicBaseUrl: optionalHttpsUrl(raw.public_base_url ?? env.AGENTS_RELAY_GATEWAY_PUBLIC_BASE_URL, 'public_base_url'),
    codexCommand: arg(argv, '--codex') ?? GATEWAY_DEFAULTS.codexCommand,
    events: {
      enabled: arg(argv, '--events') === 'nats',
      natsUrl: arg(argv, '--nats-url') ?? GATEWAY_DEFAULTS.natsUrl,
      subjectPrefix: arg(argv, '--subject-prefix') ?? GATEWAY_DEFAULTS.subjectPrefix,
    },
    projects,
  };
}

export function findProject(config: GatewayConfig, name: string): GatewayProject | undefined {
  return config.projects.find(project => project.name === name);
}

export function projectForJobId(config: GatewayConfig, jobId: string): GatewayProject | undefined {
  return config.projects
    .filter(project => jobId.startsWith(`${project.name}-`))
    .sort((left, right) => right.name.length - left.name.length)[0];
}
