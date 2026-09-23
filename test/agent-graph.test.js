import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgentGraph, agentGraphPrompt } from '../dist/agent-graph.js';
import { resolveExecutionContext } from '../dist/execution-context.js';

async function writeAgent(root, name) {
  const dir=join(root,'agents'); await mkdir(dir,{recursive:true});
  await writeFile(join(dir,`${name}.agent.md`),`---\nname: ${name}\n---\n\n${name} CONTRACT`);
}

test('agent graph parses fan-out/fan-in into deterministic waves', () => {
  const graph=parseAgentGraph(`flowchart TD\nstrategy --> synthesis\nproduct --> synthesis\nsynthesis --> planner`);
  assert.deepEqual(graph.waves,[['product','strategy'],['synthesis'],['planner']]);
  assert.deepEqual(graph.edges,[{from:'strategy',to:'synthesis'},{from:'product',to:'synthesis'},{from:'synthesis',to:'planner'}]);
});

test('agent graph rejects cycles', () => {
  assert.throws(()=>parseAgentGraph(`flowchart TD\na --> b\nb --> a`),/cycle/);
});

test('agent graph loads every node contract and preserves fan-in dependencies', async () => {
  const root=await mkdtemp(join(tmpdir(),'agents-relay-agent-graph-'));
  try {
    const workspace=join(root,'workspace'), neo=join(workspace,'neo'), project=join(workspace,'project');
    await Promise.all([mkdir(project,{recursive:true}),mkdir(neo,{recursive:true})]);
    for (const name of ['strategy','product','synthesis','planner']) await writeAgent(neo,name);
    const context=await resolveExecutionContext(project,'worker',{workspaceRoot:workspace,neoRoot:neo,globalRoot:join(root,'global')});
    const prompt=await agentGraphPrompt(context,`flowchart TD\nstrategy --> synthesis\nproduct --> synthesis\nsynthesis --> planner`);
    assert.match(prompt,/Execution waves: 1:product,strategy \| 2:synthesis \| 3:planner/);
    assert.match(prompt,/\[Node synthesis; predecessors=strategy,product\]/);
    assert.match(prompt,/strategy CONTRACT/);
    assert.match(prompt,/planner CONTRACT/);
    assert.match(prompt,/NOT durable child Tasks/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
