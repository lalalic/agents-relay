/** Read-only workflow discovery/evaluation; executable effects require durable authorization. */
import { buildWorkflowUsageIndex, defaultWorkflowDirectory, executableGraphs, whereWorkflowSymbol } from './workflow/usage-index.js';
import { ConditionRegistry, booleanCondition } from './workflow/conditions.js';
import { GraphRuntime } from './workflow/graph-v2.js';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { verifyAuthoritativeCondition, type AuthoritativePredicate } from './workflow/authoritative-conditions.js';
import { WORKFLOW_EVENT_NAMES, WORKFLOW_EFFECT_NAMES, WORKFLOW_MUTATION_NAMES } from './workflow/contracts.js';

export function workflowCliResult(args: readonly string[]): unknown {
  const [verb, ...options] = args;
  const value = (flag: string): string => {
    const offset = options.indexOf(flag);
    return offset >= 0 ? options[offset + 1] ?? '' : '';
  };
  const graphs = executableGraphs(defaultWorkflowDirectory());
  const index = buildWorkflowUsageIndex(graphs);
  if (verb === 'discover') return { graphs: [...graphs.keys()], symbols: [...new Set(index.map(x => x.id))].sort() };
  if (verb === 'where') return whereWorkflowSymbol(index, value('--id'));
  if (verb === 'inspect') {
    const name = value('--graph');
    const graph = graphs.get(name);
    if (!graph) throw new Error('unknown executable graph');
    return { graph: name, initial: graph.initial, nodes: [...graph.nodes.values()], edges: graph.edges };
  }
  if (verb === 'evaluate') {
    const name = value('--graph');
    const graph = graphs.get(name);
    if (!graph) throw new Error('unknown executable graph');
    const inputId = value('--event');
    const state = value('--state');
    if (!inputId || !state) throw new Error('evaluate requires --event and --state');
    const evidence = value('--facts');
    const facts: unknown = evidence ? JSON.parse(evidence) : {};
    if (!facts || typeof facts !== 'object' || Array.isArray(facts)) throw new Error('facts must be a JSON object');
    const record = facts as Readonly<Record<string, unknown>>;
    const guards = [...new Set([...graph.nodes.values()].filter(n => n.kind === 'guard').map(n => n.semanticId))];
    const conditions = new ConditionRegistry(guards.map(booleanCondition));
    const runtime = new GraphRuntime(graph, {
      states: new Set([...graph.nodes.values()].filter(n => n.kind === 'state').map(n => n.semanticId)),
      guards: Object.fromEntries(guards.map(id => [id, conditions.guard(id)])),
      actions: Object.fromEntries([...new Set([...WORKFLOW_EFFECT_NAMES, ...WORKFLOW_MUTATION_NAMES, ...[...graph.nodes.values()].filter(n => n.kind === 'action').map(n => n.semanticId)])].map(id => [id, { id }])),
      events: Object.fromEntries([...new Set([...WORKFLOW_EVENT_NAMES, inputId, ...graph.edges.filter(e => e.kind === 'on' || e.kind === 'emit').map(e => e.semanticId).filter((id): id is string => !!id)])].map(id => [id, { id }])),
    });
    return { mode: 'dry-run', decision: runtime.evaluateSync({ currentState: state, input: { transport: 'event', id: inputId, payload: {} }, durableFacts: record }) };
  }
  if (verb === 'verify') {
    const path = value('--sqlite');
    const jobId = value('--job');
    const predicate = value('--condition');
    const allowed = new Set(['task.queued','task.succeeded','task.failed','task.routing-cleared','task.execution-stopped','job.objective-verified','job.completed']);
    if (!path || !existsSync(path) || !jobId || !allowed.has(predicate)) throw new Error('verify requires existing --sqlite, --job and supported --condition');
    const db = new DatabaseSync(path, { readOnly: true });
    try {return {condition:predicate,jobId,taskId:value('--task')||null,outcome:verifyAuthoritativeCondition(db,jobId,predicate as AuthoritativePredicate,value('--task'),value('--execution'))};}
    finally {db.close();}
  }
  if (verb === 'trace') {
    const path = value('--sqlite');
    const key = value('--attempt-key');
    if (!path || !key || !existsSync(path)) throw new Error('trace requires existing --sqlite path and --attempt-key');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_action_trace'").get();
      if (!table) return { attemptKey: key, trace: null };
      const record = db.prepare('SELECT attempt_key,execution_id,generation,graph,action_id,condition_id,outcome,observed_at FROM workflow_action_trace WHERE attempt_key=?').get(key) ?? null;
      return { attemptKey: key, trace: record };
    } finally { db.close(); }
  }
  if (verb === 'action') throw new Error('durable graph authorization required; unsafe action request refused');
  throw new Error('workflow supports discover, inspect, where, evaluate; action/trace require durable authorization');
}
