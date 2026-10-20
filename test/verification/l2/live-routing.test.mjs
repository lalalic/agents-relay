import test from 'node:test';
import assert from 'node:assert/strict';
import prices from './model-prices.json' with { type: 'json' };
import { cheapestSupportedModel, LowestCostRouteDecision } from './live-routing.mjs';

test('cheapest supported route uses grounded standard token prices', () => {
  const candidates = [{ model: 'gpt-6.1-sol' }, { model: 'gpt-6-luna' }, { model: 'gpt-5.6-luna' }];
  assert.equal(cheapestSupportedModel(candidates, prices).model, 'gpt-6-luna');
});

test('unknown supported model prices fail closed', () => {
  assert.throws(() => cheapestSupportedModel([{ model: 'new-model' }], prices), /No grounded price metadata/);
});

test('router decision selects only among eligible choices at the lowest listed cost', async () => {
  const engine = new LowestCostRouteDecision(prices);
  const result = await engine.decide({}, { type: 'choice', question: 'Select a route', choices: [
    'worker=codex provider=openai model=gpt-6.1-sol reasoning=low default=false',
    'worker=codex provider=openai model=gpt-6-luna reasoning=low default=true',
  ] });
  assert.match(result.choice, /model=gpt-6-luna/);
});
