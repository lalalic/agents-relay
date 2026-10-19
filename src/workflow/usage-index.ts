/** Derived, read-only reverse usage index. Graph topology remains the only transition authority. */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { parseGraphV2, type Graph, type SemanticKind } from './graph-v2.js';

export type WorkflowSymbolKind = SemanticKind | 'event' | 'request';
export type WorkflowUsage = Readonly<{
  graph: string;
  kind: WorkflowSymbolKind;
  id: string;
  line: number;
  node?: string;
}>;
const EXECUTABLE_GRAPH = /^[a-z][a-z0-9-]*\.mmd$/;

export function executableGraphs(directory: string): ReadonlyMap<string, Graph> {
  const output = new Map<string, Graph>();
  for (const filename of readdirSync(directory).sort()) {
    if (!EXECUTABLE_GRAPH.test(filename) || filename === 'main.mmd') continue;
    output.set(filename, parseGraphV2(readFileSync(join(directory, filename), 'utf8')));
  }
  return output;
}

export function buildWorkflowUsageIndex(graphs: ReadonlyMap<string, Graph>): readonly WorkflowUsage[] {
  const usages: WorkflowUsage[] = [];
  for (const [graphName, graph] of graphs) {
    for (const node of graph.nodes.values()) {
      usages.push({ graph: graphName, kind: node.kind, id: node.semanticId, line: node.line, node: node.id });
    }
    for (const edge of graph.edges) {
      if ((edge.kind === 'on' || edge.kind === 'emit' || edge.kind === 'request') && edge.semanticId) {
        usages.push({ graph: graphName, kind: edge.kind === 'request' ? 'request' : 'event', id: edge.semanticId, line: edge.line });
      }
    }
  }
  return usages.sort((a, b) => a.id.localeCompare(b.id) || a.graph.localeCompare(b.graph) || a.line - b.line);
}

export function whereWorkflowSymbol(
  index: readonly WorkflowUsage[], id: string, kind?: WorkflowSymbolKind,
): readonly WorkflowUsage[] {
  return index.filter(item => item.id === id && (!kind || item.kind === kind));
}

export function defaultWorkflowDirectory(): string {
  return resolve(fileURLToPath(new URL('../../workflow/', import.meta.url)));
}
