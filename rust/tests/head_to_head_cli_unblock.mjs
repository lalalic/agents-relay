// Original Node CLI dispatch against disposable real SQLite, compared with
// the native Graph/SQLite CLI. No live NATS, daemon, provider or production Job.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {LocalAuthorityDurableStore} from '../../dist/local-authority-store.js';
import {InMemoryStore} from '../../dist/store.js';
import {runTaskUnblockCommand,runJobUnblockCommand} from '../../dist/cli-unblock.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const base=()=>({
 id:'41',repository:'fixture-repo',projectRoot:'/tmp/rust2-diff-unblock',
 title:'fixture',state:'ACTIVE',updatedAt:'2026-11-17T04:00:00.000Z',
 tasks:[{id:'71',jobId:'41',kind:'work',agentName:'troubleshooter',
  state:'BLOCKED',attempt:2,maxAttempts:3,error:'test provider error',
  blockedBaseline:{blockedAt:'2026-11-17T04:00:00.000Z',headSha:'old'},
  updatedAt:'2026-11-17T04:00:00.000Z'}],
 plans:[]
});
const scenarios=[];
for(const args of [
 ['--reason','verified correction'],
 ['--reason',''],
 [],
 ['--response',''],
 ['--reason','from owner','--response','human response']
])scenarios.push({kind:'task',args,job:base(),taskId:'71'});
for(const args of [
 ['--reason','two fixed'],
 [],
]) {
 const job=base();job.tasks.push({...job.tasks[0],id:'72'});
 scenarios.push({kind:'job',args,job});
}
for(const kind of ['task','job']){
 const job=base();job.tasks[0].state='QUEUED';
 scenarios.push({kind,args:['--reason','not blocked'],job,taskId:'71'});
}
{
 const job=base();job.tasks[0].escalation={id:'e-71',status:'pending'};
 scenarios.push({kind:'task',args:['--reason','not authorized'],job,taskId:'71'});
 scenarios.push({kind:'task',args:['--response','owner decision'],job,taskId:'71'});
}
const normalizedTask=t=>({
 id:t.id,jobId:t.jobId,state:t.state,kind:t.kind,agentName:t.agentName,
 attempt:t.attempt,maxAttempts:t.maxAttempts,error:t.error??null,
 blockedBaseline:t.blockedBaseline??null,
 blockedBy:t.blockedBy??null,
 unblock:t.unblock?{
  event:t.unblock.event,source:t.unblock.source,reason:t.unblock.reason,
  baseline:t.unblock.baseline,currentHeadSha:t.unblock.currentHeadSha??null,
  facts:t.unblock.facts??null,
 }:null,
 escalation:t.escalation?{
  id:t.escalation.id,status:t.escalation.status,response:t.escalation.response??null
 }:null,
 comments:(t.comments??[]).map(comment=>({kind:comment.kind,transition:comment.transition}))
});
const clean=({outcome,after})=>({
 outcome:outcome.ok?{
  ok:true,value:outcome.value.resumedTasks?
   {jobId:outcome.value.jobId,resumedTasks:outcome.value.resumedTasks}:
   {taskId:outcome.value.taskId,resumed:outcome.value.resumed??false,
    replanning:outcome.value.replanning??false,
    task:normalizedTask(outcome.value.task)}
 }:{ok:false,error:outcome.error},
 after:{id:after.id,state:after.state,tasks:after.tasks.map(normalizedTask)}
});
async function node(f){
 const relay=new SQLiteRelayStore(':memory:');
 const store=new LocalAuthorityDurableStore(relay,new InMemoryStore(),undefined,true);
 try{
  await store.saveJob(structuredClone(f.job));
  const job=await store.load(f.job.id);
  const task=job.tasks.find(item=>item.id===f.taskId);
  const logs=[];
  const previous=console.log;console.log=(message)=>logs.push(message);
  let outcome;
  try{
   if(f.kind==='job')await runJobUnblockCommand([...f.args,'--events','none'],store,job);
   else await runTaskUnblockCommand([...f.args,'--events','none'],store,job,task,null);
   outcome={ok:true,value:JSON.parse(logs.at(-1))};
  }catch(error){outcome={ok:false,error:error.message};}
  finally{console.log=previous;}
  return {outcome,after:await store.load(f.job.id)};
 }finally{relay.close();}
}
test('Node/Rust Task and Job CLI Graph+SQLite unblock API behavior',async()=>{
 const expected=[];for(const f of scenarios)expected.push(clean(await node(f)));
 const fixtures=scenarios.map(f=>({...f,op:'apiCliUnblock',graphDirectory:join(root,'workflow')}));
 const process=spawnSync(bin,[],{cwd:root,
  input:fixtures.map(JSON.stringify).join('\n')+'\n',
  encoding:'utf8',timeout:120000,maxBuffer:12*1024*1024});
 assert.equal(process.status,0,process.stderr||process.error?.message);
 const rows=process.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,scenarios.length);
 const mismatches=[];
 for(let i=0;i<rows.length;i++){
  if(!rows[i].ok){mismatches.push({i,error:rows[i].error});continue;}
  const actual=clean(rows[i].value);
  try{assert.deepEqual(actual,expected[i]);}
  catch{mismatches.push({i,fixture:scenarios[i].kind+' '+scenarios[i].args.join(' '),expected:expected[i],actual});}
 }
 assert.deepEqual(mismatches,[],JSON.stringify(mismatches,null,2));
 console.log('Verified',scenarios.length,'Node/Rust CLI unblock SQLite scenarios');
});
