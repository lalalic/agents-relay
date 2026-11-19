// All six public src/execution-routing.ts exports; no live provider, policy or Relay state.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import * as original from '../../dist/execution-routing.js';
const root=resolve(import.meta.dirname,'../..'), bin=join(root,'rust/target/debug/relay-rust2-parity');
const dir=mkdtempSync('/tmp/r2route-'),policyPath=join(dir,'policy.json'),rulesPath=join(dir,'rules.md');
const prev=process.env.CODEX_HOME;process.env.CODEX_HOME=dir;
test.after(()=>{if(prev===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=prev;rmSync(dir,{recursive:true,force:true});});
const work=[{workerId:'codex',adapter:'codex',runtime:'codex',capabilities:['model','coding','filesystem'],availability:'available'},
 {workerId:'chatgpt',adapter:'chatgpt',runtime:'chatgpt',capabilities:['model','vision'],availability:'available'},
 {workerId:'z',adapter:'z',runtime:'z',capabilities:['model'],availability:'offline'}];
let seed=0xa74f81;function rand(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}const choose=a=>a[rand()%a.length];
const cases=[{action:'principles'}];
for(let i=0;i<250;i++){
 const nested={storySize:choose(['S','M','L','X',null]),input:choose(['final review of the vision result','generate an image','coding task','视觉审核',''])};
 const facts={...(i%2?{task:nested}:nested),...(i%5===0?{storySize:null}:{}),...(i%7===0?{taskCapabilities:['coding','vision']}:{}),...(i%11===0?{capabilities:['model','vision']}:{}),...(i%13===0?{title:'图像理解'}:{})};
 cases.push({action:'shape',taskFacts:facts},{action:'capabilities',taskFacts:facts});
}
for(let i=0;i<45;i++){
 const worker=choose(work);const model=choose([{provider:'openai',model:'gpt-6',reasoning:'high'}, {provider:'openai',model:'test-model'}, {provider:'z',model:'z-model',reasoning:null}]);
 cases.push({action:'label',route:{worker,model},isDefault:i%2===0});
}
for(let i=0;i<45;i++){
 const workers=work.slice(0,1+i%3),requirements=choose([{}, {runtime:'codex'},{runtime:'chatgpt'},{capabilities:['model']},{runtime:'missing'}]);
 const options={policyPath,rulesPath,registered:[],decisionMode:'off',routingConstraints:choose([{}, {provider:'openai'},{model:'unknown'}]),excludedRoutes:[]};
 cases.push({action:'discover',workers,requirements,options,home:dir,policyPath,rulesPath,nowMs:1795000000000});
}
function invoke(requests){const p=spawnSync(bin,[],{cwd:root,input:requests.map(x=>JSON.stringify({op:'certExecutionRouterPublic',...x})).join('\n')+'\n',encoding:'utf8',maxBuffer:9e6,timeout:65000});assert.equal(p.status,0,p.stderr);return p.stdout.trim().split('\n').map(JSON.parse);}
async function node(c){try{
 let value;
 switch(c.action){
  case 'shape':value=original.executionTaskShape(c.taskFacts);break;
  case 'capabilities':value=original.taskCapabilityFacts(c.taskFacts);break;
  case 'principles':value=[...original.EXECUTION_ROUTING_PRINCIPLES];break;
  case 'label':value=original.executionChoiceLabel(c.route,c.isDefault);break;
  case 'discover':value=await original.discoverExecutionRoutes(c.workers,c.requirements,c.options);break;
  default:throw Error('Unknown action');
 }
 return {ok:true,value:JSON.parse(JSON.stringify(value))};
 }catch(e){return {ok:false,error:e.message};}}
test('original Node/Rust exact execution router public Task facts and route discovery',async()=>{
 const rust=invoke(cases);
 for(let i=0;i<cases.length;i++){
  const expected=await node(cases[i]);
  assert.deepEqual(rust[i],expected,`Execution Router fixture ${i}: ${JSON.stringify(cases[i]).slice(0,350)}`);
 }
 console.log(`${cases.length} original Node/Rust route facts and discoveries match`);
});
