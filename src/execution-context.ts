import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRegistration } from './types.js';

export type ExecutionRole = 'orchestrator' | 'planner' | 'reviewer' | 'troubleshooter' | 'worker' | 'nested-worker';
export type ContextSource = 'project' | 'neo' | 'global' | 'builtin' | 'registry' | 'runtime';

export type ResolvedInstruction = { path: string; source: Exclude<ContextSource, 'builtin' | 'registry' | 'runtime'> };
export type ResolvedSkill = { name: string; path: string; source: Exclude<ContextSource, 'builtin' | 'registry' | 'runtime'>; description?: string };
export type ResolvedAgent = {
  name: string;
  path?: string;
  source: Exclude<ContextSource, 'runtime'>;
  description?: string;
  capabilities: string[];
  runtime?: string;
  trustDomains: string[];
  delegation: string[];
  restrictions: string[];
  registration?: AgentRegistration;
};
export type ResolvedRuntime = { name: string; id?: string; capabilities: string[]; source: 'runtime' };
export type ExecutionContext = {
  project: { name: string; path: string; workspaceRoot: string; neoRoot: string | null; globalRoot: string };
  role: ExecutionRole;
  instructions: ResolvedInstruction[];
  skills: ResolvedSkill[];
  agents: ResolvedAgent[];
  runtimes: ResolvedRuntime[];
  delegation: { mode: 'relay-child-task'; parentTaskIdRequired: boolean };
};

export type ExecutionContextRoots = { workspaceRoot?: string; neoRoot?: string | null; globalRoot?: string };

export type ExecutionContextOptions = ExecutionContextRoots & {
  explicitSkills?: readonly string[];
  explicitAgents?: readonly string[];
  registeredAgents?: readonly AgentRegistration[];
  runtimes?: readonly { name?: string; adapter?: string; id?: string; capabilities: readonly string[] }[];
};

type Frontmatter = Record<string, string>;
const BUNDLED_AGENTS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'agents-relay', 'agents');

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}
function isWithin(path: string, root: string): boolean {
  const value = relative(root, path);
  return value === '' || (!value.startsWith('..' + sep) && value !== '..' && !isAbsolute(value));
}
async function directory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}
function configuredWorkspaceRoot(projectPath: string, explicit?: string): string {
  const configured = explicit ?? process.env.AGENTS_RELAY_WORKSPACE_ROOT ?? process.env.XCHAT_WORKSPACE_ROOT;
  if (configured) return resolve(configured);
  const conventional = join(homedir(), 'Workspace');
  return isWithin(projectPath, conventional) ? conventional : dirname(projectPath);
}
async function configuredNeoRoot(workspaceRoot: string, explicit?: string | null): Promise<string | null> {
  if (explicit === null) return null;
  const configured = explicit ?? process.env.NEO_SHARED_ROOT;
  if (configured) return await directory(resolve(configured)) ? await realpath(resolve(configured)) : null;
  const candidate = join(workspaceRoot, 'neo');
  return await directory(candidate) ? await realpath(candidate) : null;
}
function configuredGlobalRoot(explicit?: string): string {
  return resolve(explicit ?? process.env.AGENTS_HOME ?? join(homedir(), '.agents'));
}

function parseFrontmatter(content: string): Frontmatter {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---', 4);
  if (end < 0) return {};
  const result: Frontmatter = {};
  for (const line of content.slice(4, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return result;
}
function listValue(value?: string): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  const body = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return body.split(/[|,]/).map(item => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
async function metadata(path: string): Promise<{ fields: Frontmatter; content: string }> {
  const content = await readFile(path, 'utf8');
  return { fields: parseFrontmatter(content), content };
}

async function instructionPaths(projectPath: string, workspaceRoot: string, neoRoot: string | null, globalRoot: string): Promise<ResolvedInstruction[]> {
  const found: ResolvedInstruction[] = [];
  const add = async (path: string, source: ResolvedInstruction['source']): Promise<void> => {
    if (await exists(path)) { const concrete = await realpath(path); if (!found.some(item => item.path === concrete)) found.push({ path: concrete, source }); }
  };
  await add(join(globalRoot, 'AGENTS.md'), 'global');
  if (isWithin(projectPath, workspaceRoot)) {
    const segments = relative(workspaceRoot, projectPath).split(sep).filter(Boolean);
    let cursor = workspaceRoot;
    await add(join(cursor, 'AGENTS.md'), neoRoot && isWithin(cursor, neoRoot) ? 'neo' : 'project');
    for (const segment of segments) {
      cursor = join(cursor, segment);
      const source: ResolvedInstruction['source'] = neoRoot && isWithin(cursor, neoRoot) && !isWithin(cursor, projectPath) ? 'neo' : 'project';
      await add(join(cursor, 'AGENTS.md'), source);
    }
  } else {
    await add(join(projectPath, 'AGENTS.md'), 'project');
  }
  await add(join(projectPath, 'README.md'), 'project');
  return found;
}

async function skillLayer(root: string, source: ResolvedSkill['source']): Promise<ResolvedSkill[]> {
  const skillsRoot = join(root, 'skills');
  let entries;
  try { entries = await readdir(skillsRoot, { withFileTypes: true }); } catch { return []; }
  const result: ResolvedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(skillsRoot, entry.name, 'SKILL.md');
    if (!await exists(path)) continue;
    const { fields } = await metadata(path);
    result.push({ name: fields.name || entry.name, path: await realpath(path), source, description: fields.description || undefined });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

async function agentFiles(root: string, source: ResolvedAgent['source'], skills: readonly ResolvedSkill[]): Promise<ResolvedAgent[]> {
  const candidates: string[] = [];
  const skillDirs = skills.filter(skill => skill.source === source).map(skill => dirname(skill.path));
  for (const skillDir of skillDirs) {
    let entries;
    try { entries = await readdir(join(skillDir, 'agents'), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.md')) candidates.push(join(skillDir, 'agents', entry.name));
  }
  let direct: Dirent[];
  try { direct = await readdir(join(root, 'agents'), { withFileTypes: true }); } catch { direct = []; }
  for (const entry of direct) if (entry.isFile() && entry.name.endsWith('.md')) candidates.push(join(root, 'agents', entry.name));

  const result: ResolvedAgent[] = [];
  for (const path of candidates) {
    const { fields } = await metadata(path);
    result.push({
      name: fields.name || basename(path).replace(/\.agent\.md$/i, '').replace(/\.md$/i, ''),
      path: await realpath(path),
      source,
      description: fields.description || undefined,
      capabilities: listValue(fields.capabilities),
      runtime: fields.runtime || listValue(fields.runtimes)[0] || undefined,
      trustDomains: listValue(fields.trustDomains ?? fields.trust_domains ?? fields.trust),
      delegation: listValue(fields.delegation),
      restrictions: listValue(fields.restrictions ?? fields.boundaries),
    });
  }
  return result;
}

function selectByName<T extends { name: string }>(items: readonly T[], explicit: readonly string[] | undefined, kind: string): T[] {
  if (!explicit?.length) return [...items];
  const selected = explicit.map(name => {
    const item = items.find(candidate => candidate.name === name);
    if (!item) throw new Error(`Explicit ${kind} ${name} is not visible in the resolved execution context`);
    return item;
  });
  return selected;
}

export async function resolveExecutionContext(projectPath: string, role: ExecutionRole, options: ExecutionContextOptions = {}): Promise<ExecutionContext> {
  if (!projectPath) throw new Error('projectPath is required');
  const project = await realpath(resolve(projectPath)).catch(() => { throw new Error(`Project path not found: ${projectPath}`); });
  if (!await directory(project)) throw new Error(`Project path is not a directory: ${projectPath}`);
  const workspaceCandidate = configuredWorkspaceRoot(project, options.workspaceRoot);
  const workspaceRoot = await realpath(workspaceCandidate).catch(() => workspaceCandidate);
  const neoRoot = await configuredNeoRoot(workspaceRoot, options.neoRoot);
  const globalCandidate = configuredGlobalRoot(options.globalRoot);
  const globalRoot = await realpath(globalCandidate).catch(() => globalCandidate);

  const layerRoots: Array<{ root: string; source: ResolvedSkill['source'] }> = [
    { root: globalRoot, source: 'global' },
    ...(neoRoot ? [{ root: neoRoot, source: 'neo' as const }] : []),
    { root: project, source: 'project' },
  ];
  const uniqueLayers = layerRoots.filter((layer, index, list) => list.findIndex(item => resolve(item.root) === resolve(layer.root)) === index);

  const skillMap = new Map<string, ResolvedSkill>();
  const skillsByLayer = new Map<string, ResolvedSkill[]>();
  for (const layer of uniqueLayers) {
    const layerSkills = await skillLayer(layer.root, layer.source);
    skillsByLayer.set(layer.root, layerSkills);
    for (const skill of layerSkills) skillMap.set(skill.name, skill);
  }
  const skills = selectByName([...skillMap.values()].sort((a, b) => a.name.localeCompare(b.name)), options.explicitSkills, 'skill');

  const agentMap = new Map<string, ResolvedAgent>();
  for (const agent of await agentFiles(dirname(BUNDLED_AGENTS_ROOT), 'builtin', [])) agentMap.set(agent.name, agent);
  for (const layer of uniqueLayers) {
    for (const agent of await agentFiles(layer.root, layer.source, skillsByLayer.get(layer.root) ?? [])) agentMap.set(agent.name, agent);
  }
  for (const registration of options.registeredAgents ?? []) {
    if (agentMap.has(registration.name)) continue;
    agentMap.set(registration.name, {
      name: registration.name,
      source: 'registry',
      description: registration.responsibility,
      capabilities: [...registration.capabilities],
      runtime: registration.runtime.adapter,
      trustDomains: [...(registration.routing.trustDomains ?? [])],
      delegation: [],
      restrictions: [...registration.boundaries],
      registration,
    });
  }
  const agents = selectByName([...agentMap.values()].sort((a, b) => a.name.localeCompare(b.name)), options.explicitAgents, 'agent');

  return {
    project: { name: basename(project), path: project, workspaceRoot, neoRoot, globalRoot },
    role,
    instructions: await instructionPaths(project, workspaceRoot, neoRoot, globalRoot),
    skills,
    agents,
    runtimes: (options.runtimes ?? []).map(runtime => ({ name: runtime.name ?? runtime.adapter ?? 'unknown', id: runtime.id, capabilities: [...runtime.capabilities], source: 'runtime' })),
    delegation: { mode: 'relay-child-task', parentTaskIdRequired: role === 'nested-worker' },
  };
}

export async function resolveAgentContract(context: ExecutionContext, agentName: string): Promise<{ agent: ResolvedAgent; definition: string }> {
  const agent = context.agents.find(candidate => candidate.name === agentName);
  if (!agent) throw new Error(`Agent ${agentName} is not visible in the resolved execution context`);
  if (!agent.path) throw new Error(`Agent ${agentName} has no readable Markdown contract`);
  const definition = await readFile(agent.path, 'utf8');
  if (!definition.trim()) throw new Error(`Agent ${agentName} Markdown contract is empty`);
  return { agent, definition };
}

export async function agentContractPrompt(context: ExecutionContext, agentName: string): Promise<string> {
  const { agent, definition } = await resolveAgentContract(context, agentName);
  return `[Selected task agent contract]
Agent: ${agent.name}
Source: ${agent.path ?? agent.source}

The following Markdown is the authoritative behavioral contract for this Task agent.
Follow it in addition to the shared Job/Task and events-bus contracts. Worker/model routing
does not change the selected agent identity.

--- BEGIN AGENT CONTRACT ---
${definition.trim()}
--- END AGENT CONTRACT ---`;
}

export function executionContextPrompt(context: ExecutionContext): string {
  const instructions = context.instructions.map(item => `- ${item.path} [${item.source}]`).join('\n') || '- none';
  const skills = context.skills.map(item => `- ${item.name}: ${item.path} [${item.source}]`).join('\n') || '- none';
  const agents = context.agents.map(item => {
    const details = [
      item.description ? `purpose=${item.description}` : '',
      item.capabilities.length ? `capabilities=${item.capabilities.join(',')}` : '',
      item.runtime ? `runtime=${item.runtime}` : '',
      item.trustDomains.length ? `trust=${item.trustDomains.join(',')}` : '',
      item.restrictions.length ? `restrictions=${item.restrictions.join(' | ')}` : '',
    ].filter(Boolean).join('; ');
    return `- ${item.name}${item.path ? `: ${item.path}` : ''} [${item.source}]${details ? ` — ${details}` : ''}`;
  }).join('\n') || '- none';
  const runtimes = context.runtimes.map(item => `- ${item.name}${item.id ? ` (${item.id})` : ''}: ${item.capabilities.join(',')}`).join('\n') || '- none';
  return `[Resolved execution context]
Role: ${context.role}
Project path: ${context.project.path}

Instructions (read in listed order; later/project-local instructions override earlier shared defaults):
${instructions}

Visible skills (already de-duplicated with project-local > Neo shared > global precedence):
${skills}

Visible agents:
${agents}

Runtime capabilities:
${runtimes}

Delegation contract:
${context.role === 'troubleshooter' ? 'This is an orchestrator-side recovery role. Follow the selected Troubleshooter contract for P0/self-job repair authority and use durable Agents Relay Jobs/Tasks for delegated work.' : 'Nested work MUST be created as an Agents Relay durable child task with parentTaskId lineage. Do not directly spawn arbitrary child agents. Leaf workers do not inherit top-level XChat orchestration duties merely because xchat-orchestrator is visible.'}`;
}
