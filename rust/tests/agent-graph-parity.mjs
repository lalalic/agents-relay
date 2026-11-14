import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseAgentGraph} from '../../dist/agent-graph.js';
const exe=resolve(import.meta.dirname,'../target/debug/agents-relay-rust');
const valid=[
 'flowchart TD\nA[agent:first]\nB[agent:second]\nC[agent:third]\nA --> C\nB --> C',
 'flowchart LR\nA --> B\nB --> C',
 'flowchart RL\nC[agent:third]\nA[agent:first]\nB[agent:second]\nA --> C\nB --> C',
 'flowchart TB\nA[agent:alpha]\nA[agent:later]\nA --> B[agent:bravo]',
 'flowchart TD\nA --> B\nA --> C\nA --> C\nB --> D\nC --> D',
 '%% comment\nflowchart TD\n%% another\nA[agent:one]\nB[agent:two]\nA[agent:actual] --> B',
 'flowchart TD\nA[agent:one]',
];
const bad=[
 'flowchart LR\nA --> A',
 'flowchart TD\nA --> B\nB --> C\nC --> A',
 'flowchart LR\nA[agent:x]\nC[agent:other]\nA --> C\nC --> A',
 'flowchart LR',
 'flowchart LR\nA[agent:one]\nA --x--> B',
 'graph LR\nA --> B',
 'flowchart TD\nA --> B\nB --> C\nB --> A',
];
test('Rust agentGraph DAG nodes, edges and waves match existing TypeScript parser',()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-rust-agentgraph-'));
 try{
  for(const [i,source] of [...valid,...bad].entries()){
   const path=join(dir,`dag-${i}.mmd`);writeFileSync(path,source);
   const result=spawnSync(exe,['dag','parse','--file',path],{encoding:'utf8'});
   let ts=null;
   try{ts=parseAgentGraph(source);}catch{}
   if(ts===null)assert.notEqual(result.status,0,`Rust should reject invalid DAG ${i}`);
   else{
    assert.equal(result.status,0,`${i}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout),ts,`AgentGraph ${i}`);
   }
  }
  console.log(`AgentGraph topology parity: ${valid.length} valid + ${bad.length} invalid`);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
