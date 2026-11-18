// Direct Node src/usage.ts UsageRegistry/UnavailableUsageReader vs Rust
// aggregated provider observations. All readers injected as fake, no network,
// no Codex CLI, no private account tokens and no production Job state.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {
  UsageRegistry,UnavailableUsageReader,readUsageSnapshot,
} from '../../dist/usage.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
let seed=0x75154;
function rand(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
const pick=arr=>arr[rand()%arr.length];
const snapshots=[
 {available:true,generatedAt:'2026-11-17T10:00:00.000Z',fiveHour:{usedPercent:50,windowMinutes:300,resetsAt:1234},weekly:null,reason:null},
 {available:false,generatedAt:'2026-11-17T10:00:00.000Z',fiveHour:null,weekly:null,reason:'unavailable'},
 {available:true,generatedAt:'2026-11-17T10:00:00.000Z',fiveHour:null,weekly:{usedPercent:1,windowMinutes:10080,resetsAt:null},reason:null},
];
const credits=[
 null,
 {available:false,generatedAt:'2026-11-17T10:00:00.000Z',balances:[],reason:'unavailable'},
 {available:true,generatedAt:'2026-11-17T10:00:00.000Z',balances:[{currency:'USD',total:10,used:4,remaining:6}],reason:null}
];
const capacity=[
 null,
 {name:'Harness',poolSize:5,idle:1,leased:4,available:2,observedAt:'2026-11-17T10:00:00.000Z',reason:null},
 {name:'Harness',poolSize:null,idle:null,leased:null,available:null,observedAt:'2026-11-17T10:00:00.000Z',reason:'stale'}
];
const fixtures=[];
for(let i=0;i<165;i++){
 const fixture={op:'usageRegistryScenario',
  method:pick(['snapshot','readUsageSnapshot']),
  openai:pick(snapshots),zai:pick(snapshots),
  deepseek:pick(credits),openrouter:pick(credits),browser:pick(capacity)};
 if(i%19===0)fixture[pick(['openai','zai','deepseek','openrouter','browser'])]={error:'test provider failure '+i};
 fixtures.push(fixture);
}
for(const reason of ['quota unknown','', '中文', 'No account connected','timeout']) {
 fixtures.push({op:'usageRegistryScenario',method:'unavailable',reason,clock:'2026-11-17T10:22:00.000Z'});
}
async function nodeResult(f){
 try {
  if(f.method==='unavailable'){
   const reader=new UnavailableUsageReader(f.reason,()=>new Date(f.clock));
   return {ok:true,value:await reader.read()};
  }
  const reader=value=>({read:async()=>{if(value?.error)throw Error(value.error);return value;}});
  const registry=new UsageRegistry(
   reader(f.openai),reader(f.zai),
   f.deepseek===null?null:reader(f.deepseek),
   f.openrouter===null?null:reader(f.openrouter),
   f.browser===null?null:reader(f.browser));
  const value=f.method==='snapshot'?await registry.snapshot():await readUsageSnapshot(registry);
  value.generatedAt='NORMALIZED';
  return {ok:true,value};
 }catch(error){return {ok:false,error:error.message};}
}
test('Node/Rust usage registry is equal across 170 concurrent injected-provider cases',async()=>{
 const expected=await Promise.all(fixtures.map(nodeResult));
 const run=spawnSync(binary,[],{cwd:root,encoding:'utf8',
  input:fixtures.map(JSON.stringify).join('\n')+'\n',
  timeout:120000,maxBuffer:13*1024*1024});
 assert.equal(run.status,0,run.stderr||run.error?.message);
 const actual=run.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,fixtures.length);
 const mismatches=[];
 for(let i=0;i<fixtures.length;i++){
  try{assert.deepEqual(actual[i],expected[i]);}
  catch{mismatches.push({index:i,fixture:fixtures[i],node:expected[i],rust:actual[i]});}
 }
 assert.deepEqual(mismatches.slice(0,5),[],`${mismatches.length} Node/Rust usage registry mismatches`);
 console.log('Verified 170 isolated Node/Rust UsageRegistry and UnavailableUsageReader fixtures');
});
