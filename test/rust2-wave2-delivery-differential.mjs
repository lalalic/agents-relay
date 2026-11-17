// Direct Node -> Rust behavior differential: temporary Git repos, independent
// SQLite stores and deterministic subprocess fixtures. Never touches live state.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
const root=mkdtempSync(join(tmpdir(),'rust2-wave2-delivery-diff-'));
process.env.AGENTS_RELAY_STORE_DIR=join(root,'stores');
const gitEnv={...process.env,GIT_TERMINAL_PROMPT:'0',
  GIT_AUTHOR_DATE:'2026-11-17T10:00:00Z',GIT_COMMITTER_DATE:'2026-11-17T10:00:00Z'};
process.env.GIT_AUTHOR_DATE=gitEnv.GIT_AUTHOR_DATE;
process.env.GIT_COMMITTER_DATE=gitEnv.GIT_COMMITTER_DATE;
const rust=resolve('rust/target/debug/relay-rust2-parity');
const {assignPlannerTaskIds}=await import('../dist/planner-task-ids.js');
const {deliverLocalMerge,localSourceHead,localWorkingHead,localMergeCommitMessage,
  requiresLocalGitMerge,localMergeFacts}=await import('../dist/local-git-merge.js');
const {dagCompletionError}=await import('../dist/dag-result-contract.js');
const {recordHostInvocationDecision,hostInvocationTablesSql}=await import('../dist/host-invocation-store.js');
let passes=0;
function rustCall(args){
  const payload=JSON.stringify({op:'deliveryWave2',...args})+'\n';
  const p=spawnSync(rust,[],{input:payload,encoding:'utf8',env:gitEnv,timeout:30000});
  if(p.status!==0)throw new Error('Rust fixture invocation: '+p.stderr);
  const parsed=JSON.parse(p.stdout.trim());
  if(!parsed.ok)throw new Error(parsed.error);
  return parsed.value;
}
function assertSame(a,b,description){
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(b)),description); passes++;
}
function cmd(cwd,...args){return execFileSync('git',['-C',cwd,...args],{env:gitEnv,encoding:'utf8'}).trim();}
function fixture(prefix,checkedOut=true){
  const repo=join(root,prefix);mkdirSync(repo);
  cmd(repo,'init','-q','-b','main');
  cmd(repo,'config','user.email','fixture@example.test');cmd(repo,'config','user.name','Fixture');
  writeFileSync(join(repo,'base.txt'),'base\n');
  cmd(repo,'add','base.txt');cmd(repo,'commit','-qm','base');
  cmd(repo,'checkout','-qb','feature');
  writeFileSync(join(repo,'feature.txt'),'feature\n');
  cmd(repo,'add','feature.txt');cmd(repo,'commit','-qm','feature');
  if(checkedOut)cmd(repo,'checkout','-q','main');
  return repo;
}
function wrap(fn){try{return {ok:true,value:fn()}}catch(e){return {ok:false,message:String(e.message)}}}
try{
  // Planner alias: independent SQLite databases to prove stable idempotent scoped allocation.
  const specs=[
    {id:'a',dependencies:['missing','b'],dependencyValidity:{missing:'loose',b:'strict'}},
    {id:'b',parentTaskId:'a',dependencies:['a','missing']},
    {id:'c',parentTaskId:'external',dependencies:[]}
  ];
  for(let seed=0;seed<16;seed++){
    const tasks=[...specs].sort((a,b)=> ((a.id.charCodeAt(0)*7+seed)%3)-((b.id.charCodeAt(0)*7+seed)%3));
    const result={next_tasks:tasks,modelNotes:{seed}};
    const nd=join(root,'node-'+seed,'stores'),rd=join(root,'rust-'+seed,'stores');
    mkdirSync(nd,{recursive:true});mkdirSync(rd,{recursive:true});
    const n=assignPlannerTaskIds(result,'project','42','7',nd);
    const r=rustCall({case:'planner',result,repository:'project',jobId:'42',planId:'7',directory:rd});
    assertSame(r,n,'planner remapping case '+seed);
    assertSame(rustCall({case:'planner',result,repository:'project',jobId:'42',planId:'7',directory:rd}),r,'rust idempotent');
    assertSame(assignPlannerTaskIds(result,'project','42','7',nd),n,'node idempotent');
  }
  for(const checkedOut of [true,false]){
    const left=fixture('git-node-'+checkedOut,checkedOut);
    const right=fixture('git-rust-'+checkedOut,checkedOut);
    const source=localSourceHead(left,'refs/heads/feature');
    assertSame(source,rustCall({case:'localSourceHead',repo:right,sourceRef:'refs/heads/feature'}),'source sha');
    assertSame(localWorkingHead(left),rustCall({case:'localHead',repo:right}),'head sha');
    const receipt={sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',
      sourceSha:source,correlationJobId:'42',displayPrNumber:15};
    const nodeResult=deliverLocalMerge(left,receipt);
    const rustResult=rustCall({case:'localMerge',repo:right,receipt});
    if(rustResult.mergedCommitSha!==nodeResult.mergedCommitSha)console.error('GIT DIFF',cmd(left,'show','-s','--format=raw',nodeResult.mergedCommitSha),cmd(right,'show','-s','--format=raw',rustResult.mergedCommitSha));
    assertSame(rustResult,nodeResult,'Git merge result checkedOut='+checkedOut);
    assertSame(cmd(left,'rev-list','--parents','-n','1',nodeResult.mergedCommitSha),
      cmd(right,'rev-list','--parents','-n','1',rustResult.mergedCommitSha),'Git merge parentage');
    assertSame(deliverLocalMerge(left,receipt),rustCall({case:'localMerge',repo:right,receipt}),'idempotent');
    for(const bad of [
      {...receipt,targetRef:'refs/heads/not-main'},
      {...receipt,sourceRef:'refs/heads/main'},
      {...receipt,sourceRef:'refs/heads/../feature'},
      {...receipt,sourceSha:'ffffffffffffffffffffffffffffffffffffffff'}
    ]){
      const n=wrap(()=>deliverLocalMerge(left,bad));
      const r=wrap(()=>rustCall({case:'localMerge',repo:right,receipt:bad}));
      assertSame(r.ok,n.ok,'Git negative rejects '+JSON.stringify(bad));
    }
  }
  const request={correlationJobId:'42',displayPrNumber:15};
  assertSame(localMergeCommitMessage(request,'abc'),
    rustCall({case:'localMergeMessage',...request,sourceSha:'abc'}),'merge commit message');
  for(const job of [
    {state:'ACTIVE',tasks:[]},
    {state:'ACTIVE',tasks:[{id:'1',kind:'worker',state:'SUCCEEDED',output:{kind:'task_pr'}}]},
    {state:'ACTIVE',tasks:[{id:'1',kind:'planner',state:'SUCCEEDED',output:{kind:'task_pr'}}]},
    {state:'ACTIVE',localMerge:{status:'failed'},tasks:[]}
  ]){
    assertSame(requiresLocalGitMerge(job),
      rustCall({case:'requiresLocalGitMerge',job}),'local merge required');
  }
  // Durable host interactive review with rollback, stale/missing and replay fences.
  const boundJob={id:'42',state:'ACTIVE',updatedAt:'2026-11-17T11:00:00.000Z',
    tasks:[{id:'3',state:'AWAITING_DECISION',executionId:'ex1',
      interactiveInvocation:{invocationId:'inv1',executionId:'ex1',revision:'rev1',
        status:'awaiting_decision',boundAt:'2026-11-17T10:00:00.000Z'}}]};
  const d={jobId:'42',taskId:'3',eventId:'event-1',invocationId:'inv1',executionId:'ex1',
    revision:'rev1',decision:'approved',feedback:'ok',deliveredAt:'2026-11-17T12:00:00.000Z'};
  const cases=[
    {job:boundJob,deliveries:[{delivery:d,fingerprint:'hash'}]},
    {job:boundJob,deliveries:[{delivery:d,fingerprint:'hash',snapshotFail:true}]},
    {job:boundJob,deliveries:[{delivery:d,fingerprint:'hash'},
      {delivery:d,fingerprint:'hash'},{delivery:{...d,eventId:'event-2'},fingerprint:'other'}]},
    {job:boundJob,deliveries:[{delivery:{...d,revision:'wrong'},fingerprint:'hash'}]},
    {job:{...boundJob,state:'FAILED'},deliveries:[{delivery:d,fingerprint:'hash'}]},
    {job:boundJob,deliveries:[{delivery:{...d,executionId:'wrong'},fingerprint:'hash'}]}
  ];
  function nodeHostScenario(req){
    const db=new DatabaseSync(':memory:');
    try{
      db.exec('CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL);'+hostInvocationTablesSql);
      db.prepare('INSERT INTO job_snapshot(job_id,json) VALUES(?,?)').run(req.job.id,JSON.stringify(req.job));
      const outcomes=[];
      for(const step of req.deliveries){
        try {
          outcomes.push(recordHostInvocationDecision(db,step.delivery,step.fingerprint,
            (job,_at)=>{
              if(step.snapshotFail)throw new Error('fixture_snapshot_write_rejected');
              db.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(job),job.id);
            }));
        } catch(e){outcomes.push({error:e.message});}
      }
      return {outcomes,events:db.prepare('SELECT COUNT(*) AS n FROM host_invocation_event').get().n,
        decisions:db.prepare('SELECT COUNT(*) AS n FROM host_invocation_decision').get().n,
        snapshot:JSON.parse(db.prepare('SELECT json FROM job_snapshot LIMIT 1').get().json)};
    } finally {db.close();}
  }
  for(let i=0;i<cases.length;i++){
    assertSame(rustCall({case:'hostInvocationScenario',...cases[i]}),nodeHostScenario(cases[i]),
      'host transaction and decision gates '+i);
  }
  // DAG structured output (no actual providers); test exact error categories.
  const dir=join(root,'dag');mkdirSync(dir);
  const output=join(dir,'result.json');
  const task={dagNode:{nodeId:'x'},output:{kind:'file',path:output}};
  const samples=[
    {status:'COMPLETED',output:{},artifacts:[]},
    {status:'COMPLETED',output:{},artifacts:{report:'file'}},
    {status:'COMPLETED',output:null,artifacts:[]},
    {status:'FAILED',output:{},artifacts:[]},
    {status:'COMPLETED',output:{},artifacts:[1]},
    [],
    null,
  ];
  for(const data of samples){
    writeFileSync(output,JSON.stringify(data));
    assertSame(rustCall({case:'dagResult',task}),await dagCompletionError(task),
      'DAG output validation '+JSON.stringify(data));
  }
  assertSame(rustCall({case:'dagResult',task:{}}),await dagCompletionError({}),'DAG non-graph task');

  // Publication facts: duplicate deliveries must still publish observations,
  // while SQLite retains one delivery receipt (never forge Job completion).
  const {SQLiteRelayStore,relayUnifiedStorePath}=await import('../dist/relay-store.js');
  const {handleServicePublication}=await import('../dist/service-publication.js');
  const pubJob={id:'42',repository:'fixture',prNumber:0,title:'fixture',state:'ACTIVE',
    reviewEnabled:false,autoMerge:false,createdAt:'2026-11-17T10:00:00.000Z',
    updatedAt:'2026-11-17T10:00:00.000Z',continuation:null,tasks:[]};
  const wakeOne={deliveryId:'delivery-1',publicationObservedAt:'2026-11-17T12:00:00.000Z',
    publication:null,publishFailure:{runId:'r1',stage:'npm-publish',attempt:1}};
  const wakeTwo={deliveryId:'delivery-2',publicationObservedAt:'2026-11-17T12:01:00.000Z',
    publication:{package:'agents-relay',version:'3.1.0'},publishFailure:null};
  for(const wakes of [[],[wakeOne],[wakeOne,wakeOne,wakeTwo],[wakeTwo]]) {
    const directory=join(root,'publication-'+passes,'stores');
    const store=new SQLiteRelayStore(relayUnifiedStorePath(directory),pubJob.id);
    await store.saveJob(pubJob);
    const recorded=[];
    for(const wake of wakes)await handleServicePublication(pubJob,wake,{publish:async event=>recorded.push(event)},directory);
    const nodeValue={events:recorded.map(({timestamp,...event})=>JSON.parse(JSON.stringify(event))),
      state:await store.loadPublication(pubJob.id),deliveries:await store.listPublicationEvents(pubJob.id)};
    store.close();
    const rustValue=rustCall({case:'servicePublicationScenario',job:pubJob,wakes});
    assertSame(rustValue,nodeValue,'publication SQLite and event projection');
  }


  // Route outcomes are observational only; compare normalized audit records.
  const {classifyRoutingFailure,recordRouteOutcome,recordTerminalRouteOutcome,
    recordLaunchRouteOutcome,recordWatchdogRouteOutcome}=await import('../dist/route-outcome-recording.js');
  const failures=['invalid api key','AUTHENTICATION FAILED','authorization failed','401 unauthorized',
    'stream disconnected','response.completed','rate_limit_exceeded','RATE LIMIT','quota exceeded',
    'provider-unavailable','model_not_found','service unavailable','timeout',
    'timed out','DEADLINE EXCEEDED','unrelated failure','invalid api key + rate limit',
    'Provider unavailable\nworker timeout','some Authorization: secret123 token=aabbcc'];
  for(const phrase of failures)for(const fallback of ['task_failure','launch_failure','runtime_failure']) {
    assertSame(rustCall({case:'classifyRoutingFailure',message:phrase,fallback}),
      classifyRoutingFailure(phrase,fallback),'routing failure classification');
  }
  const routeTask={id:'3',jobId:'42',adapter:'chatgpt',state:'RUNNING',attempt:2,
    workerSelection:{workerId:'browser:1'},routing:{decisionId:'decision-1',provider:'route',
      model:'model-1',profile:'fast',reasoning:'low'}};
  const normalAudit=a=>a?{...a,outcome_id:'00000000-0000-4000-8000-000000000000',
    timestamp:'2026-11-17T12:00:00.000Z'}:null;
  async function nodeRoute(op,req){
    let record=null;const store={append:async x=>{record=x;}};
    if(op==='terminal')await recordTerminalRouteOutcome(store,req.task,req.event,req.executionId);
    else if(op==='launch')await recordLaunchRouteOutcome(store,req.task,req.message,req.phase,req.executionId,req.unknownOutcome);
    else if(op==='watchdog')await recordWatchdogRouteOutcome(store,req.task,req.watchdog);
    else await recordRouteOutcome(store,req.task,req.recordKind,req.reason,req.evidence);
    return normalAudit(record);
  }
  const routeCases=[
    {kind:'plain',task:routeTask,recordKind:'success',reason:'ok',evidence:{stage:'post'}},
    {kind:'plain',task:routeTask,recordKind:'task_failure',reason:'Bearer private123 token=abc123 password=other',evidence:{}},
    ...['task.completed','task.cancelled','task.blocked','task.failed'].map(type=>({kind:'terminal',task:routeTask,
      event:{type,message:'timeout',data:{reason:'rate limit exceeded'}},executionId:'ex-1'})),
    ...['launch','delivery','start-ack'].flatMap(phase=>[false,true].map(unknownOutcome=>({
      kind:'launch',task:routeTask,message:'invalid public key',phase,executionId:'ex-1',unknownOutcome}))),
    {kind:'watchdog',task:routeTask,watchdog:{executionId:'ex-1',failedExit:true,rawError:'stream disconnected',
      failureReason:'watchdog_failed',failureMessage:'provider unavailable',exitCode:1}},
    {kind:'watchdog',task:routeTask,watchdog:{executionId:'ex-1',failedExit:false,rawError:'',
      failureMessage:'task inactivity',exitCode:null}},
    {kind:'plain',task:{...routeTask,routing:{}},recordKind:'task_failure',reason:'no audit',evidence:{}},
  ];
  for(const req of routeCases)assertSame(rustCall({case:'routeOutcome',...req}),
    await nodeRoute(req.kind,req),'route outcome '+JSON.stringify(req));

  console.log('PASS rust2 wave2 worker C differential assertions='+passes+' temp='+root);
}finally{rmSync(root,{recursive:true,force:true});}
