// Exact Node/Rust stateful parity fixtures for src/workflow/effects.ts callback dispatch, receipt dedupe, key overrides, failures and structured observations.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
 CallbackWorkflowEffectHandler,WorkflowEffectExecutor,MemoryWorkflowEffectReceiptStore,
} from '../../dist/workflow/effects.js';
import {RelayObservability,collectObservations,setObservability} from '../../dist/observability.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const binary=resolve(root,'rust/target/debug/relay-rust2-parity');
let built=false;
function rust(req){
 if(!built){const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(build.status,0,build.stderr);built=true;}
 const run=spawnSync(binary,[],{input:JSON.stringify({op:'workflowEffectsScenario',...req})+'\n',encoding:'utf8',timeout:15000,maxBuffer:9*1024*1024});
 assert.equal(run.status,0,`${run.error}: ${run.stderr}`);
 return JSON.parse(run.stdout.trim());
}
function makeThrown(item,plain=false){
 if(item===undefined || item===null)return new Error('fixture rejected');
 if(plain||typeof item!=='object')return item;
 return Object.assign(new Error(item.message??''),item);
}
async function node(req){
 const trace=[],records=[];
 const observer=new RelayObservability(collectObservations(records),'debug');
 setObservability(observer);
 try{
  const handlers=(req.handlers??[]).map(desc=>{
   let count=0;
   const callback=async context=>{
    count++;
    trace.push({execute:desc.name,jobId:context.jobId,attempt:count});
    const failure=desc.behavior==='fail'||(desc.behavior==='failOnce'&&count===1);
    if(failure)throw makeThrown(desc.error,desc.errorIsError===false);
   };
   let key;
   if(desc.keyMode==='fixed')key=()=>desc.key;
   if(desc.keyMode==='job')key=context=>`job:${context.jobId}`;
   if(desc.keyMode==='empty')key=()=>'';
   return new CallbackWorkflowEffectHandler(desc.name,callback,key);
  });
  const receipt=new MemoryWorkflowEffectReceiptStore();
  for(const key of req.initialReceipts??[])await receipt.markCompleted(key);
  const hasFail=new Set(req.hasFailKeys??[]),markFail=new Set(req.markFailKeys??[]);
  const receipts={
   async has(key){if(hasFail.has(key))throw new Error('has receipt failed');return receipt.has(key)},
   async markCompleted(key){if(markFail.has(key))throw new Error('mark receipt failed');return receipt.markCompleted(key)},
  };
  let executor;
  try{executor=new WorkflowEffectExecutor(handlers,receipts)}catch(error){return {ok:false,error:error.message}}
  let onAttempts=0;
  const onOutcome=async outcome=>{
   trace.push({onOutcome:outcome.status,effect:outcome.effect});
   if(req.onOutcomeFail===outcome.status){
    onAttempts++;
    if(!req.onOutcomeFailOnce||onAttempts===1)throw new Error('onOutcome rejected');
   }
  };
  const rounds=[];
  for(const effects of req.steps??[]){
   try{rounds.push({ok:true,value:await executor.execute(effects,req.context,onOutcome)})}
   catch(error){rounds.push({ok:false,error:error.message})}
  }
  return {ok:true,value:JSON.parse(JSON.stringify({rounds,trace,records:records.map(record=>({...record,ts:'NORMALIZED'})),
    receipts:[...(receipt.completed)].sort()}))};
 }finally{setObservability(RelayObservability.silent())}
}
let seed=0x12bc88a9;
const rand=max=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max};
const select=items=>items[rand(items.length)];
const types=['effect.launchTask','effect.cancelActiveTasks','effect.mergePullRequest','effect.deliverLocalMerge','effect.cleanupJobWorktree'];
const scenarios=[
 {handlers:[],steps:[],context:{jobId:'1',transitionKey:'start'}},
 {handlers:[],steps:[['effect.launchTask']],context:{jobId:'1',transitionKey:'start'}},
 {handlers:[{name:'effect.launchTask'}],steps:[['effect.launchTask'],['effect.launchTask']],context:{jobId:'1',transitionKey:'start'}},
 {handlers:[{name:'effect.launchTask',behavior:'fail',error:{message:'rate limit reached',status:429}}],steps:[['effect.launchTask'],['effect.launchTask']],context:{jobId:'1',taskId:'2',transitionKey:'retry'}},
 {handlers:[{name:'effect.launchTask',behavior:'failOnce',error:{message:'transient network',status:503}}],steps:[['effect.launchTask'],['effect.launchTask'],['effect.launchTask']],context:{jobId:'1',taskId:'2',transitionKey:'retry'}},
 {handlers:[{name:'effect.launchTask',keyMode:'fixed',key:'same'},{name:'effect.cancelActiveTasks',keyMode:'fixed',key:'same'}],steps:[['effect.launchTask','effect.cancelActiveTasks'],['effect.cancelActiveTasks','effect.launchTask']],context:{jobId:'3',transitionKey:'same'}},
 {handlers:[{name:'effect.launchTask',keyMode:'empty'}],steps:[['effect.launchTask','effect.launchTask']],context:{jobId:'2',taskId:null,transitionKey:'t'}},
 {handlers:[{name:'effect.launchTask'}],steps:[['effect.launchTask']],context:{jobId:'2',transitionKey:'t'},onOutcomeFail:'completed'},
 {handlers:[{name:'effect.launchTask'}],steps:[['effect.launchTask']],context:{jobId:'2',transitionKey:'t'},onOutcomeFail:'completed',onOutcomeFailOnce:true},
 {handlers:[{name:'effect.launchTask'}],steps:[['effect.launchTask']],context:{jobId:'2',transitionKey:'t'},markFailKeys:['effect.launchTask:2:job:t']},
 {handlers:[{name:'effect.launchTask'}],steps:[['effect.launchTask']],context:{jobId:'2',transitionKey:'t'},hasFailKeys:['effect.launchTask:2:job:t']},
 {handlers:[{name:'effect.launchTask'},{name:'effect.launchTask'}],steps:[['effect.launchTask']],context:{jobId:'1',transitionKey:'x'}},
];
for(let i=0;i<750;i++){
 const selected=types.slice(0,1+rand(types.length));
 const handlers=selected.map(name=>({name,behavior:select(['ok','ok','fail','failOnce']),
  keyMode:select([undefined,'default','fixed','job','empty']),
  key:select(['same','receipt:1','',undefined]),
  error:select([{message:'rate limit',status:429},{message:'different definition',status:409},
       {message:'socket hang up'},'oops',null,{message:'object fail',headers:{'retry-after':'3'}}]),
  errorIsError:select([true,true,false]),
 }));
 const context={jobId:String(1+rand(5)),taskId:select([undefined,null,'t-1','t-2','']),transitionKey:select(['start','retry','reconcile'])};
 const steps=Array.from({length:1+rand(4)},()=>Array.from({length:rand(8)},()=>select([...selected,...selected,'effect.unregistered'])));
 const key=handlers[0].keyMode==='fixed'?handlers[0].key:handlers[0].keyMode==='empty'?'':handlers[0].keyMode==='job'?`job:${context.jobId}`:`${handlers[0].name}:${context.jobId}:${context.taskId??'job'}:${context.transitionKey}`;
 scenarios.push({handlers,steps,context,
   initialReceipts:select([[],[],key===undefined?[]:[key]]),
   onOutcomeFail:select([undefined,undefined,'completed','failed','deduplicated']),
   onOutcomeFailOnce:select([false,true]),
   hasFailKeys:select([[],[],[key]]),markFailKeys:select([[],[],[key]])});
}

test('stateful Workflow Effect callbacks, receipt ownership and observations match Node',async()=>{
 let checked=0;
 for(const scenario of scenarios){
  const expected=await node(scenario);
  const result=rust(scenario);
  assert.deepEqual(result,expected,`Workflow Effect scenario ${checked}: ${JSON.stringify(scenario).slice(0,650)}`);
  checked++;
 }
 console.log(`Verified ${checked} stateful Workflow Effect Node/Rust scenarios`);
});
