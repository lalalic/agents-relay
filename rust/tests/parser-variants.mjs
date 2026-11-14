import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseGraphV2} from '../../dist/workflow/graph-v2.js';
const binary = resolve(import.meta.dirname,'../target/debug/agents-relay-rust');
const skeleton = (directive='%% relay: initial start',header='flowchart LR',edge='start -->|on: go| end')=>`${header}\n${directive}\nstart["state: START"]\nend["state: END"]\n${edge}`;
const examples=[
  ...['%% relay: initial start','%% relay:  initial start','%%  relay: initial start','%%relay: initial start',
    '%%\trelay:\tinitial\tstart','%% relay: initial   start','%% relay: initial  start',
    '%% relay: initial\tstart','%% relay:initial start', '%% relay: initial start ',
    '%% relay: initial start extra','%% relay: initial','%% relay: initial start\n%% relay: initial start']
    .map(x=>skeleton(x)),
  ...['flowchart LR','flowchart RL','flowchart TD','flowchart TB','flowchart  LR','flowchart\tLR',
    'flowchart lr','flowchart LR ', 'graph LR'].map(x=>skeleton(undefined,x)),
  ...['start -->|on: go| end','start --> | on: go | end', 'start -->|on:go| end',
    'start -->| on : go | end','start--> |on: go|end','start --> end',
    'start -->|request: go| end','start -->|true| end','start -->|false| end'].map(x=>skeleton(undefined,undefined,x)),
  ['---','title: Sample','---',skeleton()].join('\n'),
  ['---','---',skeleton()].join('\n'),
  skeleton().replaceAll('\n','\r\n'),
  skeleton()+'\n',
  skeleton()+'\n%% harmless comment',
  skeleton().replace('end["state: END"]','end["state: END | More context"]'),
];
test('Rust graph parser accepts and rejects same whitespace/metadata/edge variants as TS',()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-rust-graph-variants-'));
  const differences=[];
  try {
    for(const [index,source] of examples.entries()) {
      let ts=true;
      try{parseGraphV2(source);}catch{ts=false;}
      const path=join(dir,`graph-${index}.mmd`);writeFileSync(path,source);
      const rust=spawnSync(binary,['graph','validate','--graph',path],{encoding:'utf8'});
      if(ts!==(rust.status===0))differences.push({index,ts,rust:rust.status===0,source:source.slice(0,120),error:rust.stderr.trim()});
    }
    assert.deepEqual(differences,[]);
    console.log(`Rust parser parity: ${examples.length} metadata, spacing, malformed-edge variants`);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
