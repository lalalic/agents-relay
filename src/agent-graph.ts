import { agentContractPrompt, ExecutionContext } from './execution-context.js';

export type AgentGraphNode = { id: string; agent: string };
export type AgentGraph = { source: string; nodes: readonly AgentGraphNode[]; edges: readonly { from: string; to: string }[]; waves: readonly (readonly string[])[] };

const ID = '[A-Za-z_][A-Za-z0-9_.-]*';
const EDGE = new RegExp(`^(${ID})(?:\\[agent:(${ID})\\])?\\s*-->\\s*(${ID})(?:\\[agent:(${ID})\\])?$`);
const NODE = new RegExp(`^(${ID})\\[agent:(${ID})\\]$`);

export function parseAgentGraph(source: string): AgentGraph {
  const lines = source.split(/\r?\n/);
  let header = false;
  const agents = new Map<string, string>();
  const edges: Array<{ from: string; to: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('%%')) continue;
    if (!header) {
      if (!/^flowchart\s+(?:TD|TB|LR|RL)$/.test(line)) throw new Error(`Agent Graph must start with Mermaid flowchart TD/TB/LR/RL (line ${index + 1})`);
      header = true;
      continue;
    }
    const edge = line.match(EDGE);
    if (edge) {
      const [, from, fromAgent, to, toAgent] = edge;
      agents.set(from, fromAgent || agents.get(from) || from);
      agents.set(to, toAgent || agents.get(to) || to);
      edges.push({ from, to });
      continue;
    }
    const node = line.match(NODE);
    if (node) { agents.set(node[1], node[2]); continue; }
    throw new Error(`Unsupported Agent Graph syntax at line ${index + 1}: ${line}`);
  }
  if (!header) throw new Error('Agent Graph is empty');
  if (agents.size === 0) throw new Error('Agent Graph requires at least one agent node');

  const incoming = new Map([...agents.keys()].map(id => [id, 0]));
  const outgoing = new Map([...agents.keys()].map(id => [id, [] as string[]]));
  for (const edge of edges) {
    if (edge.from === edge.to) throw new Error(`Agent Graph self-cycle at ${edge.from}`);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const remaining = new Map(incoming);
  const waves: string[][] = [];
  let ready = [...remaining.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
  let visited = 0;
  while (ready.length) {
    waves.push(ready);
    visited += ready.length;
    const next = new Set<string>();
    for (const id of ready) {
      for (const target of outgoing.get(id) ?? []) {
        const degree = (remaining.get(target) ?? 0) - 1;
        remaining.set(target, degree);
        if (degree === 0) next.add(target);
      }
    }
    ready = [...next].sort();
  }
  if (visited !== agents.size) throw new Error('Agent Graph contains a cycle');
  return { source, nodes: [...agents].map(([id, agent]) => ({ id, agent })), edges, waves };
}

export async function agentGraphPrompt(context: ExecutionContext, source: string): Promise<string> {
  const graph = parseAgentGraph(source);
  const contracts = await Promise.all(graph.nodes.map(async node => ({ node, prompt: await agentContractPrompt(context, node.agent) })));
  const incoming = new Map(graph.nodes.map(node => [node.id, graph.edges.filter(edge => edge.to === node.id).map(edge => edge.from)]));
  return `[Task Agent Graph]\n${source.trim()}\n\nExecution waves: ${graph.waves.map((wave, index) => `${index + 1}:${wave.join(',')}`).join(' | ')}\n\nExecute this graph inside the current durable Task. Nodes are reasoning roles, NOT durable child Tasks. Preserve the original Job/Task context for every node. Nodes in the same wave are independent: evaluate each from the same original context without using sibling prose. For each later node, provide the original context plus structured outputs only from its declared predecessors. Do not emit outer task.started or task terminal events per node; the current durable Task owns exactly one start and one terminal event.\n\n${contracts.map(({ node, prompt }) => `[Node ${node.id}; predecessors=${(incoming.get(node.id) ?? []).join(',') || 'none'}]\n${prompt}`).join('\n\n')}`;
}
