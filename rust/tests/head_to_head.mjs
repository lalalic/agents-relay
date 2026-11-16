// New differential suite: run identical fixtures against real Node src output and rust2, rejecting all mismatches.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
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
      default: throw new Error('unrecognized op');
    }
    return {ok:true,value:value??null};
  }catch(e){return {ok:false,error:e.message};}
}

test('fourteen direct Node source ports produce matching results and errors',async()=>{
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
});
