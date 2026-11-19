// Real original Node and Rust browser worker routing admission semantics.
// Disposable isolated store; the pool singleton never touches live state.
// Both sides drive a real pool health state: HEALTHY default, pre-submission
// outage windows, and verified recovery, over the certified Worker Router
// candidate chain with strict capabilities.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

process.env.AGENTS_RELAY_STORE_DIR=mkdtempSync(join(tmpdir(),'r2-browser-worker-routing-'));
const {hasSafeAlternativeWorker}=await import('../../dist/browser-worker-routing.js');
const {browserWorkerPool}=await import('../../dist/browser-worker-runtime.js');
const {workerCandidates,eligibleWorkerCandidates}=await import('../../dist/worker-routing.js');

const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const NOW=1795000000000;
const codexAdapter={name:'codex',id:'codex-1',capabilities:['codex','shell','write']};
const chatgptAdapter={name:'chatgpt',id:'chatgpt-1',capabilities:['browser','write']};
const zAdapter={name:'z',id:'z-1',capabilities:['browser']};
const scriptAdapter={name:'script',id:'script-1',capabilities:['script']};
const ADAPTER_SETS=[
  [codexAdapter],
  [chatgptAdapter],
  [zAdapter],
  [codexAdapter,chatgptAdapter],
  [chatgptAdapter,zAdapter],
  [scriptAdapter,codexAdapter,chatgptAdapter,zAdapter],
];
// AgentRegistration.routing is a required field in the original contract.
const reg=(id,adapter,capabilities,extra={})=>({
  id,capabilities,runtime:{adapter,...(extra.provider?{provider:extra.provider}:{})},
  ...(extra.availability?{availability:extra.availability}:{}),
  routing:{...(extra.routing||{})},
});
const AGENT_SETS=[
  [],
  [reg('ag-codex','codex',['codex','write'])],
  [reg('ag-chatgpt','chatgpt',['browser'])],
  [reg('ag-z','z',['browser'])],
  [reg('ag-offline','chatgpt',['browser'],{availability:'offline'})],
  [reg('ag-no-cap','chatgpt',['write'])],
  [reg('ag-mixed','chatgpt',['write']),reg('ag-codex2','codex',['codex'])],
];
const TASKS=[
  undefined,null,
  {adapter:'orchestrator'},
  {adapter:'chatgpt',chatgptThreadDelivery:true},
  {adapter:'chatgpt',chatgptThreadDelivery:'x'},
  {adapter:'chatgpt',chatgptThreadDelivery:false},
  {adapter:'chatgpt',chatgptThreadDelivery:0},
  {adapter:'chatgpt',chatgptThreadDelivery:''},
  {adapter:'chatgpt',chatgptThreadDelivery:null},
  {adapter:'z'},{adapter:'script'},{adapter:'codex'},
  {adapter:'script',workerRequirements:{capabilities:['script']}},
  {adapter:'script',workerRequirements:{capabilities:['browser']}},
  {adapter:'chatgpt',workerRequirements:{runtime:'chatgpt'}},
  {adapter:'chatgpt',workerRequirements:{runtime:'codex'}},
  {adapter:'chatgpt',workerRequirements:{capabilities:['browser','write']}},
  {adapter:'chatgpt',workerRequirements:{capabilities:['video']}},
  {adapter:'chatgpt',workerRequirements:null},
];
const USAGE_SETS=[
  undefined,
  {providers:[{id:'chatgpt',usage:{available:true,fiveHour:{usedPercent:42,resetsAt:NOW/1000+3600},weekly:{usedPercent:10,resetsAt:null}}}],credits:[]},
  {browserWorkspace:{available:0,total:6},providers:[],credits:[]},
  {browserWorkspace:{available:2,total:6},providers:[],credits:[]},
];
const POOL_STATES=[
  {},
  {chatgpt:{outageMs:600000}},
  {z:{outageMs:600000}},
  {chatgpt:{outageMs:600000},z:{outageMs:600000}},
  {chatgpt:{healthy:true}},
];
function setPool(state){
  const pool=browserWorkerPool();
  for(const provider of ['chatgpt','z']){
    const entry=state[provider];
    if(entry&&entry.outageMs!==undefined)pool.reportPreSubmissionOutage(provider,entry.outageMs);
    else pool.reportHealthy(provider);
  }
}
const cases=[];
for(let i=0;i<TASKS.length;i++)for(const adapters of ADAPTER_SETS)
  for(const agents of AGENT_SETS)for(const usage of USAGE_SETS){
    const poolState=POOL_STATES[cases.length%POOL_STATES.length];
    cases.push({task:TASKS[i],adapters,agents,usage,poolState,nowMs:NOW,poolClock:NOW});
  }
function expected(f){
  setPool(f.poolState);
  const requirements=f.task?.workerRequirements??{capabilities:[]};
  const eligible=eligibleWorkerCandidates(
    workerCandidates(f.adapters,f.agents,f.usage),requirements,{strictCapabilities:true})
    .map(candidate=>candidate.adapter);
  return {eligible,healthy:hasSafeAlternativeWorker(f.task,f.adapters,f.agents,f.usage)};
}
function firstDiff(a,b,path=''){
  if(Object.is(a,b))return null;
  if(typeof a!==typeof b||a===null||b===null||typeof a!=='object')return [path,a,b];
  if(Array.isArray(a)!==Array.isArray(b))return [path,a,b];
  if(Array.isArray(a)){
    if(a.length!==b.length)return [path+'/length',a.length,b.length];
    for(let i=0;i<a.length;i++){const d=firstDiff(a[i],b[i],path+'/'+i);if(d)return d;}
    return null;
  }
  for(const k of new Set([...Object.keys(a),...Object.keys(b)])){
    const d=firstDiff(a[k],b[k],path+'/'+k);if(d)return d;
  }
  return null;
}
test('original Node/Rust browser worker routing admission differential',()=>{
  const requests=cases.map(f=>({op:'certBrowserWorkerRouting',method:'route',
    task:f.task===undefined?null:f.task,adapters:f.adapters,agents:f.agents,
    usage:f.usage===undefined?null:f.usage,nowMs:f.nowMs,poolClock:f.poolClock,
    poolHealth:f.poolState}));
  const child=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:300000,
    input:requests.map(JSON.stringify).join('\n')+'\n',maxBuffer:64*1024*1024});
  assert.equal(child.status,0,child.stderr||String(child.error));
  const outputs=child.stdout.trim().split('\n').map(line=>{
    const parsed=JSON.parse(line);
    if(!parsed.ok)throw new Error('parity error: '+parsed.error);
    return parsed.value;
  });
  assert.equal(outputs.length,cases.length);
  const failures=[];
  for(let i=0;i<cases.length;i++){
    const want=expected(cases[i]);
    const diff=firstDiff(want,outputs[i]);
    if(!diff)continue;
    failures.push({i,adapter:cases[i].adapters.map(a=>a.name).join('+'),
      agentIndex:AGENT_SETS.indexOf(cases[i].agents),task:cases[i].task,
      pool:cases[i].poolState,diff});
  }
  for(const f of failures.slice(0,12))console.log('ROUTING_DIFF',f.i,f.adapter,
    'agents='+f.agentIndex,'pool='+JSON.stringify(f.pool),JSON.stringify(f.diff).slice(0,300));
  assert.deepEqual(failures.map(f=>f.i),[],
    `${failures.length} original Node/Rust routing mismatches`);
  console.log('Verified',cases.length,'original Node/Rust browser worker routing cases');
});
