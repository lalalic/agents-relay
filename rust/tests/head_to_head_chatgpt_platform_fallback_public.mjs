// Real original Node and Rust chatgpt-platform-fallback public API differential.
// Routing candidates come from the certified Worker Router chain; compatible /
// no-start cases run the REAL execution routing (engine off) on both sides and
// parse the same CODEX_HOME config.toml fixtures. Isolated disposable paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {
  codexFallbackRouting,codexFallbackCompatible,
  persistChatGptPlatformFailure,codexNoStartFallbackRoute,
} from '../../dist/chatgpt-platform-fallback.js';

const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const work=mkdtempSync(join(tmpdir(),'r2-chatgpt-fallback-'));
const dirConfigured=join(work,'codex-configured');
const dirProviderOnly=join(work,'codex-provider-only');
const dirEmpty=join(work,'codex-empty');
mkdirSync(dirConfigured);mkdirSync(dirProviderOnly);mkdirSync(dirEmpty);
writeFileSync(join(dirConfigured,'config.toml'),'model = "gpt-5.3"\nprovider = "openai"\nreasoning = "high"\n');
writeFileSync(join(dirProviderOnly,'config.toml'),'model = "gpt-5.3"\n');
const missingPath=join(work,'missing-rules.json');
const codexHomes={configured:dirConfigured,providerOnly:dirProviderOnly,empty:dirEmpty};
const NOW=1737240000000;

const codexAdapter={name:'codex',id:'codex-1',capabilities:['codex','write']};
const chatgptAdapter={name:'chatgpt',id:'chatgpt-1',capabilities:['browser','write']};
const zAdapter={name:'z',id:'z-1',capabilities:['browser']};
const ADAPTER_SETS=[
  [codexAdapter],
  [codexAdapter,chatgptAdapter],
  [chatgptAdapter,zAdapter],
];
const reg=(id,adapter,capabilities,extra={})=>({
  id,capabilities,runtime:{adapter,...(extra.provider?{provider:extra.provider}:{})},
  ...(extra.availability?{availability:extra.availability}:{}),
  routing:{...(extra.routing||{})},
});
const AGENT_SETS=[
  [],
  [reg('ag-codex','codex',['codex','write'])],
  [reg('ag-chatgpt','chatgpt',['browser'])],
];
const USAGE_SETS=[
  undefined,
  {providers:[{id:'openai',usage:{available:true,fiveHour:{usedPercent:42,windowMinutes:300,resetsAt:null},weekly:null},credits:null}],credits:[]},
  {browserWorkspace:{available:0,total:6},providers:[],credits:[]},
];
const EXCLUSION_SETS=[
  undefined,
  [],
  [{workerId:'w1'}],
  [{adapter:'codex'}],
  [{provider:'openai',model:'gpt-5'}],
  [{workerId:'',adapter:''}],
  [{workerId:'codex-1',adapter:'codex',provider:'openai',model:'gpt-5',profile:'p1'}],
  [{workerId:'ag-codex',adapter:'other',provider:undefined,model:undefined}],
];
const TASKS=[
  {adapter:'chatgpt',id:'t1'},
  {adapter:'chatgpt',id:'t1',chatgptThreadDelivery:true},
  {adapter:'chatgpt',id:'t1',chatgptThreadDelivery:'x'},
  {adapter:'chatgpt',id:'t1',workerRequirements:{runtime:'chatgpt'}},
  {adapter:'chatgpt',id:'t1',workerRequirements:{runtime:'codex'}},
  {adapter:'chatgpt',id:'t1',workerRequirements:{capabilities:['browser']}},
  {adapter:'z',id:'t2'},
  {adapter:'z',id:'t2',noStartFallback:true},
  {adapter:'z',id:'t2',noStartFallback:0},
  {adapter:'z',id:'t2',noStartFallback:null},
  {adapter:'script',id:'t3'},
  {adapter:'script',id:'t3',noStartFallback:{reason:'x'}},
  {adapter:'codex',id:'t4'},
];
function jsonable(value){
  if(typeof value==='string'){
    if(/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value))return '<iso>';
    if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))return '<uuid>';
    return value;
  }
  if(Array.isArray(value))return value.map(jsonable);
  if(value&&typeof value==='object')
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,jsonable(v)]));
  return value;
}
const cases=[];
for(const task of TASKS)for(const adapters of ADAPTER_SETS)
  for(const agents of AGENT_SETS)for(const usage of USAGE_SETS)
    for(const exclusions of EXCLUSION_SETS){
      const full={...task,...(exclusions===undefined?{}:{routingExclusions:exclusions})};
      cases.push({method:'routing',task:full,adapters,agents,usage});
      if(cases.length%5===0)cases.push({method:'persist',
        task:{...full,routingExclusions:exclusions},
        adapters,agents,usage,
        original:[undefined,{adapter:'chatgpt'},{adapter:'z',routing:{}},
          {adapter:'chatgpt',workerSelection:{workerId:'w9'},
            routing:{provider:'openai',model:'gpt-5',profile:'p'}},
          {adapter:'z',routing:{provider:'',model:'m'}}][cases.length%5],
        executionId:cases.length%2?'exec-1':null,
        classification:['platform_delivery_failed','start_ack_timeout'][cases.length%2],
        evidence:'WebHelm verified receipt missing',
        safeToReroute:cases.length%3!==0});
    }
for(const task of [
  {adapter:'chatgpt',id:'t1'},{adapter:'chatgpt',id:'t1',chatgptThreadDelivery:'x'},
  {adapter:'chatgpt',id:'t1',workerRequirements:{runtime:'chatgpt'}},
  {adapter:'chatgpt',id:'t1',workerRequirements:{capabilities:['browser']}},
  {adapter:'z',id:'t2'},{adapter:'z',id:'t2',noStartFallback:true},
  {adapter:'z',id:'t2',noStartFallback:0},{adapter:'script',id:'t3',noStartFallback:{reason:'x'}},
])
  for(const adapters of [ADAPTER_SETS[0],ADAPTER_SETS[1]])
    for(const agents of AGENT_SETS)
      for(const usage of USAGE_SETS.slice(0,2))
        for(const home of ['configured','providerOnly','empty'])
          for(const exclusions of [undefined,[{workerId:'codex-1'}]]){
            const full={...task,...(exclusions===undefined?{}:{routingExclusions:exclusions})};
            cases.push({method:'compatible',task:full,adapters,agents,usage,home});
            cases.push({method:'noStart',task:full,adapters,agents,usage,home});
          }
async function expected(f){
  if(f.method==='routing')
    return jsonable(codexFallbackRouting(f.task,f.adapters,f.agents,f.usage));
  if(f.method==='persist'){
    const task=structuredClone(f.task);
    persistChatGptPlatformFailure(task,f.original,f.executionId,
      f.classification,f.evidence,f.safeToReroute);
    return jsonable(task);
  }
  if(f.method==='compatible'){
    process.env.CODEX_HOME=codexHomes[f.home];
    return codexFallbackCompatible(f.task,f.adapters,f.agents,f.usage);
  }
  process.env.CODEX_HOME=codexHomes[f.home];
  const decision=await codexNoStartFallbackRoute(f.task,f.adapters,f.agents,f.usage);
  if(decision===null)return null;
  // Same normalization convention as the certified routeFacade differential.
  for(const path of ['routing','candidate.routing']){
    const route=path.split('.').reduce((acc,key)=>acc?.[key],decision);
    if(route){
      if('decidedAt' in route)route.decidedAt='NORMALIZED';
      delete route.decisionId;
    }
  }
  if(decision.selection&&'selectedAt' in decision.selection)
    decision.selection.selectedAt='NORMALIZED';
  if('audit' in decision)decision.audit=null;
  return jsonable(decision);
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
test('original Node/Rust chatgpt platform fallback differential',async()=>{
  const requests=cases.map(f=>({op:'certChatgptPlatformFallback',method:f.method,
    task:f.task,adapters:f.adapters,agents:f.agents,
    usage:f.usage===undefined?null:f.usage,nowMs:NOW,
    codexHome:codexHomes[f.home]||dirEmpty,missingPath:missingPath,
    original:f.original,executionId:f.executionId,
    classification:f.classification,evidence:f.evidence,
    safeToReroute:f.safeToReroute}));
  const expectedList=[];
  for(const f of cases)expectedList.push(await expected(f));
  const child=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:300000,
    input:requests.map(JSON.stringify).join('\n')+'\n',maxBuffer:64*1024*1024});
  assert.equal(child.status,0,child.stderr||String(child.error));
  const outputs=child.stdout.trim().split('\n').map(line=>{
    const parsed=JSON.parse(line);
    if(!parsed.ok)throw new Error('parity error: '+parsed.error);
    return jsonable(parsed.value);
  });
  assert.equal(outputs.length,cases.length);
  const failures=[];
  for(let i=0;i<cases.length;i++){
    const diff=firstDiff(expectedList[i],outputs[i]);
    if(!diff)continue;
    failures.push({i,method:cases[i].method,task:cases[i].task,
      home:cases[i].home,diff});
  }
  for(const f of failures.slice(0,10))console.log('FB_DIFF',f.i,f.method,
    f.home,JSON.stringify(f.task).slice(0,160),JSON.stringify(f.diff).slice(0,320));
  assert.deepEqual(failures.map(f=>f.i),[],
    `${failures.length} original Node/Rust fallback mismatches`);
  console.log('Verified',cases.length,'original Node/Rust fallback cases');
});
