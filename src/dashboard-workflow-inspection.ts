/** Read-only code evidence for diagram symbols. Never controls a workflow transition. */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const KINDS = new Set(['Event', 'Guard', 'Action', 'State']);
export type WorkflowSymbolKind = 'Event' | 'Guard' | 'Action' | 'State';
export type WorkflowSourceReference = { path: string; line: number };
export type WorkflowSymbolInspection = {
  graph: WorkflowSourceReference;
  contracts: WorkflowSourceReference[];
  implementation: WorkflowSourceReference[];
  tests: WorkflowSourceReference[];
};

async function sourceFiles(relative: string): Promise<string[]> {
  const directory = join(ROOT, relative);
  let entries: import('node:fs').Dirent[];
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const paths: string[] = [];
  for (const entry of entries) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...await sourceFiles(child));
    else if (entry.isFile() && /\.(?:ts|js|mjs|md)$/.test(entry.name)) paths.push(child);
  }
  return paths;
}

function matches(content: string, symbol: string, path: string, limit: number): WorkflowSourceReference[] {
  const result: WorkflowSourceReference[] = [];
  for (const [index, line] of content.split('\n').entries()) {
    if (line.includes(symbol)) result.push({ path, line: index + 1 });
    if (result.length >= limit) break;
  }
  return result;
}

async function findReferences(paths: string[], symbol: string, max: number): Promise<WorkflowSourceReference[]> {
  const results: WorkflowSourceReference[] = [];
  for (const path of paths) {
    const content = await readFile(join(ROOT, path), 'utf8');
    results.push(...matches(content, symbol, path, max - results.length));
    if (results.length >= max) break;
  }
  return results;
}

export async function inspectWorkflowSymbol(graphId: string, kind: string, name: string): Promise<WorkflowSymbolInspection | null> {
  if (!NAME.test(graphId) || !NAME.test(name) || !KINDS.has(kind)) return null;
  const graphPath = `workflow/${graphId}.mmd`;
  let source: string;
  try { source = await readFile(join(ROOT, graphPath), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const prefix = kind === 'Event' ? 'on: ' : `${kind.toLowerCase()}: `;
  const matchingLine = source.split('\n').findIndex(line => line.includes(prefix + name) && !line.includes(prefix + name + '.'));
  if (matchingLine < 0) return null;
  const contracts = ['skills/agents-relay/contracts/event-contract.md', 'skills/agents-relay/contracts/task-recovery-flows.md'];
  const contractRefs = (await Promise.all(contracts.map(async path => {
    try { return matches(await readFile(join(ROOT, path), 'utf8'), name, path, 2); }
    catch { return []; }
  }))).flat();
  const sourcePaths = (await sourceFiles('src')).sort((a, b) => Number(b.startsWith('src/workflow/')) - Number(a.startsWith('src/workflow/')));
  const testPaths = await sourceFiles('test');
  return {
    graph: { path: graphPath, line: matchingLine + 1 },
    contracts: contractRefs.length ? contractRefs : contracts.map(path => ({ path, line: 0 })),
    implementation: await findReferences(sourcePaths, name, 8),
    tests: await findReferences(testPaths, name, 8),
  };
}
