import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseGraphV2} from '../../dist/workflow/graph-v2.js';
const binary=resolve(import.meta.dirname,'../target/debug/agents-relay-rust');
const lines=[
 'flowchart LR','%% relay: initial s',
 's["state: START"]','t["state: END"]','a["action: mutation.run"]',
 'g["guard: ready"]','m["emit: done"]',
 's -->|on: go| a','a --> t','a -->|emit: done| m',
 't -->|on: restart| s','g -->|true| t',
];
const edges=['on: extra','request: extra','true','false','to: START','to: END','emit: done',null];
const nodes=['s','t','a','g','m'];
const variants=[];
for(const from of nodes)for(const to of nodes)for(const label of edges){
  variants.push({from,to,label,source:lines.join('\n')+`\n${from} -->${label?`|${label}|`:''} ${to}`});
}
test('graph topology: TS and Rust agree on edge-type combinations and invalid graphs',()=>{
  const folder=mkdtempSync(join(tmpdir(),'relay-rust-topology-'));
  const mismatches=[];
  try {
    for(const [i,one] of variants.entries()) {
      let ts=true;try{parseGraphV2(one.source)}catch{ts=false;}
      const file=join(folder,`v${i}.mmd`);writeFileSync(file,one.source);
      const rust=spawnSync(binary,['graph','validate','--graph',file],{encoding:'utf8'});
      if(ts !== (rust.status===0))mismatches.push({...one,index:i,ts,rust:rust.status===0,error:rust.stderr.trim().slice(0,160)});
    }
    assert.deepEqual(mismatches.map(({from,to,label,ts,rust,error})=>({from,to,label,ts,rust,error})),[]);
    console.log(`Topology parity: ${variants.length} node/edge combinations`);
  } finally {rmSync(folder,{recursive:true,force:true});}
});
