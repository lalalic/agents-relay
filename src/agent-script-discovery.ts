import {realpath,stat} from 'node:fs/promises';
import {dirname,basename,join} from 'node:path';
import {homedir} from 'node:os';
import {agentSourceLayers,resolveAgentMarkdown} from './agent-content-resolver.js';
import {BUNDLED_AGENTS_ROOT} from './execution-context.js';

/** Resolve a local Script Agent using the same Agent inheritance/source rules
 * as the regular Model Task executor. This is not a Shortcut Job runner. */
export async function discoverScriptAgent(agent: string, projectPath: string, sharedRoot?: string, workspaceRoot?: string, globalRoot?: string): Promise<string | null> {
  let sources: string[];
  try {
    ({ sources } = await resolveAgentMarkdown(agent, BUNDLED_AGENTS_ROOT, projectPath, sharedRoot,
      agentSourceLayers(projectPath, { sharedRoot, workspaceRoot, globalRoot: globalRoot ?? process.env.AGENTS_HOME ?? join(homedir(), '.agents') })));
  } catch (error) {
    if (error instanceof Error && error.message === `Unknown agent ${agent}`) return null;
    throw error;
  }
  for (const source of [...sources].reverse()) {
    const agentDir = dirname(source);
    const name = basename(source).replace(/(?:\.agent)?\.md$/, '');
    const shortcutDir = join(agentDir, '.shortcut');
    let shortcutRoot: string;
    try { shortcutRoot = await realpath(shortcutDir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (shortcutRoot !== shortcutDir) throw new Error(`Agent Script directory symlink escapes Agent source: ${shortcutDir}`);
    const candidate = join(shortcutDir, `${name}.agent.mjs`);
    let actual: string;
    try { actual = await realpath(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (dirname(actual) !== shortcutRoot) throw new Error(`Agent Script symlink escapes source directory: ${candidate}`);
    if (!(await stat(actual)).isFile()) throw new Error(`Agent Script is not a regular file: ${candidate}`);
    return actual;
  }
  return null;
}

export async function missingScriptAgents(graph: string, projectPath:string, sharedRoot?:string,workspaceRoot?:string,globalRoot?:string):Promise<string[]>{
 const {parseAgentGraph}=await import('./agent-graph.js');
 const nodes=parseAgentGraph(graph).nodes;
 const choices=await Promise.all(nodes.map(async n=>({id:n.id,path:await discoverScriptAgent(n.agent,projectPath,sharedRoot,workspaceRoot,globalRoot)})));
 return choices.filter(n=>!n.path).map(n=>n.id);
}
