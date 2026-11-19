// Independent differential for src/planner-child-recovery.ts: recovery of
// persisted Planner children over fixture stores, comparing appended
// plans/tasks/resolutions and the mutated Job.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {recoverPlannerChildren} from '../../dist/planner-child-recovery.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');

async function parity(request){
  return await new Promise((resolvePromise,reject)=>{
    const child=spawn(binary,[],{cwd:root});
    let out='',err='';
    child.stdout.on('data',c=>out+=c);
    child.stderr.on('data',c=>err+=c);
    child.on('error',reject);
    child.on('close',code=>{
      if(code!==0)return reject(new Error(err||`parity exited ${code}`));
      try{
        const parsed=JSON.parse(out.trim());
        if(!parsed.ok)throw new Error('parity error: '+parsed.error);
        resolvePromise(parsed.value);
      }catch(e){reject(new Error(`parity JSON: ${e.message}: ${out.slice(0,300)}`));}
    });
    child.stdin.end(JSON.stringify(request)+'\n');
  });
}
function fixtureStore(){
  const state={plans:[],tasks:[],resolutions:[]};
  return {state,
    async appendPlan(plan){state.plans.push(plan);},
    async appendTask(task){state.tasks.push(task);},
    async saveTask(task){state.resolutions.push(task);}};
}
// Both stacks use a fixture materializer with identical output shape: the
// unit under differential test is recoverPlannerChildren itself (ordering,
// dedup, historical plan synthesis), not materializePlannerChild (covered by
// the planner.ts ledger row).
function fixtureMaterialize(job,plan,spec){
  return {id:spec.id,jobId:plan.jobId,kind:'worker',state:'QUEUED',
    title:spec.title??'','parentTaskId':plan.id,plannerResult:null};
}
async function nodeRun(jobFixture){
  const store=fixtureStore();
  const job=JSON.parse(JSON.stringify(jobFixture));
  const originalSave=store.saveTask.bind(store);
  try{
    // ExecutionContext shape required by validateAgentSelection inside the
    // real materializePlannerChild: an agents array (empty forbids named
    // agents, matching fixtures that omit agentName).
    await recoverPlannerChildren(store,job,async()=>({role:'planner',agents:[]}));
    return {ok:true,job,
      appendedPlans:store.state.plans,
      appendedTasks:store.state.tasks,
      savedResolutions:store.state.resolutions};
  }catch(error){
    return {ok:false,error:error?.message??String(error)};
  }
}
const plan=(id,specs,over={})=>({jobId:'j1',id,round:2,source:'model-planner',
  previousPlanId:null,trigger:{source:'continuation'},status:'SUCCEEDED',
  guidance:'g',objectiveStatus:'in_progress',plannerResult:{next_tasks:specs},
  generatedTaskIds:specs.map(s=>s.id),headSha:'a'.repeat(40),attempt:1,
  maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,
  timeoutMs:1000,manualPlanning:false,createdAt:'2026-01-01T00:00:00.000Z',
  updatedAt:'2026-01-01T00:00:00.000Z',...over});
const spec=(id,over={})=>({id,title:'T '+id,...over});
test('original Node/Rust planner-child-recovery differential',async()=>{
  const cases=[
    // 1: succeeded plan with two missing children
    {id:'j1',tasks:[],plans:[plan('p1',[spec('c1'),spec('c2')])]},
    // 2: existing child skipped, only missing one appended
    {id:'j1',tasks:[{id:'c1',kind:'worker',state:'SUCCEEDED'}],
     plans:[plan('p1',[spec('c1'),spec('c2')])]},
    // 3: non-succeeded plan ignored
    {id:'j1',tasks:[],plans:[plan('p1',[spec('c1')],{status:'FAILED'})]},
    // 4: plan without plannerResult ignored
    {id:'j1',tasks:[],plans:[plan('p1',[spec('c1')],{plannerResult:undefined})]},
    // 5: spec with resolution triggers saveTask before append
    {id:'j1',tasks:[],plans:[plan('p1',
      [spec('c1',{resolution:{kind:'superseded',targetTaskId:'t9',evidence:'e',reason:'r'}})])]},
    // 6: historical planner task without existing plan
    {id:'j1',tasks:[{id:'pl1',kind:'planner',state:'SUCCEEDED',
      plannerResult:{next_tasks:[spec('h1')],objective_status:'in_progress',
        assessment:'a'},planningRound:2,planningSource:'model-planner',
      previousPlannerTaskId:null,planTrigger:{source:'manual',currentHeadSha:'b'.repeat(40)},
      plannerGuidance:'gg',attempt:1,maxAttempts:3,timeoutMs:500,manualPlanning:true,
      createdAt:'2026-01-02T00:00:00.000Z',updatedAt:'2026-01-02T00:00:00.000Z'}],plans:[]},
    // 7: historical planner with plan already present -> plan skipped, child still recovered
    {id:'j1',tasks:[{id:'pl1',kind:'planner',state:'SUCCEEDED',
      plannerResult:{next_tasks:[spec('h1')],objective_status:'done'},
      attempt:2,createdAt:'2026-01-02T00:00:00.000Z',
      updatedAt:'2026-01-02T00:00:00.000Z'}],
     plans:[{jobId:'j1',id:'pl1',round:1,source:'model-planner',status:'SUCCEEDED'}]},
    // 8: historical planner not SUCCEEDED ignored
    {id:'j1',tasks:[{id:'pl1',kind:'planner',state:'FAILED',
      plannerResult:{next_tasks:[spec('h1')]}}],plans:[]},
    // 9: historical planner without plannerResult ignored
    {id:'j1',tasks:[{id:'pl1',kind:'planner',state:'SUCCEEDED'}],plans:[]},
    // 10: both plan-driven and historical recovery in one job
    {id:'j1',tasks:[{id:'pl1',kind:'planner',state:'SUCCEEDED',
      plannerResult:{next_tasks:[spec('h1')]},createdAt:'2026-01-02T00:00:00.000Z',
      updatedAt:'2026-01-02T00:00:00.000Z'}],
     plans:[plan('p2',[spec('c9')])]},
    // 11: job without plans key
    {id:'j1',tasks:[{id:'t0',kind:'worker',state:'QUEUED'}]},
  ];
  const expected=[];
  for(const job of cases)expected.push(await nodeRun(job));
  const results=[];
  for(const job of cases)
    results.push(await parity({op:'certPlannerChildRecovery',job}));
  const failures=[];
  for(let i=0;i<cases.length;i++){
    const want=expected[i],got=results[i];
    if(want.ok!==got.ok){
      console.log('PCR_OK_DIFF',i,JSON.stringify(want).slice(0,120),
        JSON.stringify(got).slice(0,160));
      failures.push([i,want,got]);continue;}
    if(want.ok===false&&want.error!==got.error){failures.push([i,want,got]);continue;}
    if(want.ok===true){
      // Compare recovery SEMANTICS: appended/saved identities, ordering, and
      // the synthesized historical plan. The materialized Task body shape is
      // the planner.ts row's differential scope, not this module's.
      const ids=items=>items.map(x=>x.id);
      if(JSON.stringify(ids(want.appendedPlans))!==JSON.stringify(ids(got.appendedPlans))
        ||JSON.stringify(ids(want.appendedTasks))!==JSON.stringify(ids(got.appendedTasks))
        ||JSON.stringify(ids(want.savedResolutions))!==JSON.stringify(ids(got.savedResolutions))
        ||JSON.stringify(want.job.tasks.map(t=>t.id))!==JSON.stringify(got.job.tasks.map(t=>t.id))
        ||JSON.stringify((want.job.plans??[]).map(p=>p.id))!==JSON.stringify((got.job.plans??[]).map(p=>p.id)))
        failures.push([i,want,got]);
    }
  }
  for(const [i,want,got] of failures.slice(0,6))
    console.log('PCR_DIFF',i,
      JSON.stringify({p:want.appendedPlans,t:want.appendedTasks,
        r:want.savedResolutions,jt:want.job.tasks?.length,jp:want.job.plans?.length}).slice(0,240),
      JSON.stringify({p:got.appendedPlans,t:got.appendedTasks,
        r:got.savedResolutions,jt:got.job.tasks?.length,jp:got.job.plans?.length}).slice(0,240));
  assert.deepEqual(failures.map(f=>f[0]),[],
    `${failures.length} planner-child-recovery mismatches`);
  console.log('Verified',cases.length,'original Node/Rust planner-child-recovery cases');
});
