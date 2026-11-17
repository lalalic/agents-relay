// Direct Node/Rust differential for src/cli-help.ts, all 49 production source help keys plus unknown/fallback command semantics.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {readFileSync} from 'node:fs';import {resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {helpText,usage} from '../../dist/cli-help.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let compiled=false;
function rust(req){if(!compiled){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);compiled=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:10000});assert.equal(r.status,0,`${r.error}: ${r.stderr}`);return JSON.parse(r.stdout.trim());}
let seed=0x28a791ec;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};const pick=xs=>xs[rand(xs.length)];
const keys=[...readFileSync(resolve(root,'src/cli-help.ts'),'utf8').matchAll(/^  (?:'([^']+)'|([a-z][a-z0-9-]*)): `/gm)].map(m=>m[1]||m[2]);
const cases=[{op:'cliUsage'}, ...keys.map(command=>({op:'helpText',command}))];
for(const key of keys){
 const [command,...rest]=key.split(' ');if(rest.length)cases.push({op:'helpText',command,action:rest.join(' ')});
}
for(let i=0;i<2300;i++){
 const command=pick([undefined,null,'','not-real','JOB','projection','job','task','blocker','context',...keys]);
 const action=pick([undefined,null,'','not-real','resolve','create','run','conflicts','cancel','help','show']);
 cases.push({op:'helpText',command,action});
}
test('all actual CLI usage/help text and fallback command routing have exact Node bytes',()=>{
 for(const [i,req] of cases.entries()){
  const expected={ok:true,value:req.op==='cliUsage'?usage:helpText(req.command,req.action)};
  const actual=rust(req);assert.deepEqual(actual,expected,`CLI Help fixture ${i}: ${JSON.stringify(req)}`);
 }
 console.log(`Verified ${cases.length} Node/Rust production CLI help and default dispatch fixtures`);
});
