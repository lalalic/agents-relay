import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export type AgentMergeMode = 'extend' | 'replace';
export type EffectiveAgentContent = { content: string; hash: string; sources: string[]; metadata: Record<string, string | undefined> };
const parseList = (raw: string): string[] => raw.trim().replace(/^\[/, '').replace(/\]$/, '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);

/** Restrict the frontmatter grammar to the explicitly supported scalar/list fields. */
function parseDocument(raw: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { body: raw.trim(), name: undefined as string | undefined, extendsAgent: undefined as string | undefined, mode: undefined as AgentMergeMode | undefined, replace: [] as string[], extend: [] as string[] };
  const lines = match[1].split(/\r?\n/);
  let name: string | undefined, extendsAgent: string | undefined, mode: AgentMergeMode | undefined;
  const sections: Record<string, string[]> = { replace: [], extend: [] };
  let inSections = false;
  for (const line of lines) {
    const field = /^(name|extends|mode|sections):\s*(.*)$/.exec(line);
    if (field) {
      inSections = field[1] === 'sections';
      if (field[1] === 'name') name = field[2].trim();
      if (field[1] === 'extends') extendsAgent = field[2].trim();
      if (field[1] === 'mode') { if (!['extend','replace'].includes(field[2].trim())) throw new Error(`Invalid agent mode: ${field[2]}`); mode = field[2].trim() as AgentMergeMode; }
    } else if (inSections) {
      const entry = /^  (replace|extend):\s*(.+)$/.exec(line);
      if (entry) sections[entry[1]] = parseList(entry[2]);
      else if (/^\S/.test(line)) inSections = false;
    }
  }
  return { body: raw.slice(match[0].length).trim(), name, extendsAgent, mode, replace: sections.replace, extend: sections.extend };
}

type Section = { path: string; start: number; end: number; level: number };
function indexSections(lines: string[]): Map<string, Section> {
  const sections = new Map<string, Section>();
  const stack: Array<{ title: string; level: number }> = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (!heading) continue;
    const level = heading[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const path = [...stack.map(x => x.title), heading[2].trim()].join('/');
    if (sections.has(path)) throw new Error(`Ambiguous Markdown section ${path}`);
    for (const section of sections.values()) if (section.end === lines.length && section.level >= level) section.end = i;
    sections.set(path, { path, start: i, end: lines.length, level });
    stack.push({ title: heading[2].trim(), level });
  }
  return sections;
}

function mergeSections(base: string, child: ReturnType<typeof parseDocument>): string {
  if (child.mode === 'replace') {
    if (child.replace.length || child.extend.length) throw new Error('Whole-agent replace cannot contain sections overrides');
    return child.body;
  }
  const operations = [...child.replace.map(path => ({path,mode:'replace'})), ...child.extend.map(path => ({path,mode:'extend'}))];
  const seen = new Set<string>();
  for (const op of operations) { if (seen.has(op.path)) throw new Error(`Conflicting section operation: ${op.path}`); seen.add(op.path); }
  if (!operations.length) return `${base.trim()}\n\n${child.body}`.trim();
  let result = base;
  for (const op of operations) {
    const originalLines = result.split('\n');
    const childLines = child.body.split('\n');
    const target = indexSections(originalLines).get(op.path);
    const source = indexSections(childLines).get(op.path);
    if (!target || !source) throw new Error(`Section ${op.path} missing in ${!target ? 'base' : 'overlay'} contract`);
    const subsection = childLines.slice(source.start, source.end);
    if (op.mode === 'replace') originalLines.splice(target.start, target.end-target.start, ...subsection);
    else originalLines.splice(target.end, 0, ...subsection.slice(1));
    result = originalLines.join('\n');
  }
  return result.trim();
}

/** Resolve the visible agent through Relay, Neo shared, then project-local layers. */
export async function resolveAgentMarkdown(name: string, builtinsRoot: string, contextRoot: string, neoRoot?: string | null): Promise<EffectiveAgentContent> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid agent name ${name}`);
  const load = async (path: string, root: string) => {
    const canonical = await realpath(path);
    const canonicalRoot = await realpath(root);
    if (!(canonical === canonicalRoot || canonical.startsWith(canonicalRoot + '/'))) throw new Error('Agent file escapes context root');
    const raw = await readFile(canonical, 'utf8');
    const source = parseDocument(raw);
    if (source.name && source.name !== name) throw new Error(`Agent name mismatch ${source.name} != ${name}`);
    return { ...source, path: canonical, metadata: Object.fromEntries(raw.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1].split(/\r?\n/).flatMap(line => {
      const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      return field ? [[field[1], field[2].trim().replace(/^['"]|['"]$/g, '')]] : [];
    }) ?? []) };
  };
  type Loaded = ReturnType<typeof parseDocument> & { path: string; metadata: Record<string, string | undefined> };
  const loadLayer = async (root: string): Promise<Loaded> => {
    for (const suffix of ['.agent.md', '.md']) {
      try { return await load(join(root, `${name}${suffix}`), root); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    throw Object.assign(new Error('Agent file not found'), { code: 'ENOENT' });
  };
  let base: Loaded | undefined;
  try { base = await loadLayer(builtinsRoot); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  let effective = base;
  let shared: Loaded | undefined;
  let sharedSources: string[] = [];
  let sources = base ? [base.path] : [];
  let metadata = { ...(base?.metadata ?? {}) };
  for (const [layer, root] of [['neo', neoRoot], ['project', contextRoot]] as const) {
    if (!root) continue;
    let overlay: Loaded | undefined;
    try { overlay = await loadLayer(join(root, 'agents')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (!overlay) continue;
    const hasOperations = overlay.replace.length || overlay.extend.length;
    if (hasOperations && !overlay.extendsAgent) throw new Error('Section operations require extends');
    if (overlay.extendsAgent && ![`relay/${name}`, `neo/${name}`].includes(overlay.extendsAgent)) throw new Error(`Only extends: relay/${name} or neo/${name} is supported`);
    if (layer === 'neo' && overlay.extendsAgent === `neo/${name}`) throw new Error(`Missing Neo base for agent ${name}`);
    if (overlay.extendsAgent === `relay/${name}` && !base) throw new Error(`Missing Relay base for agent ${name}`);
    if (overlay.extendsAgent === `neo/${name}` && !shared) throw new Error(`Missing Neo base for agent ${name}`);
    if (!overlay.extendsAgent) {
      effective = overlay;
      metadata = {};
      sources = [overlay.path];
    } else {
      const parent = overlay.extendsAgent === `relay/${name}` ? base : overlay.extendsAgent === `neo/${name}` ? shared : effective;
      effective = { ...overlay, body: mergeSections(parent!.body, overlay) };
      metadata = { ...parent!.metadata };
      sources = [...(overlay.extendsAgent === `relay/${name}` ? [base!.path] : overlay.extendsAgent === `neo/${name}` ? sharedSources : sources), overlay.path];
    }
    Object.assign(metadata, overlay.metadata);
    if (layer === 'neo') { shared = effective; sharedSources = [...sources]; }
  }
  if (!effective) throw new Error(`Unknown agent ${name}`);
  const content = effective.body;
  return {content, metadata, sources, hash:createHash('sha256').update(content).digest('hex')};
}
