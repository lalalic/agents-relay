// Production actionVerification Node/Rust parity using independent :memory: SQLite snapshots,
// opaque action attempts, observed postconditions and durable atomic outbox replay.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {dirname,resolve,join} from 'node:path';import {fileURLToPath} from 'node:url';
import {parseGraphV2,GraphRuntime} from '../../dist/workflow/graph-v2.js';
import {dispatchWorkflowGraph} from '../../dist/workflow/dispatcher.js';
import {WorkflowActionLedger} from '../../dist/workflow/action-ledger.js';
import {DurableWorkflowPublication} from '../../dist/workflow/durable-publication.js';
import {ConditionRegistry,booleanCondition} from '../../dist/workflow/conditions.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');const binary=join(root,'rust/target/debug/relay-rust2-parity');let ready=false;
function rust(req){if(!ready){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);ready=true;}
 const r=spawnSync(binary,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:12000,maxBuffer:7*1024*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim());}
function runtimeFromSource(source){const graph=parseGraphV2(source);const states=new Set(),actions={},events={},guards={};
 for(const node of graph.nodes.values()){
  if(node.kind==='state')states.add(node.semanticId);
  if(node.kind==='action')actions[node.semanticId]={id:node.semanticId};
  if(node.kind==='emit')events[node.semanticId]={id:node.semanticId};
  if(node.kind==='guard')guards[node.semanticId]=ctx=>ctx.durableFacts[node.semanticId]===true;
 }
 for(const edge of graph.edges){if(edge.kind==='on')events[edge.semanticId]={id:edge.semanticId};if(edge.kind==='request')actions[edge.semanticId]={id:edge.semanticId};}
 return new GraphRuntime(graph,{states,actions,events,guards});
}
async function node(req){
 try{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE job_snapshot (job_id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE projected (state TEXT NOT NULL); INSERT INTO projected VALUES (\'ACTIVE\')');
  db.prepare('INSERT INTO job_snapshot VALUES(?,?)').run(req.job.id,JSON.stringify(req.job));
  const ledger=new WorkflowActionLedger(db),conditions=new ConditionRegistry([booleanCondition('merged')]);
  const publication=req.hasPublication===false?undefined:new DurableWorkflowPublication(db);
  const executed=[],events=[],outputs=[];
  const runtime=runtimeFromSource(req.source);
  for(let i=0;i<(req.calls??2);i++){
   const options={initialState:req.initialState,input:req.input,durableFacts:req.facts,maxSteps:1,observe:false,
    executeAction:action=>{executed.push(action);if(req.actionErrors?.[action])throw Error(req.actionErrors[action]);return req.receipts?.[action]??{};},
    actionVerification:{ledger,conditions,publication,identity:action=>({...req.identity,actionId:action}),conditionId:()=> 'merged',observedFacts:()=>req.observed??{},
      persistSqliteTransition:req.hasPersist===false?undefined:(from,to)=>db.prepare('UPDATE projected SET state=?').run(to)},
    publishEvent:req.hasPublisher===false?undefined:(id,payload)=>{
      if(req.publishError)throw Error('fixture publish failed');events.push({id,payload});
    }};
   try{outputs.push({ok:true,value:await dispatchWorkflowGraph(runtime,options)});}
   catch(error){outputs.push({ok:false,error:error.message});}
  }
  const trace=ledger.trace(req.identity.attemptKey)?.outcome??null;
  const state=db.prepare('SELECT state FROM projected').get().state;
  const pending=publication?.pending()??[];
  db.close();
  return {ok:true,value:{outputs,trace,state,pending,actions:executed,events}};
 }catch(error){return {ok:false,error:error.message}}
}
const sourceEffect='flowchart LR\n%% relay: initial start\na["state: ACTIVE"]\nb["state: COMPLETED"]\neffect["action: effect.process"]\na -->|on: approved| effect\neffect -->|to: COMPLETED| b';
const sourceEmit='flowchart LR\n%% relay: initial start\na["state: ACTIVE"]\nb["state: COMPLETED"]\neffect["action: effect.process"]\ne["emit: ready"]\na -->|on: approved| effect\neffect -->|emit: ready| e\neffect -->|to: COMPLETED| b';
const sourceNoAction='flowchart LR\n%% relay: initial start\na["state: ACTIVE"]\nb["state: COMPLETED"]\na -->|on: approved| b';
let seed=0x4100712d;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};const pick=xs=>xs[rand(xs.length)];
const cases=[];
for(let i=0;i<280;i++){
 const id={jobId:'j',taskId:'t',leaseOwner:'owner',attempt:1,generation:1,executionId:'exec-1',attemptKey:`e1/g1/action-${i}`,
  graph:'job-lifecycle.mmd',actionId:'effect.process'};
 const job={id:'j',state:'ACTIVE',tasks:[{id:'t',state:pick(['RUNNING','RUNNING','RUNNING','QUEUED','FAILED']),executionId:pick(['exec-1','exec-1','old']),
  leaseOwner:pick(['owner','owner','other']),attempt:pick([1,1,2]),executionHistory:pick([[{id:'exec-1',attempt:1}],[],[{id:'old',attempt:1}]]),
  leaseExpiresAt:pick(['2099-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'])}]};
 const receipts={'effect.process':pick([{ok:true},{ok:true,payloads:{ready:{fixture:i}}},{ok:false,failureEvent:{id:'ready',payload:{fixture:i}}},{}])};
 const req={op:'workflowVerifiedDispatcherScenario',source:pick([sourceEffect,sourceEmit,sourceNoAction]),
  initialState:pick(['ACTIVE','ACTIVE','UNKNOWN']),input:{transport:'event',id:pick(['approved','approved','unknown']),payload:{}},
  identity:id,job,calls:pick([1,2,3]),observed:pick([{merged:true},{merged:false},{},{}]),receipts,
  hasPublication:pick([true,true,false]),hasPersist:pick([true,true,false]),hasPublisher:pick([true,true,false]),publishError:rand(9)===0,
  actionErrors:i%37===0?{'effect.process':'fixture action failed'}:{}};
 cases.push(req);
}
test('verified Graph effects are leased, postcondition-checked and atomically committed to outbox; never retried blindly',async()=>{
 for(const [i,req] of cases.entries()){
  const input=JSON.parse(JSON.stringify(req));
  assert.deepEqual(rust(input),await node(input),`verified Graph fixture ${i}: ${JSON.stringify(input).slice(0,680)}`);
 }
 console.log(`Verified ${cases.length} Node/Rust immutable execution/lease, postcondition, receipt and outbox histories`);
});
