import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, relative, sep } from 'node:path';

export type AgentMergeMode = 'extend' | 'replace';
export type EffectiveAgentContent = { content: string; hash: string; sources: string[]; metadata: Record<string, string | undefined> };
export type AgentSourceLayer = { root: string; source: 'global' | 'parent' | 'project' };

/** Agent names resolve through the caller's configured workspace, including
 * project worktrees outside its physical directory. No separate shared root. */
export function agentSourceLayers(projectPath: string, options: {
  globalRoot?: string; workspaceRoot?: string;
} = {}): AgentSourceLayer[] {
  const project = resolve(projectPath);
  const layers: AgentSourceLayer[] = [];
  if (options.globalRoot) layers.push({root: resolve(options.globalRoot), source: 'global'});
  if (options.workspaceRoot) {
    const workspace = resolve(options.workspaceRoot);
    if (workspace !== project) layers.push({root: workspace, source: 'parent'});
    const rel = relative(workspace, project);
    if (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)) {
      let cursor = workspace;
      for (const part of rel.split(sep).filter(Boolean).slice(0, -1)) {
        cursor = join(cursor, part);
        if (cursor !== project) layers.push({root: cursor, source: 'parent'});
      }
    }
  }
  layers.push({root: project, source: 'project'});
  return layers.filter((layer, i) => layers.findIndex(other => other.root === layer.root) === i);
}

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
      if (field[1] === 'extends') extendsAgent = field[2].trim().replace(/^[\'"]|[\'"]$/g, '');
      if (field[1] === 'mode') { if (!['extend','replace'].includes(field[2].trim())) throw new Error(`Invalid agent mode: ${field[2]}`); mode = field[2].trim() as AgentMergeMode; }
    } else if (inSections) {
      const entry = /^  (replace|extend):\s*(.+)$/.exec(line);
      if (entry) sections[entry[1]] = parseList(entry[2]);
      else if (/^\S/.test(line)) inSections = false;
    }
  }
  return { body: raw.slice(match[0].length).trim(), name, extendsAgent, mode, replace: sections.replace, extend: sections.extend };
}

/** A cached merged Agent has no useful directory for source-relative links.
 * Canonicalize link destinations in each layer BEFORE merging, preserving the
 * real source file's link base without inlining the linked document. */
function absoluteAgentLinks(body: string, sourcePath: string): string {
  let fence: string | undefined;
  return body.split('\n').map(line => {
    const open = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (open) { if (!fence) fence = open[0]; else if (fence === open[0]) fence = undefined; return line; }
    if (fence) return line;
    return line.replace(/(\]\()([^\s)]+)(\))/g, (full, prefix: string, destination: string, suffix: string) => {
      if (destination.startsWith('/') || destination.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(destination)) return full;
      const hash = destination.search(/[?#]/);
      const pathname = hash === -1 ? destination : destination.slice(0, hash);
      const fragment = hash === -1 ? '' : destination.slice(hash);
      return `${prefix}${resolve(dirname(sourcePath),pathname)}${fragment}${suffix}`;
    });
  }).join('\n');
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

/** Resolve the visible agent through Relay, shared, then project-local layers. */
export async function resolveAgentMarkdown(
  name: string, builtinsRoot: string, contextRoot: string,
  layers: readonly AgentSourceLayer[] = agentSourceLayers(contextRoot),
): Promise<EffectiveAgentContent> {
  type Loaded = ReturnType<typeof parseDocument> & { path: string; metadata: Record<string, string | undefined> };
  const load = async (path: string, root: string, expectedName?: string): Promise<Loaded> => {
    const canonical = await realpath(path);
    const canonicalRoot = await realpath(root);
    if (!(canonical === canonicalRoot || canonical.startsWith(canonicalRoot + sep)))
      throw new Error('Agent file escapes context root');
    const raw = await readFile(canonical, 'utf8');
    const source = parseDocument(raw);
    source.body = absoluteAgentLinks(source.body, canonical);
    if (expectedName && source.name && source.name !== expectedName)
      throw new Error(`Agent name mismatch ${source.name} != ${expectedName}`);
    return { ...source, path: canonical, metadata: Object.fromEntries(raw.match(/^---\r?\n([\s\S]*?)\r?\n---/m)?.[1].split(/\r?\n/).flatMap(line => {
      const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      return field ? [[field[1], field[2].trim().replace(/^[\'\"]|[\'\"]$/g, '')]] : [];
    }) ?? []) };
  };
  const loadLayer = async (agent: string, root: string): Promise<Loaded> => {
    for (const suffix of ['.agent.md', '.md']) {
      try { return await load(join(root, `${agent}${suffix}`), root, agent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    throw Object.assign(new Error('Agent file not found'), {code: 'ENOENT'});
  };
  const namePattern = /^[a-zA-Z0-9_-]+$/;
  const resolveName = async (agent: string, stack: readonly string[]): Promise<EffectiveAgentContent> => {
    if (!namePattern.test(agent)) throw new Error(`Invalid agent name ${agent}`);
    if (stack.includes(agent)) throw new Error(`Agent extends cycle: ${[...stack,agent].join(' -> ')}`);
    const ancestors = [...stack,agent];
    let effective: Loaded | undefined;
    let sources: string[] = [];
    let metadata: Record<string, string | undefined> = {};
    try { effective = await loadLayer(agent, builtinsRoot); sources = [effective.path]; metadata = {...effective.metadata}; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const {root} of layers) {
      let overlay: Loaded;
      try { overlay = await loadLayer(agent, join(root, 'agents')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if ((overlay.replace.length || overlay.extend.length) && !overlay.extendsAgent)
        throw new Error('Section operations require extends');
      if (!overlay.extendsAgent) {
        effective = overlay;
        metadata = {...overlay.metadata};
        sources = [overlay.path];
        continue;
      }
      const parentName = overlay.extendsAgent;
      let parentBody: string;
      let parentMetadata: Record<string, string | undefined>;
      let parentSources: string[];
      if (isAbsolute(parentName)) {
        if (!parentName.endsWith('.md')) throw new Error('Absolute Agent base must be a Markdown file');
        const external = await load(parentName, dirname(parentName));
        if (!external.name || !external.body) throw new Error('Absolute Agent base requires name frontmatter and nonempty body');
        if (external.extendsAgent) throw new Error('Absolute Agent base must be a standalone definition');
        parentBody = external.body;
        parentMetadata = external.metadata;
        parentSources = [external.path];
      } else if (namePattern.test(parentName)) {
        if (parentName === agent) {
          if (!effective) throw new Error(`Missing base for agent ${agent}`);
          parentBody = effective.body;
          parentMetadata = metadata;
          parentSources = sources;
        } else {
          let resolved: EffectiveAgentContent;
          try { resolved = await resolveName(parentName, ancestors); }
          catch (error) {
            if (error instanceof Error && error.message === `Unknown agent ${parentName}`)
              throw new Error(`Missing base agent ${parentName} for ${agent}`);
            throw error;
          }
          parentBody = resolved.content;
          parentMetadata = resolved.metadata;
          parentSources = resolved.sources;
        }
      } else {
        throw new Error(`Only extends: Agent name or absolute Markdown path is supported: ${parentName}`);
      }
      effective = {...overlay, body: mergeSections(parentBody, overlay)};
      metadata = {...parentMetadata, ...overlay.metadata};
      sources = [...parentSources, overlay.path];
    }
    if (!effective) throw new Error(`Unknown agent ${agent}`);
    return {content: effective.body, metadata, sources, hash: createHash('sha256').update(effective.body).digest('hex')};
  };
  return resolveName(name, []);
}
