// New differential suite: run identical fixtures against real Node src output and rust2, rejecting all mismatches.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deriveTaskTitle } from '../../dist/task-title.js';
import { isFinalReviewAgent } from '../../dist/final-review-role.js';
import { validatePlannerAgentRoles } from '../../dist/planner-agent-roles.js';
import { jobHasActiveExecution, jobHasConflictingExecution } from '../../dist/job-execution-slot.js';
import { requiredPlannerTaskTitle } from '../../dist/planner-task-title.js';
import { validateDependencyValidity } from '../../dist/dependency-validity.js';
import { terminalRecoveryEligible, terminalRecoveryPrompt } from '../../dist/terminal-event-recovery.js';
import { authoritativeBranchPushArgs } from '../../dist/github-branch-projection.js';
import { configureLocalGitMerge } from '../../dist/cli-local-merge-config.js';
import { preserveReviewRevisionHistory } from '../../dist/review-revision-merge.js';
import { orderGitHubBindingCandidates } from '../../dist/github-binding-order.js';
import { parsePlannerHistoryCleanup } from '../../dist/planner-history-cleanup.js';
import { ProjectionFailureDeduplicator } from '../../dist/projection-failure-dedupe.js';
import { bindPlannedReviewHead } from '../../dist/planned-review-head.js';
import { normalizeReviewEvidence } from '../../dist/review-evidence.js';
import { classifyWorkerRejection, classifyChatGptPlatformFailure, PreSubmissionRejection } from '../../dist/worker-rejection.js';
import { parseJobTagJson, acceptedReportedTag, eventDataWithoutTag, taskTagWorkerPrompt } from '../../dist/task-tag.js';
import { normalizeReviewerTerminalEvent } from '../../dist/review-terminal-normalization.js';
import { plannerTaskContext } from '../../dist/planner-task-context.js';
import { ConditionRegistry, booleanCondition, verifyActionEffect, safeRetryAllowed } from '../../dist/workflow/conditions.js';
import { discoverAgents } from '../../dist/registry.js';
import { reviewRevisionLimits, reviewFindingFingerprint, reviewRoundFindingFingerprint, repeatedFindingRounds } from '../../dist/review-revision-policy.js';
import { validateDAGStageGate } from '../../dist/dag-stage-contract.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dagRoot=mkdtempSync(resolve(tmpdir(),'relay-rust2-dag-'));
function stageFixture(name,stageValidation,response,runName='run') {
 const projectPath=resolve(dagRoot,name);mkdirSync(resolve(projectPath,'scripts'),{recursive:true});mkdirSync(resolve(projectPath,'runs',runName),{recursive:true});
 writeFileSync(resolve(projectPath,'scripts/check.mjs'),'// isolated fixture\n');
 if(stageValidation!==undefined)writeFileSync(resolve(projectPath,'project.run.json'),JSON.stringify({stageValidation}));
 return {op:'validateDAGStageGate',projectPath,agent:'reviewer',runPath:resolve(projectPath,'runs',runName),interpreter:process.execPath,response};
}
const rustBinary = resolve(root, 'rust/target/debug/relay-rust2-parity');
const ready = {hasSession:true,hasThread:true,terminalObserved:false,recoveryAttempts:0,outcomeUncertain:false,cancelled:false};
const cases = [];
// These operations share one parity process; reset is explicit so dedupe vectors model instance lifetime.
for (const options of [
  {sourceRef:'refs/relay/job-1',branch:'feature',remoteHeadSha:null,remoteTreeMatchesBase:false},
  {sourceRef:'local',branch:'a/b',remoteHeadSha:'abc123',remoteTreeMatchesBase:true},
  {sourceRef:'local',branch:'main',remoteHeadSha:'',remoteTreeMatchesBase:true},
  {sourceRef:'local',branch:'main',remoteHeadSha:'sha',remoteTreeMatchesBase:false},
]) cases.push({op:'authoritativeBranchPushArgs',...options});
for (const [state,source,target,localOnly] of [
  ['ACTIVE','refs/heads/feature','refs/heads/main',false],
  ['DRAFT','refs/heads/review','refs/heads/main',true],
  ['COMPLETED','refs/heads/x','refs/heads/main',false],
  ['ACTIVE','','refs/heads/main',false],
  ['ACTIVE','source','main',false],
]) cases.push({op:'configureLocalGitMerge',job:{id:'j',state,localMerge:{status:'old'}},source,target,localOnly});
for (const [local,merged] of [
  [{reviewRevisionRequests:[{id:'local'}],reviewRevisionRounds:[1]},{reviewRevisionRequests:[{id:'remote'}],reviewRevisionRounds:[2],state:'ACTIVE'}],
  [{},{reviewRevisionRequests:[1],reviewRevisionRounds:[2],state:'DRAFT'}],
  [{reviewRevisionRequests:null,reviewRevisionRounds:[]},{reviewRevisionRequests:[1],reviewRevisionRounds:[2]}],
]) cases.push({op:'preserveReviewRevisionHistory',local,merged});
const candidate=(id,state,prNumber,createdAt)=>({snapshotPath:`/${id}.json`,job:{id,state,prNumber,createdAt}});
cases.push({op:'orderGitHubBindingCandidates',items:[
  candidate('terminal-unbound','COMPLETED',0,'2026-01-01'),candidate('bound','ACTIVE',1,'2026-01-04'),
  candidate('fresh-old','ACTIVE',0,'2026-01-01'),candidate('terminal-bound','CANCELLED',3,'2026-01-03'),
  candidate('unbound-new','DRAFT',0,'2026-01-05'),candidate('terminal-late','COMPLETED',0,'2026-01-06'),
]});
for (const value of [
  undefined, null, [], {}, [{taskId:'t',outcome:'unresolved',evidence:'log',reason:'no longer needed'}],
  [{taskId:'t',outcome:'superseded',evidence:'commit',reason:'replaced',targetTaskId:'t2'}],
  [{taskId:'t',outcome:'invalid',evidence:'bad',reason:'invalidated'}],
  [{taskId:'t',outcome:'cancelled_review',evidence:'review',reason:'cancelled',targetTaskId:''}],
  [{taskId:' ',outcome:'unresolved',evidence:'e',reason:'r'}],
  [{taskId:'\ufeff',outcome:'unresolved',evidence:'e',reason:'r'}],
  [{taskId:'a',outcome:'unresolved',evidence:'e',reason:'r'},{taskId:'a',outcome:'unresolved',evidence:'e2',reason:'r2'}],
  [{taskId:'a',outcome:'unresolved',evidence:'\t',reason:'r'}],
]) cases.push({op:'parsePlannerHistoryCleanup',...(value===undefined?{}:{value})});
cases.push({op:'resetProjectionFailureDeduplicator'});
for (const entry of [
  ['j1','v1','boom','terminal'],['j1','v1','boom','terminal'],['j1','v1','different','terminal'],
  ['j1','v2','boom','terminal'],['j1','v2','boom','transient'],['j1','v2','boom','terminal'],
  ['j2','v1','same','terminal'],['j1','v2','boom','terminal'],
]) cases.push({op:'projectionFailureShouldReport',jobId:entry[0],updatedAt:entry[1],reason:entry[2],classification:entry[3]});
cases.push({op:'resetProjectionFailureDeduplicator'});
for (const [task,head] of [
  [{id:'review-1',input:'Review it'},'abc123'],
  [{id:'review-2',input:'Review it'},''],
  [{id:'review-3',input:'Review the current immutable local source head as a PRE-MERGE approval gate.'},'def456'],
  [{id:'review-4',input:'Existing context'},null],
]) cases.push({op:'bindPlannedReviewHead',task,localHeadSha:head});
for (const input of [
  '', '  \n \t', '# My Title', '###### Heading', '####### Heading', '#NoWhitespace',
  '- alpha', '*  alpha', '+\talpha', '1. alpha', '12)  alpha', '01) alpha',
  '# - Example', '### 13) List title', '- 4. Nested item',
  '\r\n \nMy First Title\n My Second Title',
  'Heading\u00a0with\u2003different\twhitespace', '\ufeffLeading and trailing\u3000',
  'Line\u0085separator', '日本語の見出しは長い文字列',
  'X'.repeat(96), 'X'.repeat(97), 'X'.repeat(93) + '\t'.repeat(8) + 'X',
  '😀'.repeat(60), 'x'.repeat(92) + '😀' + 'longer title',
  '𐀀'.repeat(50), '# ' + 'a'.repeat(100), '#'.repeat(7) + ' words',
]) cases.push({op:'deriveTaskTitle',input});
for (const fallback of ['Untitled', '', 'Fallback '+ 'x'.repeat(98), '😀'.repeat(50)]) {
  cases.push({op:'deriveTaskTitle',input:'\n',fallback});
}
for (const value of [null, false, 10, {}, '', '   ', 'one two three four',
  'one two three four five', 'one two three four five six seven eight',
  'one two three four five six seven eight nine',
  '  one\u00a0two\tthree  four\ufefffive  ',
  '一个 二个 三个 四个 五个', '\u0085one two three four five',
]) cases.push({op:'requiredPlannerTaskTitle',value,index:7});
for (const value of [null, [], false, 42, 'text', {},
  {a:'order-only'}, {a:'rerun',b:'revalidate'}, {a:'bad'}, {c:'rerun'},
  {a:undefined}, {a:null}, {a:1}, {a:{}},
  JSON.parse('{"__proto__":"rerun"}'),
  JSON.parse('{"b":"bad","a":"bad"}'),
  JSON.parse('{"2":"bad","1":"bad"}'),
]) cases.push({op:'validateDependencyValidity',dependencies:['a','b','__proto__'],value});
cases.push({op:'validateDependencyValidity',dependencies:['a'],value:{a:'rerun'},field:'customPolicy'});
cases.push({op:'validateDependencyValidity',dependencies:['a','b'],value:JSON.parse('{"b":"bad","a":"bad"}')});
cases.push({op:'validateDependencyValidity',dependencies:['1','2'],value:JSON.parse('{"2":"bad","1":"bad"}')});
cases.push({op:'validateDependencyValidity',dependencies:['a'],value:{c:'rerun'},field:'customPolicy'});
for (const recoveryAttempts of [-3, -1, 0, 0.5, 0.9999, 1, 2, 12]) {
  for (let bits=0;bits<32;bits++) {
    const facts={...ready,recoveryAttempts};
    ['hasSession','hasThread','terminalObserved','outcomeUncertain','cancelled'].forEach((field,i)=>facts[field]=Boolean(bits & (1<<i)));
    cases.push({op:'terminalRecoveryEligible',facts});
  }
}
for (const executionId of ['', 'exec-original', '中文-exec-1', 'a/b/c', '"quoted"']) cases.push({op:'terminalRecoveryPrompt',executionId});
for (const event of [
  {type:'review.approved',data:{headSha:'abc',findings:['  ok  ']}},
  {type:'review.changes_required',data:{outcome:{head_sha:'def',blocking_findings:[{message:'  bad  '},null]}}},
  {type:'review.approved',data:{review:{headSha:'ghi',issues:'bad'}}},
  {type:'review.approved',data:{head_sha:'',issues:[{},'']}},
  {type:'review.approved',data:{head_sha:'null-case',findings:null}},
  {type:'review.approved',data:{}},
  {type:'review.approved',data:{head_sha:'héad',findings:['漢字 😀']}}
]) cases.push({op:'normalizeReviewEvidence',event,task:{reviewHeadSha:'fallback'}});
for (const message of ['RATE_LIMIT_EXCEEDED','usage limit reached','quota-exceeded','model is unavailable','unsupported model','provider refused','service unavailable','other']) cases.push({op:'classifyWorkerRejection',message});
for (const [phase,error] of [['delivery',{status:'rejected',submitted:false,code:'MODEL_NOT_FOUND',message:'模型不可用'}],['delivery',{status:'rejected',submitted:false,code:'PROVIDER_UNAVAILABLE',message:''}],['delivery',{message:'uncertain'}],['launch',{message:'boom'}],['start-ack','plain'],['delivery',null],['delivery',{status:'rejected',submitted:true,code:'PROVIDER_UNAVAILABLE',message:'x'}]]) cases.push({op:'classifyChatGptFailure',phase,error});
for (const raw of ['', 'null', '[]', '{}', '{bad', '{"description":"x","values":{"ok":"✅"}}', '{"description":"  ","values":{"x":"X"}}', '{"description":"x","values":{}}', '{"description":"x","values":{"é":"x"}}', JSON.stringify({description:'😀'.repeat(251),values:{x:'X'}}), JSON.stringify({description:'标签',values:{a:'中文😀'}}), JSON.stringify({description:'\ufeff',values:{x:'X'}}), '{"description":"\\u0085","values":{"10":"ten","2":"two","a":"A"}}']) cases.push({op:'parseJobTag',raw});
for (const data of [undefined,null,{}, {tag:'ok',x:1}, {tag:'ok'}, {tag:null}]) cases.push({op:'eventDataWithoutTag',data});
for(const tag of [undefined,null,{description:'Outcome',values:{pass:'PASS',fail:'FAIL'}},{description:'Unicode',values:{'α':'✅'}}]){const job=tag===undefined?{}:{tag};cases.push({op:'taskTagWorkerPrompt',job});cases.push({op:'acceptedReportedTag',job,data:{tag:'pass'}});}
for (const event of [
 {type:'task.completed',data:{verdict:'approved',head_sha:'abc',findings:[{message:'x'}]}},
 {type:'task.completed',message:'',data:{verdict:'blocked',headSha:'def'}},
 {type:'task.completed',data:{verdict:'changes_required',outcome:{head_sha:'h',blockingFindings:['x']}}},
 {type:'task.completed',data:{verdict:'pass',head_sha:''}},
 {type:'task.failed',data:{verdict:'approved',head_sha:'abc'}}
]) cases.push({op:'normalizeReviewerTerminalEvent',event});
for (const task of [{id:'t',title:'😀'.repeat(4001),kind:'work',input:'x'.repeat(4001),result:{summary:'s',data:{x:'😀'}},comments:[{author:'a',text:'c',createdAt:'now'}]}, {id:'u',title:'Unicode 😀 中文',input:'漢字'}, {id:'p',kind:'planner',input:'secret',dependencies:[],state:'QUEUED'}]) cases.push({op:'plannerTaskContext',task});
for (const outcome of ['Verified','Failed','Unknown','failed']) cases.push({op:'conditionSafeRetry',outcome});
for (const value of [true,false,null,'true',0]) cases.push({op:'conditionCheck',id:'merged',specs:[{id:'merged',kind:'boolean'}],facts:{merged:value}});
cases.push({op:'conditionDiscover',specs:[{id:'z'},{id:'a'}]},{op:'conditionValidate',specs:[{id:'x'},{id:'x'}]},{op:'conditionCheck',id:'absent',specs:[],facts:{}}, {op:'conditionVerify',specs:[{id:'merged',kind:'boolean'}],actionId:'merge',conditionId:'merged',facts:{merged:true}}, {op:'conditionGuard',specs:[{id:'merged',kind:'boolean'}],id:'merged',facts:{merged:'yes'}});
const registryAgent=(id,availability,succeeded,failed,timedOut,evaluations,extra={})=>({id,availability,capabilities:['review','code'],runtime:{adapter:'script'},routing:{trustDomains:['trusted'],labels:{zone:'east'}},evidence:{outcomes:{succeeded,failed,timedOut},evaluations},...extra});
for(const query of [{},{capabilities:['review'],runtime:'script',availability:['available'],trustDomain:'trusted',labels:{zone:'east'},taskKind:'review',explore:true},{capabilities:['missing']},{labels:{zone:'west'}}])cases.push({op:'discoverAgents',agents:[registryAgent('unobserved','available',0,0,0,[]),registryAgent('reliable','busy',9,1,0,[{taskKind:'review'}]),registryAgent('available-low','available',1,2,1,[{taskKind:'other'}])],query});
for(const env of [{},{AGENTS_RELAY_REVIEW_MAX_ROUNDS:'9',AGENTS_RELAY_REVIEW_NO_PROGRESS_LIMIT:'2'},{AGENTS_RELAY_REVIEW_MAX_ROUNDS:'  '},{AGENTS_RELAY_REVIEW_MAX_ROUNDS:'0'},{AGENTS_RELAY_REVIEW_NO_PROGRESS_LIMIT:'1.5'},{AGENTS_RELAY_REVIEW_MAX_ROUNDS:'101'}])cases.push({op:'reviewRevisionLimits',env});
for(const findings of [[],[''],[' Fix   THIS ','fix this'],['İssue','issue','é','e\u0301'],['😀','漢字','a'],['  keep\n  spaces  '],['\u0085x\u0085']])cases.push({op:'reviewFindingFingerprint',findings});
for(const round of [{reviewTaskId:'r1',requestIds:['q1']},{reviewTaskId:'r2',requestIds:['q2'],findingFingerprint:'frozen'}, {reviewTaskId:'r3',requestIds:[]}])cases.push({op:'reviewRoundFindingFingerprint',job:{reviewRevisionRequests:[{requestId:'q1',findings:[{summary:'Bug'}]},{requestId:'q2',findings:[{summary:'other'}]}]},round});
cases.push({op:'repeatedFindingRounds',job:{reviewRevisionRequests:[{requestId:'a',findings:[{summary:'same'}]},{requestId:'b',findings:[{summary:' SAME  '}]},{requestId:'c',findings:[{summary:'different'}]}],reviewRevisionRounds:[{reviewTaskId:'old-a',requestIds:['a'],status:'changes_required',recordedAt:'1'},{reviewTaskId:'old-b',requestIds:['b'],status:'changes_required',recordedAt:'2'},{reviewTaskId:'old-c',requestIds:['c'],status:'changes_required',recordedAt:'3'}]},currentRound:{reviewTaskId:'now',requestIds:['b'],status:'changes_required'}});
const stageConfig={script:'scripts/check.mjs',agents:{reviewer:'review-stage'}};
const dagPass=stageFixture('dag-pass',stageConfig,{stdout:JSON.stringify({stage:'review-stage',status:'PASS',errors:[]}),stderr:'',code:0});
dagPass.expectedInvocation={args:[process.execPath,realpathSync(resolve(dagPass.projectPath,'scripts/check.mjs')),'review-stage',realpathSync(dagPass.runPath)],cwd:realpathSync(dagPass.projectPath)};
cases.push(stageFixture('dag-absent',undefined,{stdout:'',stderr:'',code:0}),stageFixture('dag-no-agent',{script:'scripts/check.mjs',agents:{other:'stage'}},{stdout:'',stderr:'',code:0}),stageFixture('dag-null',null,{stdout:'',stderr:'',code:0}),stageFixture('dag-bad-map',{script:'scripts/check.mjs',agents:[]},{stdout:'',stderr:'',code:0}),stageFixture('dag-bad-stage',{script:'scripts/check.mjs',agents:{reviewer:'Stage_1'}},{stdout:'',stderr:'',code:0}),stageFixture('dag-bad-script',{script:'../bad.mjs',agents:{reviewer:'review-stage'}},{stdout:'',stderr:'',code:0}),stageFixture('dag-invalid-output',stageConfig,{stdout:'not json',stderr:'',code:0}),stageFixture('dag-fail',stageConfig,{stdout:JSON.stringify({stage:'review-stage',status:'FAIL',errors:['missing evidence']}),stderr:'ignored',code:1}),dagPass);
const outsideRun=resolve(dagRoot,'outside-run');mkdirSync(outsideRun);const escapedRun=stageFixture('dag-run-escape',stageConfig,{stdout:'',stderr:'',code:0});escapedRun.runPath=outsideRun;cases.push(escapedRun);
const outsideScript=resolve(dagRoot,'outside.mjs');writeFileSync(outsideScript,'// outside fixture\n');const symlinkFixture=stageFixture('dag-script-escape',{script:'scripts/escape.mjs',agents:{reviewer:'review-stage'}},{stdout:'',stderr:'',code:0});symlinkSync(outsideScript,resolve(symlinkFixture.projectPath,'scripts/escape.mjs'));cases.push(symlinkFixture);

for(const name of [null,undefined,'','reviewer','job-acceptance-reviewer','Reviewer',' job-acceptance-reviewer','implementation']) {
  cases.push({op:'isFinalReviewAgent',name});
}
const taskSpec=(id,agentName)=>({id,agentName});
for(const specs of [[],[taskSpec('a',null)],[taskSpec('a','director')],
 [taskSpec('a','implementation'),taskSpec('b',null)],
 [taskSpec('a','director'),taskSpec('b','director')],
 [taskSpec('a','reviewer')],[taskSpec('a','job-acceptance-reviewer')],
 [taskSpec('a','designer'),taskSpec('b','motion')],
 [taskSpec('a',''),taskSpec('b','implementation')],
 [taskSpec('a','  designer  '),taskSpec('b','designer')],
 [taskSpec('a','director'),taskSpec('b','director'),taskSpec('c','director')],
 [taskSpec('a','director'),taskSpec('b','job-acceptance-reviewer')],
]) cases.push({op:'validatePlannerAgentRoles',specs});
const task=(id,state,executionId,extras={})=>({id,state,executionId,...extras});
const dag=(parentTaskId)=>({parentTaskId});
const planner=(id,status,executionId)=>({id,status,executionId});
for(const state of ['DRAFT','QUEUED','RUNNING','AWAITING_DECISION','BLOCKED','SUCCEEDED','FAILED','CANCELLED']) {
 for(const executionId of [null,'exec-1']) {
  for(const extras of [{},{dagNode:dag('coord')},{agentGraph:{graph:'a'},result:{data:{dag:{version:1}}}}]) {
    const job={tasks:[task('a',state,executionId,extras)],plans:[]};
    for(const except of [{},{taskId:'a'},{taskId:'other'}]) cases.push({op:'jobHasActiveExecution',job,except});
  }
 }
}
for(const plans of [[],[planner('p','PLANNING','exec')],[planner('p','SUCCEEDED','exec')],
 [planner('p','PLANNING',null)],[planner('p','PLANNING','exec'),planner('q','PLANNING','exec')]]) {
 const job={tasks:[],plans};
 for(const except of [{},{planId:'p'},{planId:'q'}])cases.push({op:'jobHasActiveExecution',job,except});
}
for(const candidate of [
 task('a','RUNNING','exec-1'),
 task('a','RUNNING','exec-1',{dagNode:dag('coord')}),
 task('a','RUNNING','exec-1',{dagNode:dag('other')}),
]) {
 for(const state of ['DRAFT','QUEUED','RUNNING','AWAITING_DECISION','SUCCEEDED','FAILED']) {
  for(const extras of [{},{dagNode:dag('coord')},{dagNode:dag('other')},
    {agentGraph:{graph:'x'},result:{data:{dag:{version:1}}}}]) {
   const job={tasks:[candidate,task('b',state,'exec-2',extras)],plans:[]};
   cases.push({op:'jobHasConflictingExecution',job,candidate});
  }
 }
 for(const plans of [[],[planner('p','PLANNING','exec')],[planner('p','PLANNING',null)]]) {
   cases.push({op:'jobHasConflictingExecution',job:{tasks:[candidate],plans},candidate});
 }
}
let projectionDeduplicator = new ProjectionFailureDeduplicator();
async function nodeReference(request) {
  try {
    let value;
    switch(request.op) {
      case 'deriveTaskTitle': value=deriveTaskTitle(request.input,request.fallback);break;
      case 'isFinalReviewAgent': value=isFinalReviewAgent(request.name);break;
      case 'validatePlannerAgentRoles': value=validatePlannerAgentRoles(request.specs);break;
      case 'jobHasActiveExecution': value=jobHasActiveExecution(request.job,request.except);break;
      case 'jobHasConflictingExecution': value=jobHasConflictingExecution(request.job,request.candidate);break;
      case 'requiredPlannerTaskTitle': value=requiredPlannerTaskTitle(request.value,request.index);break;
      case 'validateDependencyValidity': value=validateDependencyValidity(request.dependencies,request.value,request.field);break;
      case 'terminalRecoveryEligible': value=terminalRecoveryEligible(request.facts);break;
      case 'terminalRecoveryPrompt': value=terminalRecoveryPrompt(request.executionId);break;
      case 'authoritativeBranchPushArgs': value=authoritativeBranchPushArgs(request);break;
      case 'configureLocalGitMerge': configureLocalGitMerge(request.job,request.source,request.target,request.localOnly);value=request.job;break;
      case 'preserveReviewRevisionHistory': preserveReviewRevisionHistory(request.local,request.merged);value=request.merged;break;
      case 'orderGitHubBindingCandidates': value=orderGitHubBindingCandidates(request.items);break;
      case 'parsePlannerHistoryCleanup': value=parsePlannerHistoryCleanup(request.value);break;
      case 'resetProjectionFailureDeduplicator': projectionDeduplicator=new ProjectionFailureDeduplicator();value=null;break;
      case 'projectionFailureShouldReport': value=projectionDeduplicator.shouldReport(request.jobId,request.updatedAt,request.reason,request.classification);break;
      case 'bindPlannedReviewHead': {
        let saveCalls=0;
        await bindPlannedReviewHead({saveTask:async task=>{saveCalls++;return task;}},request.task,request.localHeadSha);
        value={task:request.task,saveCalls};
        break;
      }
      case 'normalizeReviewEvidence': value=normalizeReviewEvidence(request.event,request.task);break;
      case 'classifyWorkerRejection': value=classifyWorkerRejection(request.message);break;
      case 'classifyChatGptFailure': { let error=request.error; if(error&&error.status==='rejected'&&error.submitted===false){const pre=PreSubmissionRejection.fromPlatformResponse(error);if(pre)error=pre;} value=classifyChatGptPlatformFailure(error,request.phase);break; }
      case 'parseJobTag': value=parseJobTagJson(request.raw);break;
      case 'eventDataWithoutTag': value=eventDataWithoutTag(request.data);break;
      case 'taskTagWorkerPrompt': value=taskTagWorkerPrompt(request.job);break;
      case 'acceptedReportedTag': value=acceptedReportedTag(request.job,request.data);break;
      case 'normalizeReviewerTerminalEvent': value=normalizeReviewerTerminalEvent(request.event);break;
      case 'plannerTaskContext': value=JSON.parse(JSON.stringify(plannerTaskContext(request.task)));break;
      case 'conditionSafeRetry': value=safeRetryAllowed(request.outcome);break;
      case 'conditionCheck': value=new ConditionRegistry(request.specs.map(s=>booleanCondition(s.id))).check(request.id,request.facts);break;
      case 'conditionDiscover': value=new ConditionRegistry(request.specs.map(s=>booleanCondition(s.id))).discover();break;
      case 'conditionValidate': new ConditionRegistry(request.specs.map(s=>booleanCondition(s.id)));value=null;break;
      case 'conditionVerify': value=verifyActionEffect(new ConditionRegistry(request.specs.map(s=>booleanCondition(s.id))),request.actionId,request.conditionId,request.facts);break;
      case 'conditionGuard': value=new ConditionRegistry(request.specs.map(s=>booleanCondition(s.id))).guard(request.id)({durableFacts:request.facts});break;
      case 'discoverAgents': value=discoverAgents(request.agents,request.query);break;
      case 'reviewRevisionLimits': value=reviewRevisionLimits(request.env);break;
      case 'reviewFindingFingerprint': value=reviewFindingFingerprint(request.findings);break;
      case 'reviewRoundFindingFingerprint': value=reviewRoundFindingFingerprint(request.job,request.round);break;
      case 'repeatedFindingRounds': value=repeatedFindingRounds(request.job,request.currentRound);break;
      case 'validateDAGStageGate': await validateDAGStageGate({projectPath:request.projectPath,agent:request.agent,runPath:request.runPath,execute:async(args,cwd)=>{if(request.expectedInvocation){assert.deepStrictEqual(args,request.expectedInvocation.args);assert.equal(cwd,request.expectedInvocation.cwd);}return request.response;}});value=null;break;
      default: throw new Error('unrecognized op');
    }
    return {ok:true,value:value??null};
  }catch(e){return {ok:false,error:e.message};}
}

test('direct Node source ports produce matching results and errors',async()=>{
  try {
  const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});
  assert.equal(build.status,0,`Rust build failed: ${build.stderr}`);
  const input=cases.map(item=>JSON.stringify(item)).join('\n')+'\n';
  const result=spawnSync(rustBinary,[],{input,encoding:'utf8',maxBuffer:1024*1024,timeout:30000});
  assert.equal(result.status,0,`Rust CLI failed: ${result.stderr}`);
  const rustLines=result.stdout.trim().split('\n');
  assert.equal(rustLines.length,cases.length);
  for(let i=0;i<cases.length;i++) {
    const actual=JSON.parse(rustLines[i]);
    const expected=await nodeReference(JSON.parse(JSON.stringify(cases[i])));
    assert.deepStrictEqual(actual,expected,`Mismatch in case ${i}: ${JSON.stringify(cases[i])}`);
    assert.equal(JSON.stringify(actual),JSON.stringify(expected),`Serialized JSON mismatch in case ${i}: ${JSON.stringify(cases[i])}`);
  }
  console.log(`Verified ${cases.length} exact Node/Rust differential cases (including errors, Unicode, stateful reset sequences, and projection behavior).`);
  } finally { rmSync(dagRoot,{recursive:true,force:true}); }
});
