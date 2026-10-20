import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { evaluateWithModelOnlyApi } from './l2-agent-prompts/model-only-openai.mjs';

test('model-only evaluation sends no tools and requires matching provider identity', async () => {
  let sent;
  const fetchImpl = async (url, options) => {
    sent = { url, ...options, payload: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ model: 'model-test', status: 'completed', output: [{type:'message',content:[{type:'output_text',text:'{"rationale":"verified"}'}]}] }) };
  };
  const result = await evaluateWithModelOnlyApi({prompt:'Review safe evidence',apiKey:'dummy-test-token',model:'model-test',fetchImpl});
  assert.equal(result.status,'OK');
  assert.equal(sent.url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(sent.payload.tools, []);
  assert.equal(sent.payload.tool_choice,'none');
  assert.equal(sent.payload.store,false);
  assert.equal(sent.payload.input,'Review safe evidence');
  assert.equal(sent.payload.model,'model-test');
});

test('model-only evaluation rejects provider mismatch and function calls', async () => {
  const mismatch = await evaluateWithModelOnlyApi({prompt:'test',apiKey:'test',model:'requested',fetchImpl:async () => ({ok:true,json:async()=>({model:'other',status:'completed',output:[]})})});
  assert.equal(mismatch.status,'NOT_RUN');
  const tools = await evaluateWithModelOnlyApi({prompt:'test',apiKey:'test',model:'requested',fetchImpl:async () => ({ok:true,json:async()=>({model:'requested',status:'completed',output:[{type:'function_call',name:'fake'}]})})});
  assert.equal(tools.status,'FAIL');
  const absent = await evaluateWithModelOnlyApi({prompt:'test'});
  assert.equal(absent.status,'NOT_RUN');
});
