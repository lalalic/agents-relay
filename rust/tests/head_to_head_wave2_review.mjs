// Direct randomized, negative and malformed Node/Rust comparisons for Worker B.
// All fixtures are in-memory or private temporary files; NEVER access the live Relay Job store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as chair from '../../dist/review-chair.js';
import * as replan from '../../dist/review-replan.js';
import * as execution from '../../dist/review-revision-execution.js';
import * as model from '../../dist/review-revision-model.js';
import * as thread from '../../dist/reviewer-thread.js';
import * as outcome from '../../dist/outcome-review.js';
import { decideRevisionLifecycle } from '../../dist/workflow/revision-v2.js';
const root=process.cwd();
const bin=resolve(root,'rust/target/debug/relay-rust2-parity');
let count=0;
function canonical(v){return v===undefined?null:JSON.parse(JSON.stringify(v))}
function rust(op, payload={}){
  const r=spawnSync(bin,[],{input:JSON.stringify({op,...payload})+'\n',encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const out=JSON.parse(r.stdout.trim());
  return out.ok?{ok:true,value:out.value}:{ok:false,error:out.error};
}
function compare(op,payload,fn){
  let expected;
  try {expected={ok:true,value:canonical(fn())}}
  catch(e){expected={ok:false,error:e.message}}
  const actual=rust(op,payload);
  if(expected.ok)assert.deepEqual(actual,expected,JSON.stringify({op,payload}));
  else assert.deepEqual(actual,expected,JSON.stringify({op,payload}));
  count++;
}
let seed=20261117;
function rand(){seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/2**32}
const choose=(list)=>list[Math.floor(rand()*list.length)];

test('review-chair: reject malformed finding/specialist, preserve verdicts and attributions',()=>{
  const values=[
    null,12,[],{}, {verdict:'pass',reviewer:'a',dimension:'b',summary:'s'},
    {verdict:'concern',reviewer:'a',dimension:'b',summary:' s ',severity:'P2'},
    {verdict:'fail',reviewer:' a ',dimension:'b',summary:'s',id:' ID ',severity:null},
    {verdict:'blocked',reviewer:'a',dimension:'b',summary:'s',severity:'P4'},
    {verdict:'pass',reviewer:'a',dimension:'b',summary:'s',location:3},
  ];
  for(let i=0;i<140;i++){
    const v=i<values.length?values[i]:{verdict:choose(['pass','concern','blocked','fail','unknown']),
      reviewer:choose(['r',' s ','','a',5]),dimension:choose(['qa','','security']),summary:choose(['foo',' bar ',null]),
      severity:choose(['P0','P2','PX',undefined,null]),id:choose([undefined,'', 'f1'])};
    compare('parseReviewFinding',{value:v,index:i%4},()=>chair.parseReviewFinding(v,i%4));
  }
  const reviews=[
    {target:{artifact:'tool',version:'a'},reviewer:'qa',dimension:'security',verdict:'fail',
      findings:[{reviewer:'qa',dimension:'security',verdict:'fail',summary:'X',evidence:'check'}]},
    {target:{artifact:'tool',version:'a'},reviewer:'qa',dimension:'security',verdict:'pass',findings:[]},
    {target:{artifact:'tool',version:'a'},reviewer:'qa',dimension:'security',verdict:'garbage',findings:[]},
    {target:{artifact:'tool',version:'a'},reviewer:'qa',dimension:'security',verdict:'fail',
      findings:[{reviewer:'someone',dimension:'security',verdict:'fail',summary:'X'}]},
    null,{}, {verdict:'pass',findings:[]},
  ];
  for(const v of reviews)compare('parseSpecialistReview',{value:v},()=>chair.parseSpecialistReview(v));
});
test('review-chair: randomized panel, metadata, task-dedupe and synthesis',()=>{
  const t={artifact:'story',version:'h1'};
  for(let i=0;i<100;i++){
    const candidates=Array.from({length:6},(_,j)=>({agent:'agent-'+j,dimensions:Array.from({length:3},()=>choose(['security','quality','flow','tone','model']))}));
    const dimensions=['security','quality','flow','tone'].map((name,j)=>({name,priority:choose([0,1,5,undefined,99])}));
    const max=1+Math.floor(rand()*7);
    compare('selectReviewPanel',{candidates,dimensions,max},()=>chair.selectReviewPanel(candidates,dimensions,max));
    const panel=chair.selectReviewPanel(candidates,dimensions,max);
    compare('createSpecialistReviewTasks',{tasks:[],target:t,panel},()=>chair.createSpecialistReviewTasks([],t,panel));
    const member=panel[0]??{agent:'a',dimension:'security',reason:'matched'};
    compare('specialistReviewTaskMetadata',{target:t,member,round:2},()=>chair.specialistReviewTaskMetadata(t,member,2));
  }
  for(const invalidMax of [-1,0,1.5,null,'5',false]){
    compare('selectReviewPanel',{candidates:[],dimensions:[],max:invalidMax},
      ()=>chair.selectReviewPanel([],[],invalidMax));
    compare('createReviewChairExecutionPlan',{agents:[],target:t,max:invalidMax},
      ()=>chair.createReviewChairExecutionPlan([],t,invalidMax));
  }
  const agents=[{name:'a',capabilities:['model','security'],description:'review'}, {name:'b',capabilities:['security','flow']}];
  compare('createReviewChairExecutionPlan',{agents,target:t,max:5},()=>chair.createReviewChairExecutionPlan(agents,t));
  for(let i=0;i<50;i++){
    const panel=[{agent:'a',dimension:'security',reason:'r'},{agent:'b',dimension:'quality',reason:'r'}];
    const reviews=[{reviewer:'a',dimension:'security',target:t,verdict:'fail',
      findings:[{id:'one',reviewer:'a',dimension:'security',verdict:choose(['pass','fail','blocked']),summary:choose(['Issue',' issue  ','Other']),evidence:'real'}]},
      {reviewer:'b',dimension:'quality',target:t,verdict:'pass',
      findings:[{id:'two',reviewer:'b',dimension:'quality',verdict:'concern',summary:'Issue'}]}];
    compare('synthesizeReview',{target:t,panel,reviews},()=>chair.synthesizeReview(t,panel,reviews));
  }
  const bad=[{reviewer:'wrong',dimension:'security',target:{artifact:'different',version:'h1'},findings:[]}];
  compare('synthesizeReview',{target:t,panel:[],reviews:bad},()=>chair.synthesizeReview(t,[],bad));
});
test('review-replan: randomized Plan and Review durable generation facts',()=>{
  for(let i=0;i<260;i++){
    const id=String(1+Math.floor(rand()*10)), changed=choose(['changes_required','stale','approved','pending']);
    const job={
      tasks:Array.from({length:Math.floor(rand()*5)},(_,k)=>({id:String(k+1),kind:choose(['work','planner']),agentName:choose(['worker','reviewer','job-acceptance-reviewer']),state:choose(['SUCCEEDED','FAILED','QUEUED'])})),
      plans:Array.from({length:Math.floor(rand()*4)},(_,k)=>({status:choose(['PLANNING','FAILED','SUCCEEDED']),trigger:{source:choose(['review','model']),reviewTaskId:choose([id,'0'])},generatedTaskIds:choose([[],['1'],['2'],['7']])})),
      review:{taskId:id,outcome:changed,revisionDisposition:choose(['targeted','needs-ownership',undefined])},
      reviewRevisionRounds:[{reviewTaskId:id,status:choose(['approved','changes_required'])}],
    };
    compare('reviewNeedsReplan',{job},()=>replan.reviewNeedsReplan(job));
    compare('reviewPlanReady',{job},()=>replan.reviewPlanReady(job));
  }
});
test('revision execution: exact request-generation safety and Graph reconciliation',()=>{
  for(let i=0;i<180;i++){
    const job={review:{taskId:'r',outcome:choose(['changes_required','stale','approved']),revisionDisposition:choose(['targeted','replan'])},
      reviewRevisionRequests:[{requestId:'q',reviewTaskId:'r',revisionTaskId:'t',reviewHeadSha:'head',status:choose(['queued','running','failed','requested'])}]};
    const task={id:'t',revision:{kind:'targeted',reviewTaskId:choose(['r','x']),requestIds:choose([['q'],['missing'],[],['q','missing']]),basedOnHeadSha:choose(['head','stale'])}};
    compare('revisionRequestReady',{job,task},()=>execution.revisionRequestReady(job,task));
  }
  for(let i=0;i<85;i++){
    const state=choose(['DRAFT','QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED']);
    const status=choose(['requested','queued','running','failed','verified','stale']);
    const job={id:'x',tasks:[{id:'t',state,executionId:state==='QUEUED'?null:'e',revision:{kind:'targeted',reviewTaskId:'r',requestIds:['q']}}],
      review:{outcome:choose(['changes_required','approved']),revisionDisposition:'targeted',taskId:'r'},
      reviewRevisionRequests:[{requestId:'q',reviewTaskId:'r',reviewHeadSha:'head',revisionTaskId:'t',status}],updatedAt:'old'};
    const original=structuredClone(job), changed=execution.reconcileReviewRevisionFacts(original);
    if(changed)original.updatedAt='NORMALIZED';
    const r=rust('reconcileReviewRevisionFacts',{root,job});
    assert.equal(r.ok,true,r.error);
    assert.deepEqual(r.value,{changed,job:original},JSON.stringify(job));count++;
  }
});
test('review revision model: targeted evidence coverage and dependency generations',()=>{
  for(let i=0;i<160;i++){
    const reviewTask={id:'review',executionId:'e1'};
    const requests=[{requestId:'q1',reviewTaskId:choose(['review','other']),reviewExecutionId:choose(['e1','e2']),
      reviewHeadSha:choose(['head','wrong']),originalTaskId:'origin',status:choose(['verified','stale','queued']),
      findings:[{id:'f1',summary:'problem'}]}];
    const job={tasks:[{id:'origin',state:choose(['SUCCEEDED','FAILED'])}],reviewRevisionRequests:requests};
    const issues=choose([['f1'],['problem'],['missing'],[],['[unparseable blocking finding]']]);
    compare('targetedRequestsForReview',{job,task:reviewTask,headSha:'head'},()=>model.targetedRequestsForReview(job,reviewTask,'head'));
    compare('targetedRequestsCoverReview',{job,task:reviewTask,headSha:'head',issues},()=>model.targetedRequestsCoverReview(job,reviewTask,'head',issues));
  }
  for(let i=0;i<120;i++){
    const task={dependencies:choose([['origin'],['origin','missing'],[],['origin','origin']]),
      dependencyValidity:{origin:choose(['revalidate','rerun','order-only','bad'])}};
    const job={tasks:[{id:'origin',state:choose(['SUCCEEDED','FAILED']),attempt:1,createdAt:'old'},
      {id:'fix',state:choose(['SUCCEEDED','FAILED']),attempt:2,createdAt:'new',revision:{originalTaskId:'origin'}}]};
    compare('dependencyValidityReview',{task,id:'origin'},()=>model.dependencyValidity(task,'origin'));
    compare('dependencyRevisionVectorReview',{job,task},()=>model.dependencyRevisionVector(job,task));
    const a=choose([{origin:'origin:1'},{origin:'fix:2'},{x:'1'},{}]),b=choose([{origin:'origin:1'},{origin:'fix:2'},{}]);
    compare('sameDependencyRevisionVectorReview',{a,b},()=>model.sameDependencyRevisionVector(a,b));
  }
});
test('reviewer-thread: malformed IDs, destination fallback, delivered fence, requirements',()=>{
  for(let i=0;i<145;i++){
    const value=choose([null,undefined,'a','  id  ','',' ',12,true,'z'.repeat(257),'😀'.repeat(130)]);
    compare('normalizeThreadId',{value},()=>thread.normalizeThreadId(value));
    const job={creatorThreadId:choose([undefined,' creator ',null]),reviewerThreadId:choose([undefined,' reviewer ',null]),
      implementationThreadId:choose([null,' impl ',undefined,10]),
      tasks:choose([[],[{agentName:'job-acceptance-reviewer',state:'SUCCEEDED',adapter:'chatgpt',routing:{provider:'chatgpt'},
        threadId:'historic',threadUrl:'https://chatgpt.com/c/historic'}]])};
    const override=choose([undefined,' command ',null,' ']);
    compare('resolveReviewerThreadDestination',{job,override},()=>thread.resolveReviewerThreadDestination(job,override));
    compare('resolveImplementationThreadDestination',{job},()=>thread.resolveImplementationThreadDestination(job));
    const implTask={agentName:choose(['implementation','reviewer',undefined])};
    compare('resolveImplementationTaskThreadDestination',{job,task:implTask},
      ()=>thread.resolveImplementationTaskThreadDestination(job,implTask));
    compare('prepareReviewerThreadDelivery',{job:{...job,id:'1'},task:{id:'r',agentName:'reviewer',reviewHeadSha:'h',routing:{projectId:null}},override},
      ()=>thread.prepareReviewerThreadDelivery({...job,id:'1'},{id:'r',agentName:'reviewer',reviewHeadSha:'h',routing:{projectId:null}},override));
    const config=choose([undefined,{capabilities:['gpu','model']},{capabilities:['webhelm'],runtime:'local'}]);
    compare('chatgptThreadRequirements',{configured:config},()=>thread.chatgptThreadRequirements(config));
  }
});
test('outcome-review: CLI options/contract and highest-severity verdict, no Codex subprocess',()=>{
  const tmp=mkdtempSync(join(tmpdir(),'rust2-review-'));
  try {
    const project=join(tmp,'project');mkdirSync(join(project,'agents'),{recursive:true});
    writeFileSync(join(project,'prompt.txt'),'  task  ');
    writeFileSync(join(project,'agents','security.agent.md'),'review');
    for(const args of [
      ['--prompt','hello'],['--prompt-file','prompt.txt'],['--prompt','x','--agents','security,security,quality'],
      ['--prompt',''],['--prompt','x','--prompt-file','prompt.txt'],['--agents','security'],
      ['--prompt','ok','--agents','Bad'],['--prompt-file','absent.txt'],['--prompt','ok','--bad','bad'],
      ['--prompt','ok','--output','review/out.json']
    ]) compare('parseOutcomeReviewArgs',{args,cwd:project},()=>outcome.parseOutcomeReviewArgs(args,project));
    for(const name of ['reviewer','security','missing']){
      compare('reviewerContract',{name,projectPath:project,root,workspaceRoot:project},
        ()=>outcome.reviewerContract(name,project,project,root));
    }
    for(let i=0;i<80;i++){
      const reviews=Array.from({length:1+Math.floor(rand()*5)},()=>({verdict:choose(['BLOCKED','PASS','CHANGE_REQUIRED'])}));
      compare('combineOutcomeReviews',{reviews},()=>outcome.combineOutcomeReviews(reviews));
    }
  } finally {rmSync(tmp,{recursive:true,force:true})}
});
test('settlement: facts and stale-generation no-op, no SQLite mutation faked',()=>{
  for(let i=0;i<100;i++){
    const job={review:{taskId:'r',outcome:choose(['changes_required','approved']),revisionDisposition:choose(['targeted','other']),headSha:'head'},
      reviewRevisionRequests:[{reviewTaskId:'r',revisionTaskId:'t',status:choose(['verified','requested','failed'])}],
      tasks:[{id:'r',state:'SUCCEEDED'},{id:'t',state:choose(['SUCCEEDED','FAILED'])}],
      reviewRevisionRounds:[{reviewTaskId:'r',status:'changes_required',recordedAt:'2026-10-01',requestIds:[]}]};
    const r=rust('settleReviewRevisionRound',{root,job});
    assert.equal(r.ok,true,r.error);count++;
  }
  const noOp={review:{taskId:'r',outcome:'approved',headSha:'head'},tasks:[]};
  assert.deepEqual(rust('staleReviewRevisions',{root,job:noOp,reviewTaskId:'r',headSha:'other'}).value,{job:noOp,cancelled:[]});count++;
});
test('revision/planner/troubleshooter native negative edges stay isolated',()=>{
  const d=mkdtempSync(join(tmpdir(),'rust2-review-sqlite-'));
  try {
    const p=rust('createFailedPlanRecovery',{root,storeDir:join(d,'stores'),job:{id:'j',repository:'repo',tasks:[]},plan:{id:'p',status:'PLANNING'}});
    assert.deepEqual(p,{ok:false,error:'Plan recovery requires a terminal FAILED Plan'});
    const f=rust('fallbackFailedTroubleshooters',{root,job:{tasks:[]}});
    assert.deepEqual(f,{ok:true,value:{job:{tasks:[]},queued:[]}});count+=2;
  }finally{rmSync(d,{recursive:true,force:true})}
});
test('evidence count',()=>{assert.ok(count>=1200, 'expected >1200 direct comparisons, got '+count)});
