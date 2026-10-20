export function cheapestSupportedModel(candidates, prices) {
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error('No Codex model candidates are available');
  const scored = candidates.map(candidate => {
    const price = prices.models[candidate.model];
    if (!price || !Number.isFinite(price.input) || !Number.isFinite(price.output)) {
      throw new Error(`No grounded price metadata for supported model ${candidate.model}`);
    }
    return { candidate, score: price.input + price.output };
  });
  scored.sort((left, right) => left.score - right.score || left.candidate.model.localeCompare(right.candidate.model));
  return scored[0].candidate;
}

export class LowestCostRouteDecision {
  name = 'l2-grounded-price-choice';
  constructor(prices) { this.prices = prices; }
  async decide(_request, contract) {
    if (contract.type !== 'choice') throw new Error('Expected route choices');
    const routes = contract.choices.map(choice => {
      const model = choice.match(/\bmodel=([^ ]+)/)?.[1];
      const price = model ? this.prices.models[model] : undefined;
      if (!model || !price) throw new Error(`Missing grounded price for router choice: ${choice}`);
      return { choice, score: price.input + price.output };
    });
    routes.sort((left, right) => left.score - right.score || left.choice.localeCompare(right.choice));
    return { type: 'choice', choice: routes[0].choice };
  }
}
