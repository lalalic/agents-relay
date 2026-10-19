/** Pure, read-only conditions shared by pre-action guards and post-action verification. */
export type ConditionOutcome = 'Verified' | 'Failed' | 'Unknown';
export type ConditionFacts = Readonly<Record<string, unknown>>;
export type ConditionCheck = (facts: ConditionFacts) => ConditionOutcome;
export type ConditionSpec = Readonly<{ id: string; check: ConditionCheck }>;
export class ConditionRegistry {
  private readonly conditions = new Map<string, ConditionSpec>();
  constructor(specs: readonly ConditionSpec[]) {
    for (const spec of specs) {
      if (this.conditions.has(spec.id)) throw new Error(`duplicate condition: ${spec.id}`);
      this.conditions.set(spec.id, spec);
    }
  }
  discover(): readonly string[] { return [...this.conditions.keys()].sort(); }
  inspect(id: string): ConditionSpec {
    const result = this.conditions.get(id);
    if (!result) throw new Error(`unknown condition: ${id}`);
    return result;
  }
  check(id: string, facts: ConditionFacts): ConditionOutcome {
    return this.inspect(id).check(facts);
  }
  guard(id: string): (facts: { durableFacts: ConditionFacts }) => boolean {
    return ({ durableFacts }) => this.check(id, durableFacts) === 'Verified';
  }
}
export function booleanCondition(id: string): ConditionSpec {
  return { id, check: facts => facts[id] === true ? 'Verified' : facts[id] === false ? 'Failed' : 'Unknown' };
}
export type EffectVerification = Readonly<{ outcome: ConditionOutcome; actionId: string; conditionId: string }>;
export function verifyActionEffect(
  registry: ConditionRegistry, actionId: string, conditionId: string, facts: ConditionFacts,
): EffectVerification {
  return { actionId, conditionId, outcome: registry.check(conditionId, facts) };
}
export function safeRetryAllowed(outcome: ConditionOutcome): boolean {
  return outcome === 'Failed';
}
