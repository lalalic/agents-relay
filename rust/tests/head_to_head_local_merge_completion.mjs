// Original Node src/local-merge-delivery.ts vs native Rust Graph reducer.
// All Git effects injected; no remote access, no production SQLite mutation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {reconcileLocalGitCompletion} from '../../dist/local-merge-delivery.js';
const binary=resolve('rust/target/debug/relay-rust2-parity');
const head='a'.repeat(40),merged='b'.repeat(40),nowMs=1795035000000;
const base=()=>({id:'17',repository:'project',prNumber:0,projectRoot:'/tmp/rust2-mock-repo',
 state:'ACTIVE',autoMerge:true,reviewEnabled:false,
 createdAt:'2026-11-18T00:00:00.000Z',updatedAt:'2026-11-18T00:00:00.000Z',
 plans:[{id:'1',round:1,status:'SUCCEEDED',objectiveStatus:'satisfied'}],
 tasks:[{id:'2',jobId:'17',kind:'work',agentName:'implementation',state:'SUCCEEDED',
  output:{kind:'task_pr'}}],
 localMerge:{status:'pending',attempts:0,sourceRef:'refs/heads/relay/job-17',
  targetRef:'refs/heads/main',sourceSha:head}});
const clean=value=>JSON.parse(JSON.stringify(value,(k,v)=>
  ['updatedAt','createdAt','reviewedAt','completedAt','observedAt','timestamp'].includes(k)
  && typeof v==='string' && /^\d{4}-\d\d-\d\dT/.test(v)?'<clock>':v));
async function node(request){
 const job=structuredClone(request.job),mergeInputs=[];
 let persisted=structuredClone(job);
 const store={
  async saveJob(current){persisted=structuredClone(current);return current;},
  async commitWorkflowMutationAndEvents(id,mutation,events){
    assert.equal(id,job.id);
    const latest=structuredClone(persisted);
    const saved=await mutation(latest);
    persisted=structuredClone(saved);
    Object.assign(job,saved);
    return saved;
  },
 };
 const mergeEffect=(repo,receipt)=>{
  assert.equal(repo,'/tmp/rust2-mock-repo');
  mergeInputs.push(structuredClone(receipt));
  if(request.mergeError)throw Error(request.mergeError);
  return request.mergeResult??{sourceSha:request.headSha,mergedCommitSha:merged};
 };
 try{
  const completed=await reconcileLocalGitCompletion(
    store,job,request.headSha,true,()=>'/tmp/rust2-mock-repo',undefined,
    mergeEffect,()=>request.nowMs);
  return {ok:true,value:{completed,job:clean(job),mergeInputs:clean(mergeInputs)}};
 }catch(error){return {ok:false,error:error.message}}
}
function rust(request){
 const child=spawnSync(binary,[],{input:JSON.stringify({op:'nativeLocalMergeReconcile',...request})+'\n',encoding:'utf8',timeout:12000});
 assert.equal(child.status,0,child.stderr);
 const result=JSON.parse(child.stdout.trim());
 if(result.ok)result.value=clean(result.value);
 return result;
}
function fixtures(){
 const cases=[];
 const append=(name,change)=>{const job=base(),options={};change(job,options);cases.push({name,job,headSha:head,nowMs,...options});};
 append('ready success',()=>{});
 append('merge failed',()=>{});
 cases[cases.length-1].mergeError='tracked or index changes';
 append('not due',(j)=>{j.localMerge.nextAttemptAt='2028-12-01T00:00:00.000Z'});
 append('review changes requested',(j)=>{j.reviewEnabled=true;j.review={outcome:'changes_requested',headSha:head}});
 append('approved stale review head',(j)=>{j.reviewEnabled=true;j.review={outcome:'approved',headSha:'f'.repeat(40)}});
 append('approved fresh review head',(j)=>{j.reviewEnabled=true;j.review={outcome:'approved',headSha:head}});
 append('no implementation',(j)=>{j.tasks=[]});
 append('failed implementation',(j)=>{j.tasks[0].state='FAILED'});
 append('running implementation',(j)=>{j.tasks[0].state='RUNNING'});
 append('draft Job',(j)=>{j.state='DRAFT'});
 append('cancelled Job',(j)=>{j.state='CANCELLED'});
 append('Job auto-merge disabled',(j)=>{j.autoMerge=false});
 append('no plan',(j)=>{j.plans=[]});
 append('pending plan',(j)=>{j.plans[0].status='PLANNING'});
 append('task file output',(j)=>{j.tasks[0].output={kind:'file',path:'/tmp/output.json'};delete j.localMerge});
 append('already merged',(j)=>{j.localMerge.status='succeeded';j.localMerge.mergedCommitSha=merged});
 append('missing local merge',(j)=>{delete j.localMerge});
 append('terminal with no merge',(j)=>{delete j.localMerge;j.state='COMPLETED'});
 append('revision unresolved',(j)=>{j.tasks.push({id:'3',kind:'work',state:'QUEUED',revision:{kind:'targeted'}})});
 append('manual no due',(j)=>{j.localMerge.nextAttemptAt='2028-12-01T00:00:00.000Z';j.localMerge.status='failed'});
 return cases;
}
test('original Node/Rust direct Job Lifecycle merge/complete gates and outcome/failure parity',async()=>{
 let checked=0;
 for(const entry of fixtures()){
  const request={...entry};delete request.name;
  const expected=await node(request);
  const actual=rust(request);
  try{assert.deepEqual(actual,expected);}catch(error){
    throw Error(`Scenario ${entry.name}: ${error.message}\nRust=${JSON.stringify(actual)}\nNode=${JSON.stringify(expected)}`);
  }
  checked++;
 }
 console.log(`PASS ${checked} direct original Node/Rust local merge lifecycle and negative cases`);
});
