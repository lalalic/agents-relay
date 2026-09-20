import { access, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type ContextSource = 'project' | 'neo' | 'global';
export type ExecutionRole = 'planner' | 'reviewer' | 'worker' | 'nested-worker';

export type ResolvedSkill = { name: string; path: string; source: ContextSource; description?: string };
export type ResolvedAgent = {
  name: string;
  path: string;
  capabilities: string[];
  source: ContextSource;
  trust?: string[];
  runtime?: string;
  delegation?: { allowed: boolean; mechanism: 'agents-relay-child-task' };
};
export type ResolvedRuntime = { name: string; path?: string; capabilities: string[]; source: string };
export type ExecutionContext = {
  project: { path: string; gitRoot?: string };
  role: ExecutionRole;
  instructions: string;
  instructionFiles: string[];
  skills: ResolvedSkill[];
  agents: ResolvedAgent[];
  runtimes: ResolvedRuntime[];
  delegation: { allowed: boolean; mechanism: 'agents-relay-child-task'; parentTaskId?: string | null };
};

export type ExecutionContextOptions = {
  neoRoot?: string;
  neoSkillsRoot?: string;
  globalSkillsRoot?: string;
  globalAgentsRoot?: string;
  projectAgentsRoot?: string;
  projectSkillsRoot?: string;
  runtimeCapabilities?: readonly ResolvedRuntime[];
  parentTaskId?: string | null;
};

function configuredPath(value: string | undefined): string | undefined {
  return value ? resolve(value.replace(/^~/, homedir())) : undefined;
}
async function existing(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}
function sourceFor(layer: number): ContextSource { return layer === 0 ? 'project' : layer === 1 ? 'neo' : 'global'; }
function frontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---', 4);
  if (end < 0) return {};
  const result: Record<string, string> = {};
  for (const line of text.slice(4, end).split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) result[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return result;
}
function listValue(value: string | undefined): string[] {
  return (value ?? '').split(',').map(item => item.trim()).filter(Boolean);
}
async function filesIn(directory: string, suffix: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith(suffix))
      .map(entry => join(directory, entry.name));
  } catch { return []; }
}
async function skillFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const candidates = entries.filter(entry => entry.isDirectory()).map(entry => join(root, entry.name, 'SKILL.md'));
    return (await Promise.all(candidates.map(async path => (await existing(path)) ? path : undefined))).filter((path): path is string => Boolean(path));
  } catch { return []; }
}
async function agentFiles(root: string): Promise<string[]> {
  const direct = await filesIn(join(root, 'agents'), '.agent.md');
  const skills = await skillFiles(root);
  const nested = (await Promise.all(skills.map(path => filesIn(join(dirname(path), 'agents'), '.agent.md')))).flat();
  return [...direct, ...nested];
}
function chooseByName<T extends { name: string }>(items: T[], explicit: readonly string[] | undefined, kind: string): T[] {
  if (!explicit?.length) return items;
  const byName = new Map(items.map(item => [item.name.toLowerCase(), item]));
  return explicit.map(name => {
    const value = byName.get(name.toLowerCase());
    if (!value) throw new Error(`Requested ${kind} '${name}' is not visible in the execution context`);
    return value;
  });
}

export async function resolveExecutionContext(
  projectPath: string,
  role: ExecutionRole,
  explicitSkills?: readonly string[],
  explicitAgents?: readonly string[],
  options: ExecutionContextOptions = {},
): Promise<ExecutionContext> {
  const project = resolve(configuredPath(projectPath) ?? projectPath);
  if (!(await existing(project))) throw new Error(`Project path does not exist: ${project}`);
  const neoRoot = configuredPath(options.neoRoot ?? process.env.AGENTS_RELAY_NEO_ROOT ?? process.env.NEO_ROOT);
  const neoSkills = configuredPath(options.neoSkillsRoot ?? process.env.AGENTS_RELAY_NEO_SKILLS ?? (neoRoot ? join(neoRoot, 'skills') : undefined));
  const globalSkills = configuredPath(options.globalSkillsRoot ?? process.env.AGENTS_RELAY_GLOBAL_SKILLS) ?? join(homedir(), '.agents', 'skills');
  const globalAgents = configuredPath(options.globalAgentsRoot ?? process.env.AGENTS_RELAY_GLOBAL_AGENTS) ?? join(homedir(), '.agents', 'agents');
  const layers: Array<{ root: string; source: ContextSource }> = [
    { root: configuredPath(options.projectSkillsRoot ?? join(project, 'skills')) ?? join(project, 'skills'), source: 'project' },
    ...(neoSkills ? [{ root: neoSkills, source: 'neo' as const }] : []),
    { root: globalSkills, source: 'global' },
  ];
  const skills: ResolvedSkill[] = [];
  for (const [index, layer] of layers.entries()) {
    for (const path of await skillFiles(layer.root)) {
      const meta = frontmatter(await readFile(path, 'utf8'));
      const name = meta.name || dirname(path).split('/').at(-1) || path;
      if (!skills.some(item => item.name.toLowerCase() === name.toLowerCase())) skills.push({ name, path, source: sourceFor(index), ...(meta.description ? { description: meta.description } : {}) });
    }
  }
  const agentLayers: Array<{ root: string; source: ContextSource }> = [
    { root: project, source: 'project' },
    ...(neoRoot ? [{ root: neoRoot, source: 'neo' as const }] : []),
    { root: dirname(globalAgents), source: 'global' },
  ];
  const agents: ResolvedAgent[] = [];
  for (const layer of agentLayers) {
    const paths = layer.source === 'global' ? await filesIn(globalAgents, '.agent.md') : await agentFiles(layer.root);
    for (const path of paths) {
      const text = await readFile(path, 'utf8');
      const meta = frontmatter(text);
      const name = meta.name || path.split('/').at(-1)?.replace(/\.agent\.md$/, '') || path;
      if (!agents.some(item => item.name.toLowerCase() === name.toLowerCase())) agents.push({ name, path, source: layer.source, capabilities: listValue(meta.capabilities), ...(meta.runtime ? { runtime: meta.runtime } : {}), ...(meta.trust ? { trust: listValue(meta.trust) } : {}), delegation: { allowed: true, mechanism: 'agents-relay-child-task' } });
    }
  }
  const instructionFiles: string[] = [];
  const globalInstruction = join(homedir(), '.agents', 'AGENTS.md');
  if (await existing(globalInstruction)) instructionFiles.push(globalInstruction);
  if (neoRoot) for (const name of ['AGENTS.md', 'README.md']) if (await existing(join(neoRoot, name))) instructionFiles.push(join(neoRoot, name));
  const chain: string[] = [];
  let current = project;
  while (true) { chain.unshift(current); const parent = dirname(current); if (parent === current) break; current = parent; }
  for (const directory of chain) if (await existing(join(directory, 'AGENTS.md'))) instructionFiles.push(join(directory, 'AGENTS.md'));
  if (await existing(join(project, 'README.md'))) instructionFiles.push(join(project, 'README.md'));
  const instructions = (await Promise.all(instructionFiles.map(async path => `\n## ${path}\n\n${await readFile(path, 'utf8')}`))).join('\n');
  const runtimeCapabilities = options.runtimeCapabilities ? [...options.runtimeCapabilities] : [];
  const browserSkill = skills.find(skill => skill.name.toLowerCase() === 'chatgpt-browser-worker');
  if (browserSkill && !runtimeCapabilities.some(runtime => runtime.name === 'chatgpt-browser-worker')) runtimeCapabilities.push({ name: 'chatgpt-browser-worker', path: dirname(browserSkill.path), capabilities: ['chatgpt', 'browser-harness'], source: browserSkill.source });
  return {
    project: { path: project }, role, instructions, instructionFiles,
    skills: chooseByName(skills, explicitSkills, 'skill'), agents: chooseByName(agents, explicitAgents, 'agent'), runtimes: runtimeCapabilities,
    delegation: { allowed: true, mechanism: 'agents-relay-child-task', ...(options.parentTaskId !== undefined ? { parentTaskId: options.parentTaskId } : {}) },
  };
}
