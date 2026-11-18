// Original Node src/git-delivery.ts and src/cli-task-complete.ts vs native
// Rust on isolated real Git/worktree histories; never touches user repositories.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import * as node from '../../dist/git-delivery.js';
const binary='rust/target/debug/relay-rust2-git-delivery-parity';
const cmd=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function native(req){
 const proc=spawnSync(binary,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:12000});
 assert.equal(proc.status,0,proc.stderr);
 return JSON.parse(proc.stdout.trim());
}
const sample=(op,details)=>native({op,...details});
function compare(op,request,callback){
 const actual=sample(op,request);
 let expected;
 try{expected={ok:true,value:callback()};}
 catch(error){expected={ok:false,error:error.message};}
 assert.equal(actual.ok,expected.ok,`${op}: ${JSON.stringify(request).slice(0,320)} actual=${JSON.stringify(actual)}`);
 if(actual.ok){
   if(op==='bindSourceBaseline'){
     assert.deepEqual(actual.value,JSON.parse(JSON.stringify(expected.value)));
   }else if(op==='verifySourceCommit'){
     assert.deepEqual({...actual.value,verifiedAt:'CLOCK'}, {...expected.value,verifiedAt:'CLOCK'});
     assert.match(actual.value.verifiedAt,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
   }else assert.deepEqual(actual.value,expected.value,`${op}: ${JSON.stringify(request).slice(0,240)}`);
 }else if(expected.error.startsWith('Git delivery ')){
   assert.equal(actual.error,expected.error,`${op}: ${JSON.stringify(request).slice(0,230)}`);
 }else if(expected.error.includes('fatal: ')){
   assert.ok(actual.error.includes(expected.error.match(/fatal: [^\n]+/)?.[0]??'fatal:'),`Git stderr changed: ${actual.error}`);
 }
 return actual;
}
function fixture(){
 const temp=mkdtempSync(join(tmpdir(),'rust2-git-delivery-'));
 const root=join(temp,'root'),worktree=join(temp,'worker');
 mkdirSync(root);
 cmd(root,'init','-b','main');cmd(root,'config','user.name','rust2 fixture');
 cmd(root,'config','user.email','rust2@example.invalid');
 writeFileSync(join(root,'file.txt'),'baseline\n');cmd(root,'add','.');cmd(root,'commit','-m','baseline');
 const base=cmd(root,'rev-parse','HEAD');
 cmd(root,'worktree','add','-b','relay/job-123',worktree,'main');
 const task={id:'t-22',kind:'work',agentName:'implementation',output:{kind:'task_pr'},
  adapter:'script',state:'RUNNING',executionId:'exec-X',gitDeliveryRequired:true,
  gitDeliveryBaseline:{executionId:'exec-X',sha:base}};
 const job={id:'123',projectRoot:root,repository:'root',localMerge:{sourceRef:'refs/heads/relay/job-123'},tasks:[task]};
 const commit=(trailers=true)=>{
  appendFileSync(join(worktree,'file.txt'),'change\n');cmd(worktree,'add','.');
  const args=['commit','-m',`change ${Date.now()}`];
  if(trailers)args.push('-m','Relay-Task: t-22','-m','Relay-Execution: exec-X');
  cmd(worktree,...args);return cmd(worktree,'rev-parse','HEAD');
 };
 return {temp,root,worktree,base,task,job,commit,cleanup:()=>rmSync(temp,{recursive:true,force:true})};
}

test('Node/Rust pure immutable Task Git requirement and baseline-binding parity',()=>{
 let checked=0;
 for(const kind of ['work','planner'])for(const agentName of ['implementation','reviewer','job-acceptance-reviewer','review-chair','troubleshooter','planner',''])
 for(const graph of [undefined,'', 'flowchart LR\na --> b'])for(const output of [undefined,{kind:'task_pr'},{kind:'file'}]){
  const task={kind,agentName,agentGraph:graph,output};
  compare('sourceCommitRequired',{task},()=>node.sourceCommitRequired(task));checked++;
 }
 for(const required of [false,true])for(const executionId of [null,'exec-X'])for(const sha of [undefined,null,'', 'a'.repeat(40)]){
  const task={id:'t',gitDeliveryRequired:required,executionId,gitDelivery:{old:true}};
  const req={task,sha};
  compare('bindSourceBaseline',req,()=>{const t=structuredClone(task);node.bindSourceBaseline(t,sha);return t;});checked++;
 }
 console.log(`Verified ${checked} source policy/baseline direct cases`);
});

test('Node/Rust local branch HEAD, baseline and verified Git receipt on real worktrees',()=>{
 const f=fixture();let checked=0;
 const diff=(op,request,fn)=>{checked++;return compare(op,request,fn)};
 try{
  diff('sourceCommitSha',{job:f.job},()=>node.sourceCommitSha(f.job));
  diff('startedSourceBaseline',{job:f.job,taskId:f.task.id},()=>node.startedSourceBaseline(f.job,f.task.id));
  diff('startedSourceBaseline',{job:f.job,taskId:'missing'},()=>node.startedSourceBaseline(f.job,'missing'));
  for(const request of [
   {job:{...f.job,projectRoot:''}},
   {job:{...f.job,projectRoot:join(f.temp,'absent')}},
   {job:{...f.job,projectRoot:f.worktree}},
   {job:{...f.job,localMerge:{sourceRef:'refs/heads/../main'}}},
   {job:{...f.job,localMerge:{sourceRef:'refs/heads/missing'}}},
  ])diff('sourceCommitSha',request,()=>node.sourceCommitSha(request.job));
  diff('verifySourceCommit',{job:f.job,task:f.task,executionId:'wrong',commitSha:f.base},()=>node.verifySourceCommit(f.job,f.task,'wrong',f.base));
  diff('verifySourceCommit',{job:f.job,task:f.task,executionId:'exec-X',commitSha:f.base},()=>node.verifySourceCommit(f.job,f.task,'exec-X',f.base));
  const bad=f.commit(false);
  diff('verifySourceCommit',{job:f.job,task:f.task,executionId:'exec-X',commitSha:bad},()=>node.verifySourceCommit(f.job,f.task,'exec-X',bad));
  appendFileSync(join(f.worktree,'file.txt'),'dirty\n');
  diff('verifySourceCommit',{job:f.job,task:f.task,executionId:'exec-X',commitSha:bad},()=>node.verifySourceCommit(f.job,f.task,'exec-X',bad));
  cmd(f.worktree,'reset','--hard','HEAD');
  const good=f.commit();
  const req={job:f.job,task:f.task,executionId:'exec-X',commitSha:good};
  const receipt=diff('verifySourceCommit',req,()=>node.verifySourceCommit(f.job,f.task,'exec-X',good)).value;
  f.task.gitDelivery=receipt;
  diff('sourceCompletionVerified',{job:f.job,task:f.task,executionId:'exec-X'},()=>node.sourceCompletionVerified(f.job,f.task,'exec-X'));
  diff('sourceCompletionVerified',{job:f.job,task:f.task,executionId:'old'},()=>node.sourceCompletionVerified(f.job,f.task,'old'));
  for(const damaged of [
   {...f.task,gitDelivery:{...receipt,baseSha:'a'.repeat(40)}},
   {...f.task,gitDelivery:{...receipt,worktree:'/invalid/path'}},
   {...f.task,state:'SUCCEEDED'},
   {...f.task,gitDeliveryRequired:false},
  ])diff('sourceCompletionVerified',{job:f.job,task:damaged,executionId:'exec-X'},()=>node.sourceCompletionVerified(f.job,damaged,'exec-X'));
  // Concurrent worker advances the Job branch after the Task-owned commit.
  const next=f.commit(false);assert.notEqual(next,good);
  diff('verifySourceCommit',req,()=>node.verifySourceCommit(f.job,f.task,'exec-X',good));
  diff('sourceCompletionVerified',{job:f.job,task:f.task,executionId:'exec-X'},()=>node.sourceCompletionVerified(f.job,f.task,'exec-X'));
  console.log(`Verified ${checked} real Git/branch/worktree/error and receipts`);
 }finally{f.cleanup();}
});

test('Rust task.complete CLI request contract matches Node arguments and defaults',()=>{
 const base=['--repo','repo','--id','123','--task-id','t22','--execution-id','exec-X','--commit-sha','d'.repeat(40)];
 for(const args of [[],['--repo','r'],base,[...base,'--summary','My change'],
  ...['--repo','--id','--task-id','--execution-id','--commit-sha'].map(flag=>base.filter((_,i)=>{
    const index=base.indexOf(flag);return i!==index&&i!==index+1;
  }))]){
  const result=sample('taskCompleteRequest',{args});
  const find=flag=>args.includes(flag)?(args[args.indexOf(flag)+1]??''):'';
  if(!['--repo','--id','--task-id','--execution-id','--commit-sha'].every(find)){
   assert.deepEqual(result,{ok:false,error:'task complete requires --repo, --id, --task-id, --execution-id and --commit-sha'});
  }else{
   const commitSha=find('--commit-sha'),taskId=find('--task-id');
   assert.deepEqual(result,{ok:true,value:{command:'task.complete',jobId:find('--id'),taskId,executionId:find('--execution-id'),commitSha,
    repository:find('--repo'),summary:find('--summary')||`Source Task ${taskId} committed ${commitSha}`}});
  }
 }
});
