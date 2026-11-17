// Direct Node/Rust differential for src/workflow/action-ledger.ts: Graph-authorized SQLite reservations, execution leases and postcondition traces, never real Job state.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {DatabaseSync} from 'node:sqlite';
import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {WorkflowActionLedger} from '../../dist/workflow/action-ledger.js';import {ConditionRegistry,booleanCondition} from '../../dist/workflow/conditions.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let ready=false;
function rust(req){if(!ready){const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(build.status,0,build.stderr);ready=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:13000,maxBuffer:6*1024*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim());}
function node(req){try{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL)');
 for(const job of req.jobs)db.prepare('INSERT INTO job_snapshot VALUES(?,?)').run(job.id,JSON.stringify(job.value));
 const ledger=new WorkflowActionLedger(db),outputs=[];
 for(const op of req.operations){try{let value;
  switch(op.action){case 'reserve':value=ledger.reserve(op.identity,op.decision,op.conditionId);break;
  case 'running':value=ledger.reserveForRunningTask(op.identity,op.decision,op.conditionId,op.now,op.allowedState??'RUNNING');break;
  case 'dispatch':value=ledger.reserveForClaimedDispatch(op.identity,op.decision,op.conditionId);break;
  case 'trace':value=ledger.trace(op.attemptKey);break;
  case 'verify':{
   const registry=new ConditionRegistry(op.conditions.map(condition=>condition.kind==='boolean'?booleanCondition(condition.id):{id:condition.id,check:()=>condition.outcome}));
   value=ledger.verify(op.attemptKey,registry,op.facts);break;}
  default:throw new Error('invalid ledger action');
  }
  outputs.push({ok:true,value});
 }catch(error){outputs.push({ok:false,error:error.message})}}
 const traces=db.prepare('SELECT attempt_key,execution_id,generation,graph,action_id,condition_id,outcome FROM workflow_action_trace ORDER BY attempt_key').all()
  .map(row=>({attemptKey:row.attempt_key,executionId:row.execution_id,generation:row.generation,graph:row.graph,actionId:row.action_id,conditionId:row.condition_id,outcome:row.outcome}));
 db.close();return {ok:true,value:{outputs,traces}};
 }catch(error){return {ok:false,error:error.message}}}
function normalize(result){if(!result.ok)return result;
 const data=result.value;return {ok:true,value:{...data,outputs:data.outputs.map(item=>item.ok&&item.value&&typeof item.value==='object'&&'observedAt'in item.value?{...item,value:Object.fromEntries(Object.entries(item.value).filter(([k])=>k!=='observedAt'))}:item)}};
}
let seed=0x8317adac;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;},pick=a=>a[rand(a.length)];
const NOW='2026-11-17T04:00:00.000Z',FUTURE='2026-11-17T06:00:00.000Z',PAST='2026-11-17T02:00:00.000Z';
const cases=[];
for(let i=0;i<410;i++){
 const identity={jobId:'job',taskId:'task',attempt:2,generation:2,executionId:'exec',leaseOwner:'relay',graph:'task-lifecycle.mmd',actionId:'effect.launchTask',attemptKey:'k'+i};
 const decision={accepted:true,source:'QUEUED',target:'QUEUED',actions:[{id:'effect.launchTask'}]};
 const task={id:'task',state:pick(['RUNNING','QUEUED','FAILED']),attempt:pick([1,2,2]),executionId:pick(['exec','old']),leaseOwner:pick(['relay','old']),
  leaseExpiresAt:pick([FUTURE,PAST,'invalid']),executionHistory:pick([[{id:'exec',attempt:2}],[],[{id:'other',attempt:2}]])};
 const job={tasks:[task],pause:pick([undefined,undefined,{generation:1}])};
 const operations=[];
 for(let j=0;j<1+rand(8);j++){
  const action=pick(['reserve','running','trace','verify','dispatch']);
  operations.push({action,identity:{...identity,...pick([{}, {}, {attemptKey:'same-key'}, {actionId:'effect.other'}, {executionId:'old'}])},
   decision:pick([decision,decision,{...decision,accepted:false},{...decision,actions:[{id:'other'}]}]),conditionId:'condition',now:NOW,
   allowedState:pick(['RUNNING','QUEUED']),attemptKey:pick([identity.attemptKey,'same-key','no-reservation']),
   conditions:[{id:'condition',kind:'boolean'}],facts:{condition:pick([true,false,undefined])}});
 }
 cases.push({op:'actionLedgerScenario',jobs:[{id:'job',value:job}],operations});
}
test('atomic action reservation and Graph postcondition updates match Node without side effects',()=>{
 for(const [i,req] of cases.entries()){
  assert.deepEqual(normalize(rust(req)),normalize(node(req)),`Ledger scenario ${i}: ${JSON.stringify(req).slice(0,560)}`);
 }
 console.log(`Verified ${cases.length} Node/Rust SQLite workflow action ledger histories`);
});
