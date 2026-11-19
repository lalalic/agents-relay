// Original Node public Worker Router APIs except routeWorker covered in
// head_to_head_route_facades.mjs; no live runtime or accounts accessed.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {resolve} from 'node:path';
import * as src from '../../dist/worker-routing.js';
const root=resolve(import.meta.dirname,'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');
const now=1795000000000;
const a=[{workerId:'c',adapter:'codex',runtime:'codex',capabilities:['model','local_repo']},{workerId:'g',adapter:'chatgpt',runtime:'chatgpt',capabilities:['model'],browserWorkspaceCapacity:{available:1}},{workerId:'z',adapter:'z',runtime:'z',capabilities:['model']}];
const adapters=[{name:'codex',id:'c',capabilities:['model','local_repo']},{name:'chatgpt',id:'g',capabilities:['model']},{name:'z',id:'z',capabilities:['model']}];
const usages=[null, {providers:[],credits:[]}, {providers:[{id:'openai',usage:{available:true,fiveHour:{usedPercent:20,resetsAt:1796000000},weekly:{usedPercent:35,resetsAt:1797000000}}}],credits:[]},
 {providers:[],credits:[{id:'openai',credits:{balances:[{remaining:0},{remaining:3}]}}]}];
const cases=[{op:'certWorkerRouterPublic',action:'defaults'}];
for(const usage of usages)for(const provider of ['openai','chatgpt','z'])cases.push({op:'certWorkerRouterPublic',action:'usage',usage,provider,nowMs:now});
for(const registered of [[],[{id:'special',runtime:{adapter:'codex',provider:'openai',model:'gpt-test'},capabilities:['model','coding'],routing:{trustDomains:['local'],regions:['ca'],labels:{x:'y'}},availability:'available'}]]){
 cases.push({op:'certWorkerRouterPublic',action:'candidates',adapters,registered,nowMs:now});
}
for(let i=0;i<100;i++){
 const candidate={...a[i%3],availability:i%7?'available':'offline',browserWorkspaceCapacity:{available:i%8?2:0}};
 const requirements={capabilities:i%2?['model']:['local_repo'],...(i%5===0?{runtime:'codex'}:{})};
 const strict=i%2===0;
 cases.push({op:'certWorkerRouterPublic',action:'satisfies',candidate,requirements,strict});
 if(i%5===0)cases.push({op:'certWorkerRouterPublic',action:'eligible',candidates:[candidate,...a],requirements,strict});
 if(i%8===0)cases.push({op:'certWorkerRouterPublic',action:'select',candidates:i%3===0?[]:i%3===1?[a[1]]:a,requirements});
}
function normalize(v){if(Array.isArray(v))return v.map(normalize);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([,a])=>a!==undefined).map(([k,x])=>[k,k==='selectedAt'&&typeof x==='string'?'<clock>':normalize(x)]));
 return v;}
function node(q){try{
 let result;switch(q.action){
 case 'defaults':result={preferred:src.DEFAULT_CHATGPT_PREFERRED_CONCURRENCY,principles:src.DEFAULT_WORKER_ROUTER_PRINCIPLES};break;
 case 'usage':result=src.usageForProvider(q.usage??undefined,q.provider,q.nowMs);break;
 case 'candidates':result=src.workerCandidates(q.adapters,q.registered,undefined);break;
 case 'satisfies':result=src.satisfiesWorker(q.candidate,q.requirements,{strictCapabilities:q.strict});break;
 case 'eligible':result=src.eligibleWorkerCandidates(q.candidates,q.requirements,{strictCapabilities:q.strict});break;
 case 'select':result=src.selectWorker(q.candidates,q.requirements);break;
 }
 return {ok:true,value:normalize(result)};
 }catch(error){return {ok:false,error:error.message}}
}
test('all public Worker Router pure API functions in original Node/Rust cases',()=>{
 const expected=cases.map(node);
 const p=spawnSync(bin,[],{cwd:root,input:cases.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',timeout:65000,maxBuffer:10e6});
 assert.equal(p.status,0,p.stderr);
 const actual=p.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,cases.length);
 for(let i=0;i<actual.length;i++){
  if(actual[i].ok)actual[i].value=normalize(actual[i].value);
  assert.deepEqual(actual[i],expected[i],`Worker routing ${i}: ${JSON.stringify({actual:actual[i],expected:expected[i]})}`);
 }
 console.log(`PASS ${cases.length} original Node/Rust Worker Routing API fixtures`);
});
