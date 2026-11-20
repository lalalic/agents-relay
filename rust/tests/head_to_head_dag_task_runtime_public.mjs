// Independent differential for src/dag-task-runtime.ts: predicates,
// reconcileDAGTasks (wave materialization, dependency gating, predecessor
// outputs, coordinator lifecycle) and selectDAGReviewExecutors over real
// Graph fixtures on both stacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {unifiedDAG,dagCoordinator,reconcileDAGTasks,selectDAGReviewExecutors}
  from '../../dist/dag-task-runtime.js';

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
const GRAPH=`dag:
  - id: n1
    agent: worker-a
  - id: n2
    agent: worker-b
edges:
  - from: n1
    to: n2
`;
const LINEAR_GRAPH=`dag:
  - id: a
    agent: alpha
  - id: b
    agent: beta
edges:
  - from: a
    to: b
`;
const GRAPH_HASH=createHash('sha256').update(GRAPH).digest('hex');
const HASH_LINEAR=createHash('sha256').update(LINEAR_GRAPH).digest('hex');
function fixtureStore(initialJob){
  // Minimal mutateJob store: mutate a candidate snapshot (matching the Rust
  // candidate-snapshot semantics), persisting nothing.
  let job=JSON.parse(JSON.stringify(initialJob));
  return {
    get job(){return job;},
    set job(value){job=value;},
    async load(){return JSON.parse(JSON.stringify(job));},
    async mutateJob(_id,mutate){
      const candidate=JSON.parse(JSON.stringify(job));
      const next=mutate(candidate);
      job=next;
      return next;
    },
  };
}
async function nodeReconcile(jobFixture,projectLayout){
  // projectLayout: optional {agents:{name:true}} — real marker files in the
  // project agents dir so discoverScriptAgent resolves identically on both
  // stacks (Rust is_script reads the same layout through its roots Value).
  const storeDir=mkdtempSync(join(tmpdir(),'rust2-dag-n-'));
  const store=fixtureStore(jobFixture);
  const cwd=join(storeDir,'project');
  mkdirSync(cwd,{recursive:true});
  if(projectLayout){
    mkdirSync(join(cwd,'agents'),{recursive:true});
    for(const name of Object.keys(projectLayout))
      writeFileSync(join(cwd,'agents',`${name}.agent.md`),'# agent');
  }
  try{
    await reconcileDAGTasks({store,jobId:jobFixture.id,
      cwdForTask:async()=>cwd,
      roots:{workspaceRoot:null,globalRoot:null}});
    return {ok:true,job:store.job};
  }catch(error){
    return {ok:false,error:error?.message??String(error)};
  }finally{
    rmSync(storeDir,{recursive:true,force:true});
  }
}
function normalizeNode(job){
  job=JSON.parse(JSON.stringify(job));
  for(const task of job.tasks??[]){
    if(typeof task.id==='string'&&task.id.startsWith('dag:')){
      task.id=`<dag-id:${task.dagNode.parentTaskId}/${task.dagNode.nodeId}/${task.agentName}>`;
    }
    task.createdAt='<now>';task.updatedAt='<now>';
    if(task.output?.path)task.output.path=
      task.output.path.split('.dag-node-results').pop();
  }
  return job;
}
function dagInputs(job){
  const out=[];
  for(const task of job.tasks??[]){
    if(typeof task.input==='string'&&task.input.includes('relay-dag-task')){
      const parsed=JSON.parse(task.input);
      if(parsed.outputPath)parsed.outputPath=
        parsed.outputPath.split('.dag-node-results').pop();
      parsed.taskId='<dag-id>';
      out.push(parsed);
    }
  }
  return out;
}
test('original Node/Rust dag-task-runtime differential',async()=>{
  const graphHash=s=>createHash('sha256').update(s).digest('hex');
  const cases=[];
  // predicates
  const predicateTasks=[
    {agentGraph:GRAPH},
    {agentGraph:GRAPH,result:{data:{dag:{version:1,graphHash:'x'}}}},
    {agentGraph:GRAPH,result:{data:{dag:{version:2,graphHash:'x'}}}},
    {},
    {result:{data:{dag:{version:1,graphHash:'x'}}}},
  ];
  // reconcile cases
  const activeJob=(tasks,extra={})=>({id:'j1',repository:'owner/repo',
    state:'ACTIVE',pause:false,tasks,plans:[],...extra});
  const dagParent=(state,over={})=>({id:'p1',state,title:'T',
    agentGraph:GRAPH,input:'plain markdown',
    output:{kind:'file',path:null},...over});
  const checkpoint=hash=>({data:{dag:{version:1,graphHash:hash}}});
  const graphHashOf=GRAPH_HASH;
  const coordinatorParent=()=>dagParent('RUNNING',
    {result:checkpoint(graphHashOf)});
  cases.push({method:'reconcile',job:activeJob([dagParent('QUEUED')])});
  cases.push({method:'reconcile',
    job:activeJob([dagParent('RUNNING',
      {result:{summary:'DAG coordinator',...checkpoint(graphHashOf)}})])});
  cases.push({method:'reconcile',job:activeJob([dagParent('SUCCEEDED')])});
  cases.push({method:'reconcile',
    job:activeJob([dagParent('RUNNING',{result:checkpoint('different')})])});
  cases.push({method:'reconcile',
    job:activeJob([coordinatorParent()],{state:'PAUSED'})});
  // dependency gating: n1 child created, n2 waits for n1 SUCCEEDED
  // (single reconcile pass materializes wave 1 only)
  cases.push({method:'reconcile',job:activeJob([coordinatorParent()])});
  // predecessor output propagation: n1 SUCCEEDED with structured result
  const succeededChild=(nodeId,over={})=>({id:`child-${nodeId}`,
    state:'SUCCEEDED',dagNode:{parentTaskId:'p1',nodeId,
      graphHash:graphHashOf,executor:'model'},
    result:{data:{status:'COMPLETED',output:{value:42}}},
    ...over});
  cases.push({method:'reconcile',
    job:activeJob([coordinatorParent(),succeededChild('n1')])});
  // dependency missing structured result -> error
  cases.push({method:'reconcile',
    job:activeJob([coordinatorParent(),
      succeededChild('n1',{result:{data:{status:'RUNNING'}}})])});
  // JSON parent input spreads into the child input
  cases.push({method:'reconcile',
    job:activeJob([dagParent('RUNNING',
      {input:JSON.stringify({foo:'bar',reviewDecision:'x',jobId:'j1'}),
       result:checkpoint(graphHashOf)})])});
  // script executor resolution over a real project agents layout
  cases.push({method:'reconcile',projectLayout:{'worker-a':true},
    job:activeJob([dagParent('RUNNING',{agentGraph:LINEAR_GRAPH,
      result:checkpoint(HASH_LINEAR)})])});
  // selectDAGReviewExecutors cases
  const scriptTask=(over={})=>({id:'s1',state:'QUEUED',executionId:null,
    dagNode:{parentTaskId:'p1',nodeId:'n1',graphHash:'h',executor:'script'},
    adapter:'script',capabilities:['script'],input:'{}',...over});
  cases.push({method:'selectReview',job:activeJob([scriptTask()])});
  cases.push({method:'selectReview',job:activeJob([scriptTask(
    {interactiveInvocation:{status:'changes_requested',feedback:'tighten',
      comments:['c1']}})])});
  cases.push({method:'selectReview',job:activeJob([scriptTask(
    {interactiveInvocation:{status:'approved'}})])});
  cases.push({method:'selectReview',job:activeJob([scriptTask(
    {dagNode:{parentTaskId:'p1',nodeId:'n1',graphHash:'h',executor:'model'}})])});
  cases.push({method:'selectReview',
    job:{...activeJob([scriptTask()]),state:'PAUSED'}});
  cases.push({method:'selectReview',job:activeJob([scriptTask(
    {executionId:'ex-1'})])});

  const expected=[];
  for(const fixture of cases){
    if(fixture.method==='reconcile'){
      expected.push(await nodeReconcile(fixture.job,fixture.projectLayout));
    }else if(fixture.method==='selectReview'){
      const store=fixtureStore(fixture.job);
      try{
        await selectDAGReviewExecutors(store,'j1');
        expected.push({ok:true,job:store.job});
      }catch(error){
        expected.push({ok:false,error:error?.message??String(error)});
      }
    }
  }
  const predicateExpected=predicateTasks.map(task=>({
    ok:true,unifiedDag:unifiedDAG({},task),
    dagCoordinator:dagCoordinator(task)}));
  const predicateResults=[];
  for(const task of predicateTasks)
    predicateResults.push(await parity({op:'certDagTaskRuntime',
      method:'predicates',task}));

  const results=[];
  for(const fixture of cases){
    if(fixture.method==='reconcile'){
      results.push(await parity({op:'certDagTaskRuntime',method:'reconcile',
        job:fixture.job,
        scriptAgents:Object.keys(fixture.projectLayout??{})}));
    }else{
      results.push(await parity({op:'certDagTaskRuntime',
        method:'selectReview',job:fixture.job}));
    }
  }
  const failures=[];
  for(let i=0;i<predicateExpected.length;i++){
    const want=predicateExpected[i],got=predicateResults[i];
    if(JSON.stringify(want)!==JSON.stringify(got))
      failures.push(['pred'+i,want,got]);
  }
  for(let i=0;i<cases.length;i++){
    const want=expected[i],got=results[i];
    if(want.ok!==got.ok){failures.push([i,want,got]);continue;}
    if(want.ok===false&&want.error!==got.error){failures.push([i,want,got]);continue;}
    if(want.ok===true){
      const wantJob=normalizeNode(want.job),gotJob=normalizeNode(got.job);
      if(JSON.stringify(wantJob)!==JSON.stringify(gotJob)){
        failures.push([i,{tasks:wantJob.tasks?.map(t=>({id:t.id,state:t.state,
          dag:t.dagNode,title:t.title,adapter:t.adapter}))},
          {tasks:gotJob.tasks?.map(t=>({id:t.id,state:t.state,
          dag:t.dagNode,title:t.title,adapter:t.adapter}))}]);
        continue;
      }
      const wantInputs=dagInputs(want.job),
        gotInputs=got.dagNodeResults??[];
      if(JSON.stringify(wantInputs)!==JSON.stringify(gotInputs))
        failures.push(['inputs'+i,wantInputs,gotInputs]);
    }
  }
  for(const [i,want,got] of failures.slice(0,8))
    console.log('DAG_DIFF',i,
      JSON.stringify(want??null).slice(0,260),
      JSON.stringify(got??null).slice(0,260));
  assert.deepEqual(failures.map(f=>String(f[0])),[],
    `${failures.length} dag-task-runtime mismatches`);
  console.log('Verified',predicateTasks.length+cases.length,
    'original Node/Rust dag-task-runtime cases');
});
