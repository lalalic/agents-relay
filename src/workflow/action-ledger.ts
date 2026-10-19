/** Durable attempt fencing and postcondition recording for graph-authorized actions. */
import { DatabaseSync } from 'node:sqlite';
import { ConditionRegistry, type ConditionFacts, type ConditionOutcome } from './conditions.js';
import type { GraphDecision } from './graph-v2.js';

export type ActionIdentity = Readonly<{ executionId: string; generation: number; graph: string; actionId: string; attemptKey: string }>;
export type ActionTrace = ActionIdentity & Readonly<{ outcome: ConditionOutcome; conditionId: string; observedAt: string }>;
export class WorkflowActionLedger {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS workflow_action_trace (
      attempt_key TEXT PRIMARY KEY, execution_id TEXT NOT NULL, generation INTEGER NOT NULL,
      graph TEXT NOT NULL, action_id TEXT NOT NULL, condition_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('Unknown','Verified','Failed')),
      observed_at TEXT NOT NULL
    )`);
  }
  reserve(identity: ActionIdentity, decision: GraphDecision, conditionId: string): boolean {
    if (!identity.executionId || !identity.attemptKey || !conditionId || !Number.isSafeInteger(identity.generation) || identity.generation < 0) throw new Error('invalid action identity');
    if (!decision.accepted || !decision.actions.some(action => action.id === identity.actionId)) throw new Error('action not authorized by graph decision');
    const statement = this.database.prepare(`INSERT OR IGNORE INTO workflow_action_trace
      (attempt_key,execution_id,generation,graph,action_id,condition_id,outcome,observed_at)
      VALUES (?,?,?,?,?,?,'Unknown',?)`);
    return statement.run(identity.attemptKey, identity.executionId, identity.generation, identity.graph, identity.actionId, conditionId, new Date().toISOString()).changes === 1;
  }
  trace(attemptKey: string): ActionTrace | null {
    const row = this.database.prepare('SELECT * FROM workflow_action_trace WHERE attempt_key=?').get(attemptKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { attemptKey: String(row.attempt_key), executionId: String(row.execution_id), generation: Number(row.generation), graph: String(row.graph), actionId: String(row.action_id), conditionId: String(row.condition_id), outcome: row.outcome as ConditionOutcome, observedAt: String(row.observed_at) };
  }
  verify(attemptKey: string, conditions: ConditionRegistry, facts: ConditionFacts): ActionTrace {
    const existing = this.trace(attemptKey);
    if (!existing) throw new Error('unreserved action attempt');
    if (existing.outcome !== 'Unknown') return existing;
    const outcome = conditions.evaluate(existing.conditionId, facts);
    // Unknown is intentionally retained: no second executor may treat it as a new attempt.
    this.database.prepare('UPDATE workflow_action_trace SET outcome=?, observed_at=? WHERE attempt_key=? AND outcome=?')
      .run(outcome, new Date().toISOString(), attemptKey, 'Unknown');
    return this.trace(attemptKey)!;
  }
}
