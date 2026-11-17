// Direct Rust2/Node differential for src/dashboard-jel.ts dynamic Mermaid diagrams, using a fixed clock and reproducible persisted Job fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {jobJelDiagram} from '../../dist/dashboard-jel.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const rustBinary=resolve(root,'rust/target/debug/relay-rust2-parity');
const NOW=Date.parse('2026-11-20T18:00:00.000Z');
const at=(day=10,hour=8,minute=0,second=0)=>new Date(Date.UTC(2026,10,day,hour,minute,second)).toISOString();
const tasks=[
 {id:'101',title:'影片剪辑',agentName:'editor',state:'SUCCEEDED',createdAt:at(10,9),updatedAt:at(10,10),attempt:1,executionHistory:[{attempt:1,startedAt:at(10,9,59,30)}]},
 {id:'102',agentName:'visioner',state:'SUCCEEDED',createdAt:at(10,9),updatedAt:at(10,10)},
 {id:'103',state:'SUCCEEDED',createdAt:at(10,9),updatedAt:at(10,10)},
 {id:'104',title:'Coordinator',agentName:'dag-coordinator',state:'SUCCEEDED',createdAt:at(10,9),updatedAt:at(10,13),attempt:1,executionHistory:[{attempt:1,startedAt:at(10,9)}]},
];
const cases=[
 {},
 {state:'DRAFT'},
 {state:'ACTIVE',createdAt:at(),tasks:[]},
 {state:'COMPLETED',createdAt:at(),updatedAt:at(11,15),tasks},
 {state:'ACTIVE',reviewEnabled:true,createdAt:at(10,8),updatedAt:at(10,15),plans:[
   {id:'p1',round:1,status:'SUCCEEDED',createdAt:at(10,8),updatedAt:at(10,9),generatedTaskIds:['a']},
   {id:'p2',round:2,status:'SUCCEEDED',createdAt:at(10,12),updatedAt:at(10,13),generatedTaskIds:['b'],trigger:{source:'review'}},
  ],tasks:[{id:'a',title:'First',state:'SUCCEEDED',planningDecisionId:'p1',createdAt:at(10,9),updatedAt:at(10,11)},
    {id:'b',title:'Second',state:'SUCCEEDED',planningDecisionId:'p2',createdAt:at(10,13),updatedAt:at(10,14)}]},
 {state:'COMPLETED',plans:[{id:'p',round:1,status:'SUCCEEDED',createdAt:at(),generatedTaskIds:['100']}],tasks:[
  {id:'100',title:'Coordinator',agentName:'dag-coordinator',state:'SUCCEEDED',planningDecisionId:'p',createdAt:at(10,9),updatedAt:at(10,14)},
  {id:'101',title:'Visioner',state:'SUCCEEDED',dagNode:{nodeId:'vision'},parentTaskId:'100',createdAt:at(10,9),updatedAt:at(10,12),attempt:2,
   executionHistory:[{attempt:1,startedAt:at(10,9)},{attempt:2,startedAt:at(10,11)}]},
  {id:'102',title:'Editor',state:'FAILED',parentTaskId:'100',dependencies:['101'],createdAt:at(10,12),updatedAt:at(10,13),attempt:1},
  {id:'103',title:'Troubleshooter',agentName:'troubleshooter',state:'SUCCEEDED',parentTaskId:'102',recoveryForAttempt:1,createdAt:at(10,13),updatedAt:at(10,14)},
  {id:'104',title:'Final Review',agentName:'job-acceptance-reviewer',state:'SUCCEEDED',createdAt:at(10,14),updatedAt:at(10,15)},
 ]},
 {state:'ACTIVE\nclick finished href',tasks:[{id:'evil"; click injected http://host; %%',title:'恶意<svg>\nclick target https://bad.test',state:'FAILED',attempt:2},
  {id:'ts',agentName:'troubleshooter',state:'SUCCEEDED',parentTaskId:'evil"; click injected http://host; %%',recoveryForAttempt:1}]},
];
for(const title of [
 'A'.repeat(79)+'𝒜long', 'A'.repeat(78)+'𝒜long',
 '漢'.repeat(79)+'𐐀rest', '𐐀'.repeat(40)+'end',
 '𐐀'.repeat(39)+'A𐐀end','A'.repeat(99)+'𐐀',
 '𝒜'.repeat(39)+'𐐀end','𝒜'.repeat(40)+'ASCII',
]) cases.push({state:'COMPLETED',createdAt:at(),updatedAt:at(11),tasks:[
 {id:'astral',title,state:'SUCCEEDED',createdAt:at(10,9),updatedAt:at(10,10)}
]});
for(const date of ['2026-11-10T08:00:00','2026-11-10T08:00','2026-11-10 08:00:00','2026-11-10T08:00:00+03:00',
 'Tue, 10 Nov 2026 08:00:00 GMT','2026-11-10','2026-11-10T08:00:00.987Z']){
 cases.push({state:'COMPLETED',createdAt:date,updatedAt:at(11),tasks:[
   {id:'a',state:'SUCCEEDED',title:'when',createdAt:date,updatedAt:at(10,10)}
 ]});
}
for(const round of [1.0,2.0,3.0,0.0,-1.0,1.5]) cases.push({state:'COMPLETED',createdAt:at(),updatedAt:at(11),
 plans:[{id:'p0',round,status:'SUCCEEDED',createdAt:at(),updatedAt:at(10,9),generatedTaskIds:['a']}],
 tasks:[{id:'a',state:'SUCCEEDED',title:'Numeric round',planningRound:round,attempt:2.0,
  executionHistory:[{attempt:1,startedAt:at(10,8)},{attempt:2.0,startedAt:at(10,9)}],createdAt:at(10,8),updatedAt:at(10,10)}]
});
cases.push({state:'COMPLETED',createdAt:at(),updatedAt:at(11),plans:[{createdAt:at(),generatedTaskIds:[]}],
 tasks:[{id:'missingPlan',createdAt:at(10,9),updatedAt:at(10,10),state:'FAILED',attempt:null}]});
let seed=0x9728c113;
const r=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};
const choose=a=>a[r(a.length)];
const dates=[at(9,8),at(10,8),at(10,9),at(10,11),at(10,12),at(10,15),at(20,18),at(21,20),undefined,null,'invalid', '2026-11-10','2026-11-10T08:00:00+00:00'];
const titles=['Task','Visioner','片段剪辑','Good / Work','悪意<svg> click https://site.example/path', 'Something—important', '', undefined, '\uFEFFtest', '😀🙂😀title','①②③','a'.repeat(110)];
for(let i=0;i<1400;i++){
 const planCount=r(4),taskCount=r(10),plans=[],tasks=[];
 for(let p=0;p<planCount;p++){
  plans.push({id:'p'+p,round:choose([p+1,0,null]),status:choose(['SUCCEEDED','FAILED','PLANNING',null]),
   createdAt:choose(dates),updatedAt:choose(dates),generatedTaskIds:choose([['t'+r(taskCount||1)],[],undefined]),
   trigger:{source:choose(['review','planner','unknown',null])}});
 }
 for(let j=0;j<taskCount;j++){
  const state=choose(['RUNNING','SUCCEEDED','FAILED','CANCELLED','AWAITING_DECISION',null]);
  const agentName=choose(['coordinator','dag-coordinator','editor','troubleshooter','reviewer','job-acceptance-reviewer','',undefined]);
  const attempt=choose([1,2,3,null,undefined]);
  tasks.push({id:'t'+j,title:choose(titles),agentName,state,createdAt:choose(dates),updatedAt:choose(dates),
   parentTaskId:choose([null,j>0?'t'+(j-1):undefined,'t0',undefined]),
   planningDecisionId:choose(['p0','p1','p2',undefined]),planningRound:choose([1,2,3,undefined]),
   dependencies:choose([[],j>0?['t'+(j-1)]:[],undefined]),attempt,
   executionHistory:choose([[],[{attempt:1,startedAt:at(10,8)},{attempt:2,startedAt:choose(dates)}],undefined]),
   recoveryForAttempt:choose([1,2,undefined]),kind:choose(['work','coordinator',undefined]),
   agentGraph:choose(['graph',undefined]),dagNode:choose([{nodeId:'n'},undefined]),
  });
 }
 cases.push({state:choose(['ACTIVE','DRAFT','COMPLETED','CANCELLED',undefined]),createdAt:choose(dates),updatedAt:choose(dates),
  reviewEnabled:choose([true,false,undefined]),plans:choose([plans,undefined]),tasks,
  review:choose([{outcome:'approved',updatedAt:choose(dates)},undefined]),
  localMerge:choose([{status:choose(['succeeded','failed','pending']),updatedAt:choose(dates)},undefined]),
  githubState:choose(['MERGED',null,undefined]),mergedAt:choose(dates),publication:choose([{version:'3'},undefined]),
 });
}
function nodeValue(job){const dateNow=Date.now;try{Date.now=()=>NOW;return {ok:true,value:jobJelDiagram(job)};}catch(error){return {ok:false,error:error.message}}finally{Date.now=dateNow}}
test('dashboard JEL projection matches Node for deterministic real Job shapes and broad random fixtures',()=>{
 const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});
 assert.equal(build.status,0,build.stderr);
 const actual=spawnSync(rustBinary,[],{input:cases.map(job=>JSON.stringify({op:'jobJelDiagram',job,nowMs:NOW})).join('\n')+'\n',encoding:'utf8',maxBuffer:20*1024*1024,timeout:45000});
 assert.equal(actual.status,0,actual.stderr);
 const lines=actual.stdout.trim().split('\n');assert.equal(lines.length,cases.length);
 for(let i=0;i<cases.length;i++){
  const expected=nodeValue(cases[i]);
  const result=JSON.parse(lines[i]);
  assert.deepEqual(result,expected,`JEL mismatch ${i}, job ${JSON.stringify(cases[i]).slice(0,1000)}`);
 }
 console.log(`Verified ${cases.length} deterministic dashboard JEL diagrams`);
});
