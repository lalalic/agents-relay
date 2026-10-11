import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgentGraph, agentGraphPrompt, validateAgentSelection } from '../dist/agent-graph.js';
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

test('agent selection rejects invisible named and graph agents but allows an unnamed task', async () => {
  const root=await mkdtemp(join(tmpdir(),'agents-relay-agent-validation-'));
  try {
    const workspace=join(root,'workspace'), neo=join(workspace,'neo'), project=join(workspace,'project');
    await Promise.all([mkdir(project,{recursive:true}),mkdir(neo,{recursive:true})]);
    await writeAgent(project,'reviewer');
    const context=await resolveExecutionContext(project,'planner',{workspaceRoot:workspace,neoRoot:neo,globalRoot:join(root,'global')});
    assert.doesNotThrow(() => validateAgentSelection(context));
    assert.doesNotThrow(() => validateAgentSelection(context, 'reviewer'));
    assert.throws(() => validateAgentSelection(context, 'missing-agent'), /Agent missing-agent is not visible in the resolved planning\/execution context/);
    assert.throws(() => validateAgentSelection(context, undefined, 'flowchart TD\nreviewer --> missing-agent'), /Agent missing-agent referenced by agentGraph node missing-agent is not visible/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('agent graph loads every node contract and preserves fan-in dependencies', async () => {
  const root=await mkdtemp(join(tmpdir(),'agents-relay-agent-graph-'));
  try {
    const workspace=join(root,'workspace'), neo=join(workspace,'neo'), project=join(workspace,'project');
    await Promise.all([mkdir(project,{recursive:true}),mkdir(neo,{recursive:true})]);
    for (const name of ['strategy','product','synthesis','planner']) await writeAgent(project,name);
    const context=await resolveExecutionContext(project,'worker',{workspaceRoot:workspace,neoRoot:neo,globalRoot:join(root,'global')});
    const prompt=await agentGraphPrompt(context,`flowchart TD\nstrategy --> synthesis\nproduct --> synthesis\nsynthesis --> planner`);
    assert.match(prompt,/Execution waves: 1:product,strategy \| 2:synthesis \| 3:planner/);
    assert.match(prompt,/\[Node synthesis; predecessors=strategy,product\]/);
    assert.match(prompt,/strategy CONTRACT/);
    assert.match(prompt,/planner CONTRACT/);
    assert.match(prompt,/NOT durable child Tasks/);
  } finally { await rm(root,{recursive:true,force:true}); }
});


test('business-loop can feed the canonical bundled planner in an external project context', async () => {
  const root=await mkdtemp(join(tmpdir(),'agents-relay-business-graph-'));
  try {
    const workspace=join(root,'workspace'), neo=join(workspace,'neo'), project=join(workspace,'product');
    await Promise.all([mkdir(project,{recursive:true}),mkdir(neo,{recursive:true})]);
    await writeAgent(project,'business-loop');
    const context=await resolveExecutionContext(project,'worker',{workspaceRoot:workspace,neoRoot:neo,globalRoot:join(root,'global')});
    const planner=context.agents.find(agent=>agent.name==='planner');
    assert.equal(planner?.source,'builtin');
    assert.match(planner?.path ?? '',/skills\/agents-relay\/agents\/planner\.agent\.md$/);
    const prompt=await agentGraphPrompt(context,`flowchart TD\nbusiness-loop --> planner`);
    assert.match(prompt,/Execution waves: 1:business-loop \| 2:planner/);
    assert.match(prompt,/business-loop CONTRACT/);
    assert.match(prompt,/# Planner Agent/);
  } finally { await rm(root,{recursive:true,force:true}); }
});


test('agent graph rejects non-production Mermaid graph headers', () => {
  assert.throws(() => parseAgentGraph(`graph LR\na --> b`), /must start with Mermaid flowchart/);
});

test('bundled Planner Agent Graph example uses the production grammar', async () => {
  const source = await readFile(new URL('../skills/agents-relay/agents/planner.agent.md', import.meta.url), 'utf8');
  assert.equal(source.includes('"agentGraph": "graph LR'), false);
  assert.equal(source.includes('"agentGraph": "flowchart LR\\n  build-log-editor --> build-log-producer"'), true);
  assert.doesNotThrow(() => parseAgentGraph('flowchart LR\nbuild-log-editor --> build-log-producer'));
});
