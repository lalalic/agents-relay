// Rust2 L3 Coordinator/Agent Review E2E acceptance. Real native CLI/daemon,
// trusted Script subprocesses, durable SQLite + Graph and a test-only external
// Host Review adapter; Model stages MUST use a real configured provider.
// No Node Relay runtime imports or direct database reads/edits by this driver.
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'node:net';
const source=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const arg=(k,f='')=>{const i=process.argv.indexOf(k);return i>=0?process.argv[i+1]:f;};
const cliBin=resolve(arg('--cli',join(source,'rust/target/debug/agents-relay-rust')));
const daemonBin=resolve(arg('--daemon',join(source,'rust/target/debug/agents-relayd-rust')));
const hostBin=resolve(arg('--review-host',join(source,'rust/target/debug/examples/l3_review_host_fixture')));
// A WebHelm ChatGPT canary does not execute a DAG's native `codex` Model
// executor. Reject misleading flags rather than turn an untested provider
// path into a false E2E PASS or attach to an operator's live EventBus.
for(const option of ['--canary-webhelm-socket','--canary-webhelm-executable',
                      '--canary-webhelm-workspace','--event-history-api']){
 if(process.argv.includes(option))throw Error(`${option} is not a native Codex fixture; refused`);
}
const selected=arg('--case');
const cases=['C01','C02','C03','C04','C05'].filter(c=>!selected||c===selected);
if(!cases.length)throw Error('Unknown --case: expected C01 through C05');
const root=realpathSync(mkdtempSync(join(tmpdir(),'agents-relay-rust-l3-')));
const env={...process.env,AGENTS_RELAY_SCRIPT_NODE:process.execPath};
const rows=[],transcript=[];
const resultPath=join(root,'results.json');
function check(ok,why){if(!ok)throw Error(why);}
function exec(bin,args,{parse=true,timeout=60000,checkExit=true}={}){
 const v=spawnSync(bin,args,{cwd:source,env,encoding:'utf8',timeout,maxBuffer:5*1024*1024});
 const row={bin:bin.split('/').at(-1),args,status:v.status,stdout:v.stdout||'',stderr:v.stderr||'',error:v.error?.message};
 transcript.push(row);
 if(checkExit&&v.status!==0)throw Error(`${row.bin}: ${args.slice(0,3).join(' ')} exit=${v.status}: ${(v.stderr||v.stdout||v.error?.message||'').slice(-1100)}`);
 if(!parse)return row;
 try{return JSON.parse(row.stdout);}catch{throw Error('Invalid JSON from '+row.bin+': '+row.stdout.slice(0,500));}
}
const git=(...args)=>exec('git',args,{parse:false});
function state(run){
 // A CAS commit and Dashboard read may race an isolated Graph/SQLite tick.
 // Retry only transient service reads, never turn a failed Job into PASS.
 let last;
 for(let attempt=0;attempt<10;attempt++){
  try{return exec(cliBin,['job','show','--repo','fixture','--id',run.id,'--port',String(run.port)]);}
  catch(error){
   if(!/HTTP (400|503)|SQLITE_BUSY|database is locked/.test(error.message))throw error;
   last=error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,130);
  }
 }
 throw last;
}
function cli(run,...args){return exec(cliBin,[...args,'--port',String(run.port)]);}
function child(job,node){return job.tasks.find(t=>t.dagNode?.nodeId===node);}
async function poll(label,fn,maxMs=25000){let last;
 const start=Date.now();while(Date.now()-start<maxMs){
  last=await fn();if(last)return last;await delay(200);
 }throw Error(`Timed out waiting for ${label}: ${JSON.stringify(last).slice(0,450)}`);
}
async function freePort(){const s=createServer();await new Promise((res,rej)=>s.once('error',rej).listen(0,'127.0.0.1',res));const n=s.address().port;await new Promise(res=>s.close(res));return n;}
async function stopDaemon(run){if(!run.daemon)return;
 const p=run.daemon;run.daemon=null;
 if(p.exitCode!==null||p.signalCode!==null)return;
 p.kill('SIGTERM');await Promise.race([new Promise(ok=>p.once('exit',ok)),delay(3500)]);
 if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await Promise.race([new Promise(ok=>p.once('exit',ok)),delay(1500)]);}
}
function scriptedAgent(run,name,needsReview){
 const agents=join(run.project,'agents');mkdirSync(join(agents,'.shortcut'),{recursive:true});
 writeFileSync(join(agents,`${name}.agent.md`),`---\nname: ${name}\ncapabilities: [script]\n---\n# Rust L3 fixture ${name}\n`);
 const script=`import {writeFileSync,appendFileSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
export async function run({input}){
 const name=${JSON.stringify(name)};
 const review=input.reviewDecision?.status??'new';
 appendFileSync(${JSON.stringify(join(run.path,'executions.jsonl'))},JSON.stringify({name,review,taskId:input.taskId,executionId:input.executionId})+'\\n');
 if(review==='changes_requested'){
  writeFileSync(${JSON.stringify(join(run.project,`${name}-correction.json`))},JSON.stringify({corrected:true,feedback:input.reviewDecision?.feedback??''}));
 }
 if(${JSON.stringify(needsReview)} && review!=='approved'){
  const base=['review','interactive'];
  for(const op of ['begin','wait']){
   const args=[...base,op,'--id',input.jobId,'--task-id',input.taskId,'--execution-id',input.executionId,'--port',${JSON.stringify(String(run.port))}];
   // Only this isolated fixture holds the review host until begin/wait
   // returns. Exact execution IDs and this one-host rule make retry of
   // Darwin's transient EAGAIN safe; Graph/4xx rejections are never retried.
   let receipt;
   for(let n=0;n<3;n++){
    const result=spawnSync(${JSON.stringify(cliBin)},args,{encoding:'utf8',timeout:40000});
    if(result.status===0){receipt=JSON.parse(result.stdout);break;}
    const reason=result.stderr||result.stdout||result.error?.message||'unknown';
    if(n===2||!/Resource temporarily unavailable|os error 35|operation would block/i.test(reason))
     throw Error('Interactive '+op+' failed: '+reason);
   }
   if(op==='wait'&&receipt.taskState!=='AWAITING_DECISION')throw Error('Review wait returned without durable AWAITING_DECISION');
  }
  return {status:'WAITING_REVIEW'};
 }
 const result=${JSON.stringify(join(run.project,`${name}.txt`))};
 writeFileSync(result,'completed '+input.executionId+'\\n');
 return {status:'COMPLETED',output:{stage:name,executionId:input.executionId},artifacts:{file:result}};
}`;
 writeFileSync(join(agents,'.shortcut',`${name}.agent.mjs`),script);
}
function prepare(run){
 mkdirSync(run.project,{recursive:true});git('init','-q','-b','main',run.project);
 git('-C',run.project,'config','user.name','Rust L3 Test');git('-C',run.project,'config','user.email','rust-l3@invalid.test');
 writeFileSync(join(run.project,'objective.md'),'Test only: verify three-stage durable DAG and exact Agent Review decisions.\n');
 const reviews=run.idCase==='C02'?['first','middle','last']:run.idCase==='C03'?['middle']:run.idCase==='C05'?['first']:[];
 scriptedAgent(run,'first',reviews.includes('first'));
 if(!['C01','C04','C05'].includes(run.idCase))scriptedAgent(run,'middle',reviews.includes('middle'));
 else {mkdirSync(join(run.project,'agents'),{recursive:true});writeFileSync(join(run.project,'agents/middle.agent.md'),'---\nname: middle\ncapabilities: [model]\n---\n# Real Model stage; never replace by a scripted mock\n');}
 scriptedAgent(run,'last',reviews.includes('last'));
 git('-C',run.project,'add','.');git('-C',run.project,'commit','-q','-m','L3 isolated fixture');
 writeFileSync(join(run.path,'graph.mmd'),'flowchart TD\nA[agent:first] --> B[agent:middle]\nB --> C[agent:last]\n');
 writeFileSync(join(run.path,'input.md'),'Execute L3 test fixture only; no external user data.\n');
}
async function daemonStart(run){
 const logfile=join(run.path,'daemon.log');
 const fs=await import('node:fs');const fd=fs.openSync(logfile,'w');
 const args=['--isolated-write-store-dir',run.stores,'--workspace-root',run.path,'--repo','fixture','--port',String(run.port),'--interval','100'];

 run.daemon=spawn(daemonBin,args,{cwd:source,env,stdio:['ignore',fd,fd]});fs.closeSync(fd);
 await poll('Rust2 CLI daemon ready',()=>{
  if(run.daemon.exitCode!==null)throw Error('Daemon exited: '+readFileSync(logfile,'utf8').slice(-1200));
  const v=exec(cliBin,['status','--port',String(run.port)],{parse:false,checkExit:false,timeout:5500});
  if(v.status)return null;
  try{const status=JSON.parse(v.stdout);return (status.runtime==='native-rust'||typeof status.activeJobs==='number')?status:null;}catch{return null;}
 },45000);
}
function create(run){
 const created=cli(run,'job','create','--repo','fixture','--project-root',run.project,'--title',`Rust L3 ${run.idCase}`,
  '--objective-file',join(run.project,'objective.md'),'--coordinator-graph-file',join(run.path,'graph.mmd'),
  '--coordinator-input-file',join(run.path,'input.md'),'--coordinator-output-path',join(run.path,'output.json'),
  '--coordinator-project-root',run.project,'--coordinator-workspace-root',run.path,
  '--no-review');
 run.id=String(created.job??created.id);check(/^\d+$/.test(run.id),'Job creation returned no numeric ID');
 const rootTask=state(run).tasks.find(t=>t.agentGraph);check(rootTask,'Missing Coordinator Task');
 cli(run,'job','run','--id',run.id,'--task-id',String(rootTask.id),'--workspace-root',run.path);
 return created;
}
async function awaitWaiting(run,node){return poll(`${run.idCase} ${node} AWAITING_DECISION`,()=>{
 const job=state(run),t=child(job,node);if(!t)return null;
 if(t.state==='FAILED'||t.state==='BLOCKED'){
  const message=String(t.error||t.failureReason||t.state);
  if(/(Codex provider not authorized|Codex adapter not explicitly configured|no configured external Codex)/i.test(message))
   throw Object.assign(Error(`${node} requires a real authorized Codex Model revision; no isolated provider configured. Native Task: ${message}`),{blocked:true});
  throw Error(`${node} Agent Review failed: ${message}; daemon: ${readFileSync(join(run.path,'daemon.log'),'utf8').slice(-900)}`);
 }
 if(t.state==='AWAITING_DECISION'){
  const downstream={A:['B','C'],B:['C'],C:[]}[node];
  check(downstream.every(id=>!child(job,id)),
    `${node} Review gate released a downstream Agent before approval`);
  return {job,task:t};
 }
 return null;
 },45000); }
async function review(run,node,decision){
 const {job,task}=await awaitWaiting(run,node);
 const exact=task.interactiveInvocation?.executionId;
 check(typeof exact==='string'&&exact.length>5,'No exact bound Review execution');
 const args=[join(run.path,'relay.sqlite'),run.id,String(task.id),exact,decision];
 if(!existsSync(hostBin))throw Object.assign(Error('No test-owned native review host fixture; compile --example l3_review_host_fixture'),{blocked:true});
 // A decision for the wrong execution generation must never unblock a Task.
 const stale=exec(hostBin,[args[0],run.id,String(task.id),exact+'-stale',decision],
    {parse:false,checkExit:false});
 check(stale.status!==0,'Stale review generation was incorrectly accepted');
 const unchanged=state(run),current=unchanged.tasks.find(t=>String(t.id)===String(task.id));
 check(current?.state==='AWAITING_DECISION' &&
    current.interactiveInvocation?.executionId===exact,
    'Rejected stale review mutated the current bound invocation');
 const host=exec(hostBin,args);check(host.outcome==='accepted'&&host.state==='QUEUED','Review Host did not commit canonical Graph resume');
 const after=state(run);
 const unchangedId=after.tasks.filter(t=>t.dagNode?.nodeId===node);
 check(unchangedId.length===1 && String(unchangedId[0].id)===String(task.id),
    'Review replaced the original durable Agent Task or allocated a revision worker');
 // Legitimate downstream DAG Tasks may materialize immediately after
 // approval. Do not erroneously require an unchanged total Task count.
 return {originalTask:String(task.id),execution:exact,decision,staleGenerationRejected:true};
}
async function awaitCompleted(run){return poll(`${run.idCase} Job COMPLETED`,()=>{
 const job=state(run);
 const failed=job.tasks.find(t=>t.state==='FAILED'||t.state==='BLOCKED');
 if(failed)throw Error(`Native Task ${failed.id} failed: ${failed.error||failed.failureReason||'unknown'}`);
 return job.state==='COMPLETED'?job:null;
 },60000);}
function assertScriptCompletion(run,job){
 check(job.state==='COMPLETED','Job not completed');
 const tasks=job.tasks.filter(t=>t.dagNode);
 check(tasks.length===3&&tasks.every(t=>t.state==='SUCCEEDED'),'Not three successful durable DAG children');
 for(const n of ['first','middle','last'])check(existsSync(join(run.project,`${n}.txt`)),`${n} real artifact missing`);
 const inv=readFileSync(join(run.path,'executions.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 return {tasks:tasks.map(t=>({taskId:t.id,node:t.dagNode.nodeId,state:t.state,executor:t.dagNode.executor})),invocations:inv};
}
async function blockedModel(run){
 // No isolated Codex provider is configured by default. Never present an
 // empty Model slot, synthetic Script, or NATS event injection as a PASS.
 const first=await poll('upstream Script first terminal',()=>{
  const job=state(run),a=child(job,'A');if(a?.state==='FAILED')throw Error('Upstream Script failed: '+a.error);
  return a?.state==='SUCCEEDED'?job:null;
 },30000);
 check(first.tasks.find(t=>t.dagNode?.nodeId==='A')?.dagNode.executor==='script','A was not real Shortcut');
 const current=await poll('middle Model B materialized',()=>{
  const value=state(run);return child(value,'B')?value:null;
 },12000),b=child(current,'B');
 check(b?.dagNode.executor==='model','B is not declared Model');
 check(!child(current,'C')||child(current,'C').state!=='SUCCEEDED','C bypassed missing Model B');
 throw Object.assign(Error('Rust isolated Model Worker has no authorized Codex provider; Model B was not substituted. B='+b.state+'; C gated'),{blocked:true});
}
async function scenario(run){
 const name=run.idCase;
 if(name==='C01'){await blockedModel(run);return {mixed:'script,model,script'};}
 if(name==='C02'){
  const receipts=[];for(const node of ['A','B','C'])receipts.push(await review(run,node,'approved'));
  const job=await awaitCompleted(run),proof=assertScriptCompletion(run,job);
  check(proof.invocations.length===6,'Each of 3 stages must run for Review then approval, exactly twice');
  return {receipts,...proof};
 }
 if(name==='C03'){
  const first=await review(run,'B','changes_requested');
  const second=await review(run,'B','approved');
  check(first.originalTask===second.originalTask,'Request Changes created a different Task');
  check(first.execution!==second.execution,'Re-review used stale execution generation');
  const job=await awaitCompleted(run),proof=assertScriptCompletion(run,job);
  const correction=JSON.parse(readFileSync(join(run.project,'middle-correction.json'),'utf8'));
  check(correction.corrected&&correction.feedback==='change the hook','Review feedback did not reach corrected Script');
  check(proof.invocations.filter(x=>x.name==='first').length===1,'Upstream A executed twice');
  check(proof.invocations.filter(x=>x.name==='last').length===1,'Downstream C executed twice');
  return {first,second,correction,...proof};
 }
 if(name==='C04'){
  await blockedModel(run);
  throw Object.assign(Error('Model B interactive review requires genuine external Model + Review Host'),{blocked:true});
 }
 if(name==='C05'){
  const first=await review(run,'A','changes_requested');
  const second=await review(run,'A','approved');
  check(first.originalTask===second.originalTask&&first.execution!==second.execution,'Shortcut A re-review did not preserve same Task/new execution');
  await blockedModel(run);
  throw Object.assign(Error('Model B must complete genuine Review before C is released'),{blocked:true});
 }
 throw Error('Unreachable L3 scenario');
}
async function main(){
 for(const name of cases){const path=join(root,name);mkdirSync(join(path,'stores'),{recursive:true});
  const run={idCase:name,path,project:join(path,'fixture'),stores:join(path,'stores'),port:await freePort(),daemon:null,id:null};
  const at=Date.now();let row={case:name};
  try{prepare(run);await daemonStart(run);create(run);const proof=await scenario(run);
   row={case:name,status:'PASS',jobId:run.id,proof};
  }catch(error){row={case:name,status:error.blocked?'BLOCKED':'FAIL',jobId:run.id,error:error.message||String(error)};}
  finally{if(run.id){try{
    const observed=state(run);row.final={jobState:observed.state,tasks:observed.tasks.map(t=>({id:t.id,node:t.dagNode?.nodeId,executor:t.dagNode?.executor,state:t.state,error:t.error,review:t.interactiveInvocation}))};
   }catch(error){row.finalError=error.message;}}await stopDaemon(run);}
  row.ms=Date.now()-at;rows.push(row);writeFileSync(resultPath,JSON.stringify({schema:'rust2-l3-e2e.v1',root,cliBin,daemonBin,hostBin,modelProvider:'none (native Codex is live-only; no Model receipts fabricated)',results:rows},null,2)+'\n');
  console.log(`${row.status} ${name} ${row.error||''}`);
 }
}
try{await main();}catch(error){console.error('HARNESS_ERROR',error.stack||error);process.exitCode=2;}
finally{writeFileSync(join(root,'transcript.json'),JSON.stringify(transcript,null,2)+'\n');
 const counts=Object.fromEntries(['PASS','FAIL','BLOCKED'].map(s=>[s,rows.filter(r=>r.status===s).length]));
 console.log('RESULT',JSON.stringify(counts),'evidence:',root);
 if(rows.length!==cases.length||counts.FAIL||counts.BLOCKED)process.exitCode ||= 1;
}
