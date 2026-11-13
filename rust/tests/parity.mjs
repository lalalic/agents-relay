// Read-only differential test: TypeScript and Rust evaluate the exact same
// canonical Mermaid graphs. No Relay Job/Task, provider, or production DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { GraphRuntime, parseGraphV2 } from '../../dist/workflow/graph-v2.js';

const root = resolve(import.meta.dirname, '../..');
const binary = resolve(root, 'rust/target/debug/agents-relay-rust');
const workflow = resolve(root, 'workflow');
const graphFiles = readdirSync(workflow).filter(n => n.endsWith('.mmd') && n !== 'main.mmd').sort();

function runtimeFor(source, currentGuards) {
  const graph = parseGraphV2(source);
  const states = new Set();
  const guards = new Map();
  const actions = new Map();
  const events = new Map();
  for (const n of graph.nodes.values()) {
    switch (n.kind) {
      case 'state': states.add(n.semanticId); break;
      case 'guard': guards.set(n.semanticId, () => Boolean(currentGuards[n.semanticId])); break;
      case 'action': actions.set(n.semanticId, {id:n.semanticId}); break;
      case 'emit': events.set(n.semanticId, {id:n.semanticId}); break;
    }
  }
  for (const e of graph.edges) {
    if (e.kind === 'on' || e.kind === 'emit') events.set(e.semanticId, {id:e.semanticId});
    if (e.kind === 'request') actions.set(e.semanticId, {id:e.semanticId});
  }
  return { graph, runtime: new GraphRuntime(graph, {states, guards, actions, events}) };
}

test('19 canonical executable graphs: TypeScript vs Rust graph topology and all guarded decisions', () => {
  let checked = 0, cases = 0;
  for (const file of graphFiles) {
    const source = readFileSync(join(workflow,file),'utf8');
    const currentGuards = Object.create(null);
    const {graph, runtime} = runtimeFor(source,currentGuards);
    const patterns = [false,true,'alternate'];
    const requests = [],expected=[];
    for (const pattern of patterns) {
      let index=0;
      for (const n of graph.nodes.values()) {
        if (n.kind === 'guard') currentGuards[n.semanticId] = pattern==='alternate' ? (index++%2===0) : pattern;
      }
      const snapshot = {...currentGuards};
      for (const state of graph.nodes.values()) {
        if (state.kind !== 'state') continue;
        const seen = new Set();
        for (const edge of graph.edges.filter(e=>e.from===state.id && (e.kind==='on'||e.kind==='request'))) {
          const key=edge.kind+':'+edge.semanticId;
          if (seen.has(key)) continue;
          seen.add(key);
          const facts = {currentState:state.semanticId, input:{transport:edge.kind==='on'?'event':'action',id:edge.semanticId,payload:{marker:file,pattern}}, durableFacts:{}};
          const request = {currentState:facts.currentState,input:facts.input,guards:snapshot};
          requests.push(request);
          expected.push(runtime.evaluateSync(facts));
        }
      }
    }
    const response=spawnSync(binary,['graph','batch','--graph',join(workflow,file)],{
      encoding:'utf8',input:requests.map(r=>JSON.stringify(r)).join('\n')+'\n',maxBuffer:16*1024*1024,
    });
    assert.equal(response.status,0,`${file}: ${response.stderr}`);
    const actual=response.stdout.trim().split('\n').map(x=>JSON.parse(x));
    assert.equal(actual.length,expected.length,`${file}: output count`);
    for (let i=0;i<expected.length;i++) {
      assert.deepEqual(actual[i],expected[i],`${file}: decision #${i} input ${JSON.stringify(requests[i])}`);
    }
    checked++;
    cases+=actual.length;
  }
  console.log(`Rust graph parity verified: ${checked} graphs, ${cases} decisions`);
  assert.equal(checked,19);
  assert.ok(cases>200);
});

test('Rust parser and TypeScript agree on invalid executable Graphs', () => {
  const temp=mkdtempSync(join(tmpdir(),'relay-rust-invalid-'));
  const invalid=[
    'flowchart LR\n%% relay: initial x\nx["state: X"]\nx --> missing',
    'flowchart LR\n%% relay: initial x\nx["state: X"]\ny["state: Y"]\nx -->|on: go| y\nx -->|on: go| y',
    'flowchart LR\n%% relay: initial x\nx["state: X"]\ninvalid @ syntax',
    'flowchart LR\nx["state: X"]\ny["state: Y"]\nx -->|on: go| y',
    'flowchart LR\n%% relay: initial x\nx["state: X"]\nx["state: X"]\ny["state: Y"]\nx -->|on: go| y',
    'flowchart LR\n%% relay: initial x\nx["state: X"]\ny["state: Y"]\na["action: record"]\nx -->|on: go| a\ny -->|on: go| x',
    'flowchart LR\n%% relay: initial x\nx["state: X"]\ny["state: Y"]\ng["guard: ready"]\nx -->|on: go| g\ng -->|on: invalid| y',
    'flowchart LR\n%% relay: initial x\nx["state: X"]\ny["state: Y"]\ng["guard: ready"]\nx -->|on: go| g\ng -->|true| y\ng -->|true| x',
    'flowchart LR\n%% relay: initial x\nx["state: X"]\ny["state: Y"]\nx -->|on: go| y\ny -->|false| x',
  ];
  try {
    for (const [i,source] of invalid.entries()) {
      const file=join(temp,`${i}.mmd`);
      writeFileSync(file,source);
      assert.throws(()=>parseGraphV2(source),`TypeScript should reject bad graph ${i}`);
      const result=spawnSync(binary,['graph','validate','--graph',file],{encoding:'utf8'});
      assert.notEqual(result.status,0,`Rust incorrectly accepted bad graph ${i}: ${result.stdout}`);
    }
    console.log(`Both parsers rejected ${invalid.length} malformed graphs`);
  } finally {rmSync(temp,{recursive:true,force:true});}
});
