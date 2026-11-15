import test, {describe} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,symlinkSync,existsSync,realpathSync,chmodSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,join,resolve} from 'node:path';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {resolveExecutionContext} from '../../dist/execution-context.js';
import {DatabaseSync} from 'node:sqlite';
const binary=resolve(import.meta.dirname,'../target/debug/relay-native-daemon');
const helper=resolve(import.meta.dirname,'../target/debug/relay-worker-helper');
const t0='2026-11-13T20:00:00.000Z';
const yes={...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'};
const script=`printf '{"jobId":"%s","taskId":"%s","executionId":"%s","status":"COMPLETED","output":{"verified":true}}' "$RELAY_JOB_ID" "$RELAY_TASK_ID" "$RELAY_EXECUTION_ID" > "$RELAY_RESULT_PATH"; echo success`;
function fixture(source=script){
 const dir=mkdtempSync(join(tmpdir(),'relay-rust-authority-'));
 const db=join(dir,'relay.sqlite'),manifest=join(dir,'manifest.json');
 writeFileSync(join(dir,'.relay-rust-authority-isolated-test'),'test-only');
 writeFileSync(manifest,JSON.stringify({agents:{alpha:{executable:'/bin/sh',args:['-c',source]}}}));
 const args=['--once','--db',db,'--manifest',manifest,'--helper',helper,'--max-tasks','20'];
 return {dir,db,manifest,args};
}
function task(id,jobId,deps=[],state='QUEUED'){
 return {id,jobId,title:'native '+id,kind:'work',agentName:'alpha',parentTaskId:null,dependencies:deps,
 adapter:'script',capabilities:['script'],input:'fixture',state,
 attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,
 error:null,result:null,timeoutMs:1200,createdAt:t0,updatedAt:t0};
}
function terminalRecovery(id,jobId,parentTaskId,recoveryForAttempt,state='SUCCEEDED'){
 return {...task(id,jobId,[],state),title:'Troubleshooter',agentName:'troubleshooter',adapter:'model',
  capabilities:['model'],parentTaskId,recoveryForAttempt,attempt:1,maxAttempts:3,
  error:'old recovery error',failureReason:'old recovery failure',leaseOwner:'old-owner',
  leaseExpiresAt:'2026-11-13T20:00:01.000Z',executionId:'old-recovery-execution',
  executionHistory:[{id:'old-recovery-execution',attempt:1,startedAt:t0}],
  result:{data:{summary:'preserved terminal recovery evidence'}}};
}
async function save(store,root,id,tasks,repository='example'){
 await store.saveJob({id,title:'native daemon '+id,repository,projectRoot:root,prNumber:0,
  state:'ACTIVE',reviewEnabled:true,createdAt:t0,updatedAt:t0,tasks});
}
function once(f,env=yes){
 const result=spawnSync(binary,f.args,{encoding:'utf8',env,timeout:10000});
 assert.equal(result.status,0,result.stderr);
 return JSON.parse(result.stdout.trim())?.report;
}
async function until(callback,timeout=6000){
 const end=Date.now()+timeout;
 while(Date.now()<end){const value=await callback();if(value)return value;await delay(30);}
 throw Error('condition timeout');
}
function alive(pid){
 try{const stat=execFileSync('/bin/ps',['-p',String(pid),'-o','stat='],{encoding:'utf8',timeout:1500}).trim();return stat!==''&&!stat.startsWith('Z');}
 catch{return false;}
}
function absent(pid){
 try{return execFileSync('/bin/ps',['-p',String(pid),'-o','stat='],{encoding:'utf8',timeout:1500}).trim()==='';}
 catch{return true;}
}
function runAsync(f,env=yes){
 return new Promise(resolvePromise=>{
  const child=spawn(binary,f.args,{env,stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  child.once('close',code=>resolvePromise({code,out,err}));
 });
}
describe('isolated native daemon e2e', {concurrency:1},()=>{
test('isolated native daemon: multi-job and dependency wave, physical helper + SQLite readback',async()=>{
 const f=fixture();let store;
 try{
  store=new SQLiteRelayStore(f.db);
  await save(store,f.dir,'91',[task('101','91'),task('102','91',['101'],'DRAFT')]);
  await save(store,f.dir,'92',[task('201','92')]);
  store.close();store=null;
  const first=once(f);
  assert.equal(first.tasksClaimed,2,JSON.stringify(first));
  assert.equal(first.tasksSucceeded,2,JSON.stringify(first));
  store=new SQLiteRelayStore(f.db);
  let job=await store.loadJob('91');
  assert.equal(job.tasks[0].state,'SUCCEEDED');
  assert.equal(job.tasks[1].state,'DRAFT');
  assert.equal(job.state,'ACTIVE','Script must not bypass Final Review');
  assert.equal((await store.loadJob('92')).tasks[0].state,'SUCCEEDED');
  store.close();store=null;
  const second=once(f);
  assert.equal(second.tasksQueued,1);
  assert.equal(second.tasksSucceeded,1);
  store=new SQLiteRelayStore(f.db);job=await store.loadJob('91');
  assert.deepEqual(job.tasks.map(t=>t.state),['SUCCEEDED','SUCCEEDED']);
  assert.equal(job.tasks[1].result.data.output.verified,true);
  assert.equal(once(f).tasksClaimed,0,'restart must never repeat terminal Script');
  const sql=new DatabaseSync(f.db);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM workflow_action_trace').get().n,3);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM execution_process WHERE ended_at IS NOT NULL').get().n,3);
  sql.close();
  console.log('Native daemon: three real Workers, two Jobs, dependency wave, no repeat on restart');
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('daemon applies only the current SHA-bound reviewer verdict and never completes from approval',async()=>{
 const f=fixture();let store;
 const head='0123456789abcdef0123456789abcdef01234567';
 try{
  store=new SQLiteRelayStore(f.db);
  const reviewer={...task('901','91',[],'SUCCEEDED'),agentName:'job-acceptance-reviewer',
   reviewHeadSha:head,result:{summary:'review completed',data:{output:{verdict:'approved',head_sha:head,findings:[]}}}};
  await save(store,f.dir,'91',[reviewer]);
  await store.mutateJob('91',job=>({...job,headSha:head,autoMerge:false,
   review:{outcome:'pending',headSha:head,taskId:'901',evidence:null,updatedAt:t0}}));
  store.close();store=null;
  const first=once(f);
  assert.equal(first.reviewResultsApplied,1,JSON.stringify(first));
  store=new SQLiteRelayStore(f.db);let job=await store.loadJob('91');
  assert.equal(job.review.outcome,'approved');
  assert.equal(job.review.headSha,head);
  assert.equal(job.state,'ACTIVE','review approval is not merge or Job completion');
  store.close();store=null;
  assert.equal(once(f).reviewResultsApplied,0,'restart does not apply the same verdict twice');
  store=new SQLiteRelayStore(f.db);job=await store.loadJob('91');
  assert.equal(job.state,'ACTIVE');
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('independent ready sibling Workers have overlapping execution and complete once',async()=>{
 const f=fixture('if [ "$RELAY_TASK_ID" = "101" ]; then sleep 2; else sleep 4; fi; '+script);let store;
 try{
  store=new SQLiteRelayStore(f.db);
  await save(store,f.dir,'91',[task('101','91'),task('102','91')].map(t=>({...t,timeoutMs:10000})));
  await store.mutateJob('91',job=>({...job,reviewEnabled:false,autoMerge:false}));store.close();store=null;
  const result=await runAsync(f);assert.equal(result.code,0,result.err);
  store=new SQLiteRelayStore(f.db);const job=await store.loadJob('91');
  assert.deepEqual(job.tasks.map(t=>t.state),['SUCCEEDED','SUCCEEDED']);
  assert.equal(job.state,'COMPLETED','no-review Job completes only after both siblings succeed');
  const sql=new DatabaseSync(f.db);
  const processes=sql.prepare('SELECT task_id, observed_at, ended_at FROM execution_process WHERE job_id=?').all('91');
  const first=processes.find(item=>item.task_id==='101');
  const second=processes.find(item=>item.task_id==='102');
  assert.ok(first&&second&&first.ended_at&&second.ended_at);
  assert.ok(Date.parse(first.observed_at)<Date.parse(second.ended_at)
    &&Date.parse(second.observed_at)<Date.parse(first.ended_at),'independent Worker process lifetimes must overlap');
  sql.close();
  assert.equal(once(f).tasksClaimed,0,'restart must not repeat either terminal execution');
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('mixed Script and Model executors dispatch concurrently, fence dependencies, and dedupe after restart',async()=>{
 const f=fixture('sleep 0.3; '+script);let store;
 const modelWorker=join(f.dir,'model-worker.mjs');
 const projectDir=join(f.dir,'src');
 (await import('node:fs')).mkdirSync(projectDir,{recursive:true});
 writeFileSync(join(projectDir,'AGENTS.md'),'project worker rules');
 const globalRoot=join(f.dir,'global');
 const sharedRoot=join(f.dir,'shared');
 (await import('node:fs')).mkdirSync(globalRoot,{recursive:true});
 (await import('node:fs')).mkdirSync(sharedRoot,{recursive:true});
 writeFileSync(join(globalRoot,'AGENTS.md'),'global worker defaults');
 const modelAgentDir=join(projectDir,'agents');
 const skillDir=join(projectDir,'skills','worker-skill');
 (await import('node:fs')).mkdirSync(modelAgentDir,{recursive:true});
 (await import('node:fs')).mkdirSync(skillDir,{recursive:true});
 writeFileSync(join(modelAgentDir,'model-agent.agent.md'),'---\nname: model-agent\nskills: [worker-skill]\n---\nModel agent');
 writeFileSync(join(skillDir,'SKILL.md'),'---\nname: worker-skill\n---\nWorker skill');
 writeFileSync(modelWorker,`import {readFileSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const request=JSON.parse(readFileSync(process.env.RELAY_TASK_REQUEST_PATH,'utf8'));
 await delay(900);
writeFileSync(process.env.RELAY_RESULT_PATH,JSON.stringify({type:'task.completed',jobId:request.jobId,
 taskId:request.taskId,executionId:request.executionId,leaseOwner:request.leaseOwner,attempt:request.attempt,
 adapter:request.adapter,routing:request.routing,workerSelection:request.workerSelection,context:request.executionContext,status:'COMPLETED',
 summary:'mixed executor fixture completed',output:{verified:true,model:request.routing.model,context:request.executionContext}}));`);
 const modelRoute={provider:'fixture',model:'fixture-model',decidedBy:'fixture-router',decidedAt:t0};
 const modelSelection={workerId:'fixture-model-worker',adapter:'codex',capabilities:['model'],selectedBy:'fixture-router',selectedAt:t0};
 const modelTask=(id,deps=[])=>({...task(id,'91',deps),timeoutMs:5000,agentName:'model-agent',adapter:'codex',
  capabilities:['model'],routing:modelRoute,workerSelection:modelSelection});
 writeFileSync(f.manifest,JSON.stringify({agents:{
  alpha:{executable:'/bin/sh',args:['-c','if [ "$RELAY_TASK_ID" = "101" ]; then sleep 0.3; fi; '+script]},
  'model-agent':{kind:'model',executable:process.execPath,args:[modelWorker],routing:modelRoute,workerSelection:modelSelection}
 }}));
 f.args[f.args.indexOf('20')]='2';
 try{
  store=new SQLiteRelayStore(f.db);
  await save(store,f.dir,'91',[task('101','91'),modelTask('102'),modelTask('103',['101'])]);
  await store.mutateJob('91',job=>({...job,projectPath:'src'}));
  await store.mutateJob('91',job=>({...job,reviewEnabled:false,autoMerge:false}));store.close();store=null;
  const workerEnv={...yes,AGENTS_HOME:globalRoot,AGENTS_RELAY_SHARED_ROOT:sharedRoot,AGENTS_RELAY_WORKSPACE_ROOT:f.dir};
  const first=await runAsync(f,workerEnv);assert.equal(first.code,0,first.err+first.out);
  store=new SQLiteRelayStore(f.db);let job=await store.loadJob('91');
  assert.deepEqual(job.tasks.map(t=>t.state),['SUCCEEDED','SUCCEEDED','DRAFT'],first.out);
  assert.equal(job.state,'ACTIVE','all current siblings do not authorize the not-yet-materialized dependent');
  const processSql=new DatabaseSync(f.db);
  const workerProcesses=processSql.prepare('SELECT task_id, observed_at, ended_at FROM execution_process WHERE job_id=?').all('91');
  const scriptProcess=workerProcesses.find(item=>item.task_id==='101');
  const modelProcess=workerProcesses.find(item=>item.task_id==='102');
  assert.ok(scriptProcess&&modelProcess&&scriptProcess.ended_at&&modelProcess.ended_at);
  assert.ok(Date.parse(scriptProcess.observed_at)<Date.parse(modelProcess.ended_at)
    &&Date.parse(modelProcess.observed_at)<Date.parse(scriptProcess.ended_at),'Script and Model process lifetimes must overlap');
  processSql.close();
  store.close();store=null;
  const second=once(f);
  assert.equal(second.tasksQueued,1,JSON.stringify(second));
  assert.equal(second.tasksClaimed,1,JSON.stringify(second));
  assert.equal(second.tasksSucceeded,1,JSON.stringify(second));
  store=new SQLiteRelayStore(f.db);job=await store.loadJob('91');
  assert.deepEqual(job.tasks.map(t=>t.state),['SUCCEEDED','SUCCEEDED','SUCCEEDED']);
  assert.equal(job.tasks[1].result.data.output.model,'fixture-model');
  assert.equal(job.tasks[1].result.data.output.context.role,'worker');
  assert.equal(job.tasks[1].result.data.output.context.agent.source,'project');
  assert.match(job.tasks[1].result.data.output.context.agent.path,/model-agent\.agent\.md$/);
  assert.equal(job.tasks[1].result.data.output.context.skills[0].source,'project');
  assert.match(job.tasks[1].result.data.output.context.skills[0].path,/worker-skill\/SKILL\.md$/);
  assert.equal(job.tasks[1].result.data.output.context.projectPath,realpathSync(projectDir));
  assert.equal(job.tasks[1].result.data.output.context.gitRoot,realpathSync(f.dir));
  assert.equal(job.tasks[1].result.data.output.context.instructions.some(item=>item.path.endsWith('/src/AGENTS.md')&&item.source==='project'),true);
  const nodeContext=await resolveExecutionContext(projectDir,'worker',{workspaceRoot:f.dir,sharedRoot,globalRoot});
  assert.equal(job.tasks[1].result.data.output.context.agent.path,nodeContext.agents.find(item=>item.name==='model-agent').path);
  assert.deepEqual(job.tasks[1].result.data.output.context.skills.map(item=>item.path),nodeContext.skills.filter(item=>item.name==='worker-skill').map(item=>item.path));
  assert.deepEqual(job.tasks[1].result.data.output.context.instructions.map(item=>({path:item.path,source:item.source})),nodeContext.instructions.map(item=>({path:item.path,source:item.source})));
  assert.equal(job.state,'COMPLETED');
  store.close();store=null;
  store=new SQLiteRelayStore(f.db);
  await save(store,f.dir,'93',[{...modelTask('301'),routing:{...modelRoute,model:'forged-model'}}]);
  store.close();store=null;
  const rejected=once(f);
  assert.equal(rejected.tasksClaimed,0,'a durable route conflicting with trusted executor configuration must not launch');
  store=new SQLiteRelayStore(f.db);job=await store.loadJob('93');
  assert.equal(job.tasks[0].state,'QUEUED');
  assert.equal(job.tasks[0].leaseOwner,null);
  store.close();store=null;
  store=new SQLiteRelayStore(f.db);
  await save(store,f.dir,'94',[task('401','94')]);
  await store.mutateJob('94',job=>({...job,projectPath:'../outside'}));
  store.close();store=null;
  assert.equal(once(f).tasksClaimed,0,'repository-relative context must not escape the canonical project root');
  store=new SQLiteRelayStore(f.db);job=await store.loadJob('94');
  assert.equal(job.tasks[0].state,'QUEUED');
  assert.equal(job.tasks[0].leaseOwner,null);
  store.close();store=null;
  store=new SQLiteRelayStore(f.db);
  await save(store,f.dir,'95',[task('501','95')]);
  await store.mutateJob('95',job=>({...job,projectPath:'.'}));
  store.close();store=null;
  const dotProject=once(f);
  assert.equal(dotProject.tasksClaimed,1,'dot projectPath resolves to the canonical project root');
  store=new SQLiteRelayStore(f.db);job=await store.loadJob('95');
  assert.equal(job.tasks[0].state,'SUCCEEDED');
  store.close();store=null;
  assert.equal(once(f).tasksClaimed,0,'restart must not repeat either executor generation');
  const sql=new DatabaseSync(f.db);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM workflow_action_trace').get().n,4);
  sql.close();
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('configured Codex Model Worker transports the exact shared Relay prompt Action',async()=>{
 const f=fixture();let store;
 execFileSync('git',['init','--quiet'],{cwd:f.dir});
 const projectDir=join(f.dir,'src');
 (await import('node:fs')).mkdirSync(projectDir,{recursive:true});
 writeFileSync(join(projectDir,'AGENTS.md'),'local execution rules');
 const agentDir=join(projectDir,'agents');(await import('node:fs')).mkdirSync(agentDir,{recursive:true});
 writeFileSync(join(agentDir,'implementation.agent.md'),'---\nname: implementation\n---\nFollow the fixture Agent contract.');
 const fakeCodex=join(f.dir,'fake-codex');
 const capture=join(f.dir,'codex-prompt.txt');
 const codexHome=join(f.dir,'codex-home');(await import('node:fs')).mkdirSync(codexHome,{recursive:true});
 writeFileSync(join(codexHome,'config.toml'),'model = "fixture-model"\nmodel_provider = "openai"\nmodel_reasoning_effort = "medium"\n');
 writeFileSync(join(codexHome,'worker.config.toml'),'model = "fixture-model"\nmodel_provider = "openai"\nmodel_reasoning_effort = "medium"\n');
 writeFileSync(fakeCodex,`#!${process.execPath}
import {writeFileSync} from 'node:fs';
let input='';for await(const chunk of process.stdin)input+=chunk;
writeFileSync(process.env.CAPTURE_PROMPT_PATH,input);
const args=process.argv.slice(2);
if(args[args.indexOf('--profile')+1]!=='worker'||args[args.indexOf('--model')+1]!=='fixture-model'
  ||!args.includes('model_reasoning_effort=medium'))process.exitCode=23;
const output=process.argv[process.argv.indexOf('--output-last-message')+1];
writeFileSync(output,'codex fixture completed');`);
 chmodSync(fakeCodex,0o700);
 const route={provider:'openai',model:'fixture-model',profile:'worker',reasoning:'medium',decidedBy:'fixture-router',decidedAt:t0};
 const selection={workerId:'codex-fixture',adapter:'codex',capabilities:['model'],selectedBy:'fixture-router',selectedAt:t0};
 const worker=resolve(import.meta.dirname,'../scripts/codex-model-worker.mjs');
 const cli=resolve(import.meta.dirname,'../../dist/cli.js');
 writeFileSync(f.manifest,JSON.stringify({agents:{implementation:{kind:'model',executable:process.execPath,args:[worker],
  env:{CODEX_EXECUTABLE:fakeCodex,CAPTURE_PROMPT_PATH:capture,CODEX_HOME:codexHome},routing:route,workerSelection:selection,
  promptCli:cli,promptNode:process.execPath}}}));
 try{
  store=new SQLiteRelayStore(f.db);
  const work={...task('301','91'),agentName:'implementation',adapter:'codex',capabilities:['model'],routing:route,
   workerSelection:selection,output:{kind:'task_pr'}};
  await save(store,f.dir,'91',[work],basename(f.dir));
  await store.mutateJob('91',job=>({...job,projectPath:'src'}));
  store.close();store=null;
  const raw=spawnSync(binary,f.args,{encoding:'utf8',env:yes,timeout:10000});
  assert.equal(raw.status,0,raw.stderr);
  const result=JSON.parse(raw.stdout.trim()).report;
  const executionRoot=join(f.dir,'.relay-rust-native-executions','91','301');
  const executionDir=join(executionRoot,readdirSync(executionRoot)[0]);
  const workerError=readFileSync(join(executionDir,'stderr.log'),'utf8');
  assert.equal(result.tasksSucceeded,1,`${JSON.stringify(result)}\n${workerError}`);
  store=new SQLiteRelayStore(f.db);assert.equal((await store.loadJob('91')).tasks[0].state,'SUCCEEDED');store.close();store=null;
  const captured=readFileSync(capture,'utf8');
  const snapshot=join(executionDir,'prompt-job.json');
  const generated=spawnSync(process.execPath,[cli,'prompt','--id','91','--task-id','301','--adapter','codex','--file',snapshot],
   {cwd:projectDir,encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH||'/usr/bin:/bin'}});
  assert.equal(generated.status,0,generated.stderr);
  assert.equal(captured,generated.stdout,'Codex must receive byte-identical shared prompt Action output');
  assert.match(captured,/EVENT SOURCE \(exact\): job\/91\/task\/301\/execution\//);
  assert.ok(captured.includes(join(projectDir,'AGENTS.md')),'shared prompt must include the selected project instruction reference');
  assert.match(captured,/You are implementation with responsibility/);
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('Model receipt identity and owner mismatches fail closed and are not retried on restart',async()=>{
 const route={provider:'fixture',model:'fixture-model',decidedBy:'fixture-router',decidedAt:t0};
 const selection={workerId:'fixture-model-worker',adapter:'codex',capabilities:['model'],selectedBy:'fixture-router',selectedAt:t0};
 for(const [field,value] of [['executionId','stale-execution'],['leaseOwner','stale-owner'],['attempt','99']]){
 const f=fixture();let store;
 const modelWorker=join(f.dir,'stale-model-worker.mjs');
 writeFileSync(modelWorker,`import {readFileSync,writeFileSync} from 'node:fs';
const request=JSON.parse(readFileSync(process.env.RELAY_TASK_REQUEST_PATH,'utf8'));
const receipt={type:'task.completed',jobId:request.jobId,taskId:request.taskId,executionId:request.executionId,
 leaseOwner:request.leaseOwner,attempt:request.attempt,adapter:request.adapter,routing:request.routing,
 workerSelection:request.workerSelection,status:'COMPLETED',summary:'must be rejected',output:{verified:true}};
receipt[${JSON.stringify(field)}]=${JSON.stringify(value)};
writeFileSync(process.env.RELAY_RESULT_PATH,JSON.stringify(receipt));`);
 writeFileSync(f.manifest,JSON.stringify({agents:{'model-agent':{kind:'model',executable:process.execPath,
  args:[modelWorker],env:{},routing:route,workerSelection:selection}}}));
 try{
  store=new SQLiteRelayStore(f.db);
  await save(store,f.dir,'91',[{...task('301','91'),agentName:'model-agent',adapter:'codex',capabilities:['model'],routing:route,workerSelection:selection}]);
  store.close();store=null;
  const first=once(f);
  assert.equal(first.tasksClaimed,1,JSON.stringify(first));
  assert.equal(first.tasksFailed,1,JSON.stringify(first));
  store=new SQLiteRelayStore(f.db);
  const job=await store.loadJob('91');
  assert.equal(job.tasks[0].state,'FAILED');
  assert.equal(job.tasks[0].result,null,'stale Model receipt must not persist success output');
  store.close();store=null;
  const restart=once(f);
  assert.equal(restart.tasksClaimed,0,'a failed attempt is not an implicit retry authorization');
  const sql=new DatabaseSync(f.db);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM workflow_event_outbox WHERE event_id='task.failed'").get().n,1);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM workflow_event_outbox WHERE event_id='task.completed'").get().n,0);
  sql.close();
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});}
 }
});
test('configured max_tasks bounds claims for each daemon tick',async()=>{
 const f=fixture();let store;
 try{
  f.args[f.args.indexOf('20')]='1';
  store=new SQLiteRelayStore(f.db);await save(store,f.dir,'91',[task('101','91'),task('102','91')]);store.close();store=null;
  assert.equal(once(f).tasksClaimed,1);
  store=new SQLiteRelayStore(f.db);assert.equal((await store.loadJob('91')).tasks.filter(t=>t.state==='SUCCEEDED').length,1);store.close();store=null;
  assert.equal(once(f).tasksClaimed,1);
  store=new SQLiteRelayStore(f.db);assert.deepEqual((await store.loadJob('91')).tasks.map(t=>t.state),['SUCCEEDED','SUCCEEDED']);
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('single-node daemon holds exclusive process lock while executing a Script generation',async()=>{
 const f=fixture('sleep 0.5; '+script);let store;
 try{
  store=new SQLiteRelayStore(f.db);await save(store,f.dir,'91',[task('101','91')]);store.close();store=null;
  const [a,b]=await Promise.all([runAsync(f),runAsync(f)]);
  assert.equal([a,b].filter(r=>r.code===0).length,1,'exactly one daemon must own the store');
  assert.match([a,b].find(r=>r.code!==0).err,/single-node daemon already active/);
  store=new SQLiteRelayStore(f.db);
  const j=await store.loadJob('91');assert.equal(j.tasks[0].state,'SUCCEEDED');
  const sql=new DatabaseSync(f.db);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM workflow_action_trace').get().n,1);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM execution_process').get().n,1);
  sql.close();
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('daemon refuses production or unmarked SQLite before any worker launch',async()=>{
 const f=fixture();let store;
 try{
  store=new SQLiteRelayStore(f.db);await save(store,f.dir,'91',[task('101','91')]);store.close();store=null;
  const denied=spawnSync(binary,f.args,{encoding:'utf8',env:{...process.env,RELAY_RUST_EXPERIMENTAL_TEST_ONLY:''}});
  assert.notEqual(denied.status,0);assert.match(denied.stderr,/isolated-test required/);
  const sql=new DatabaseSync(f.db);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM sqlite_master WHERE name=\'workflow_action_trace\'').get().n,0);
  sql.close();
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('daemon reopens eligible Troubleshooter once and rejects stale or wrong lineage without false success',async()=>{
 const f=fixture();let store;
 try{
  const eligible={...task('101','91',[],'FAILED'),attempt:2,error:'original failure'};
  const stale={...task('201','91',[],'FAILED'),attempt:2,error:'stale recovery episode'};
  const wrongLineage={...task('301','91',[],'FAILED'),attempt:2,error:'wrong recovery owner'};
  const missingEpisode={...task('401','91',[],'FAILED'),attempt:2,error:'missing recovery episode'};
  const unboundRecovery=terminalRecovery('402','91','401',1);
  delete unboundRecovery.recoveryForAttempt;
  store=new SQLiteRelayStore(f.db);
  await save(store,f.dir,'91',[eligible,terminalRecovery('102','91','101',1),
   stale,terminalRecovery('202','91','201',2),wrongLineage,terminalRecovery('302','91','999',1),
   missingEpisode,unboundRecovery]);
  store.close();store=null;

  const first=once(f);
  assert.equal(first.tasksReopened,1,JSON.stringify(first));
  assert.equal(first.tasksClaimed,0,'reopened Troubleshooter must remain queued without a worker receipt');
  store=new SQLiteRelayStore(f.db);
  const job=await store.loadJob('91');
  assert.deepEqual(job.tasks.map(t=>t.state),['FAILED','QUEUED','FAILED','SUCCEEDED','FAILED','SUCCEEDED','FAILED','SUCCEEDED']);
  assert.equal(job.tasks[0].state,'FAILED','original failure must remain failed');
  assert.equal(job.tasks[1].recoveryForAttempt,2);
  assert.equal(job.tasks[1].result.data.summary,'preserved terminal recovery evidence');
  assert.deepEqual(job.tasks[1].executionHistory,[{id:'old-recovery-execution',attempt:1,startedAt:t0}]);
  assert.equal(job.tasks[1].error,null);
  assert.equal(job.tasks[1].failureReason,undefined);
  assert.equal(job.tasks[1].leaseOwner,null);
  assert.equal(job.tasks[1].leaseExpiresAt,null);
  assert.equal(job.tasks[1].executionId,null);
  assert.equal(job.tasks[3].recoveryForAttempt,2,'stale episode must remain untouched');
  assert.equal(job.tasks[5].state,'SUCCEEDED','wrong parent identity must remain untouched');
  assert.equal(job.tasks[7].state,'SUCCEEDED','missing recovery episode must remain untouched');
  store.close();store=null;

  const restart=once(f);
  assert.equal(restart.tasksReopened,0,'restart must not reopen the same failure episode again');
  assert.equal(restart.tasksClaimed,0,'no process receipt may complete the recovery');
  const sql=new DatabaseSync(f.db);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM workflow_event_outbox WHERE event_id='troubleshooter.reopened'").get().n,1);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM workflow_event_outbox WHERE event_id='task.completed'").get().n,0);
  sql.close();
  console.log('Troubleshooter recovery: Graph-selected reopen persisted once; stale/wrong lineage and false completion rejected');
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('SIGKILL daemon -> helper kills owned worker -> restart marks proven expired execution FAILED once',async()=>{
 const f=fixture('sleep 20; '+script);let store,daemon,pid;
 try{
  store=new SQLiteRelayStore(f.db);
  const t=task('101','91');t.timeoutMs=1200;
  await save(store,f.dir,'91',[t]);store.close();store=null;
  daemon=spawn(binary,f.args,{env:yes,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';daemon.stdout.on('data',b=>stdout+=b);daemon.stderr.on('data',b=>stderr+=b);
  pid=await until(()=>{
   const db=new DatabaseSync(f.db);let row;
   try{row=db.prepare('SELECT pid FROM execution_process LIMIT 1').get();}catch{}
   db.close();return row?.pid;
  },6500);
  assert.ok(alive(pid),'worker must be active before daemon death');
  daemon.kill('SIGKILL');
  await until(()=>!alive(pid),6000);
  await until(()=>absent(pid),6000);
  store=new SQLiteRelayStore(f.db);
  assert.equal((await store.loadJob('91')).tasks[0].state,'RUNNING');
  // Advance only the disposable Task lease clock; the real Worker has
  // already been reaped by the helper after a physical SIGKILL of daemon.
  await store.mutateJob('91',j=>{
    j.tasks[0].leaseExpiresAt=new Date(Date.now()-500).toISOString();
    return j;
  });
  store.close();store=null;
  const restart=once(f);
  assert.equal(restart.tasksRecovered,1,JSON.stringify(restart));
  assert.equal(restart.tasksClaimed,0,'orphan recovery does not auto-retry');
  store=new SQLiteRelayStore(f.db);
  const finishedTask=(await store.loadJob('91')).tasks[0];
  assert.equal(finishedTask.state,'FAILED');assert.equal(finishedTask.executionId,null);
  assert.equal(finishedTask.failureReason,'worker_outcome_unknown');
  assert.equal(finishedTask.executionHistory.length,1);
  const sql=new DatabaseSync(f.db);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM workflow_event_outbox WHERE event_id=\'task.failed\'').get().n,1);
  sql.close();
  assert.equal(once(f).tasksRecovered,0,'replay of recovery must be idempotent');
  console.log('SIGKILL real daemon: helper reaped worker; verified lease expiry -> single FAILED recovery event');
 }finally{
  daemon?.kill('SIGKILL');
  if(pid&&alive(pid)){try{process.kill(-pid,'SIGKILL');}catch{}}
  store?.close();await delay(80);rmSync(f.dir,{recursive:true,force:true});
 }
});

test('SIGTERM daemon cancels running helper Worker promptly, persists FAILED without false success',async()=>{
 const f=fixture('sleep 20; '+script);let store,daemon,pid;
 try{
  store=new SQLiteRelayStore(f.db);
  const t=task('101','91');t.timeoutMs=20000;
  await save(store,f.dir,'91',[t]);store.close();store=null;
  daemon=spawn(binary,f.args,{env:yes,stdio:['ignore','pipe','pipe']});
  const exit=new Promise(resolvePromise=>daemon.once('close',(code,signal)=>resolvePromise({code,signal})));
  pid=await until(()=>{
   const db=new DatabaseSync(f.db);let row;
   try{row=db.prepare('SELECT pid FROM execution_process LIMIT 1').get();}catch{}
   db.close();return row?.pid;
  },5000);
  assert.ok(alive(pid));
  daemon.kill('SIGTERM');
  const outcome=await Promise.race([exit,delay(3600).then(()=>({code:'TIMEOUT'}))]);
  assert.equal(outcome.code,0,'graceful signal should cancel helper, not wait 20s');
  await until(()=>!alive(pid),3500);
  store=new SQLiteRelayStore(f.db);
  const job=await store.loadJob('91');
  assert.equal(job.tasks[0].state,'FAILED');
  assert.equal(job.tasks[0].result,null);
  assert.equal(job.state,'ACTIVE');
  const sql=new DatabaseSync(f.db);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM execution_process WHERE ended_at IS NOT NULL').get().n,1);
  sql.close();
 }finally{
  daemon?.kill('SIGKILL');
  if(pid&&alive(pid)){try{process.kill(-pid,'SIGKILL');}catch{}}
  store?.close();await delay(80);rmSync(f.dir,{recursive:true,force:true});
 }
});

test('expired leased Task without durable PID is BLOCKED, not retried or falsely completed',async()=>{
 const f=fixture();let store;
 try{
  store=new SQLiteRelayStore(f.db);
  const original=task('101','91');original.state='RUNNING';
  original.attempt=1;original.leaseOwner='rust-native-isolated';
  original.executionId='orphan-before-pid';
  original.leaseExpiresAt='2026-11-13T20:00:01.000Z';
  original.executionHistory=[{id:'orphan-before-pid',attempt:1,startedAt:t0}];
  await save(store,f.dir,'91',[original]);store.close();store=null;
  const result=once(f);
  assert.equal(result.tasksRecovered,0);
  assert.equal(result.tasksClaimed,0);
  assert.match(result.blocked.join(' '),/no durable PID/);
  store=new SQLiteRelayStore(f.db);
  const restored=(await store.loadJob('91')).tasks[0];
  assert.equal(restored.state,'RUNNING');
  assert.equal(restored.executionId,'orphan-before-pid');
  assert.equal(restored.failureReason,undefined);
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('Script output symlink cannot escape isolated DB root',async()=>{
 const f=fixture();const target=mkdtempSync(join(tmpdir(),'relay-native-symlink-target-'));let store;
 try{
  symlinkSync(target,join(f.dir,'.relay-rust-native-executions'));
  store=new SQLiteRelayStore(f.db);
  await save(store,f.dir,'91',[task('101','91')]);store.close();store=null;
  const report=once(f);
  assert.equal(report.tasksClaimed,0);
  assert.match(report.blocked.join(' '),/unsafe symlink/);
  assert.equal(existsSync(join(target,'91')),false);
  store=new SQLiteRelayStore(f.db);
  assert.equal((await store.loadJob('91')).tasks[0].state,'QUEUED');
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});rmSync(target,{recursive:true,force:true});}
});

test('native --loop polls unchanged SQLite without writes and exits cleanly on SIGTERM',async()=>{
 const f=fixture();let store,daemon;
 try{
  store=new SQLiteRelayStore(f.db);
  await save(store,f.dir,'91',[]);store.close();store=null;
  daemon=spawn(binary,['--loop',...f.args.filter(arg=>arg!=='--once'),'--interval-ms','150'],
   {env:yes,stdio:['ignore','pipe','pipe']});
  let output='',errors='';daemon.stdout.on('data',b=>output+=b);daemon.stderr.on('data',b=>errors+=b);
  const exited=new Promise(resolvePromise=>daemon.once('close',(code,signal)=>resolvePromise({code,signal})));
  await until(()=>output.split('\n').filter(line=>line.includes('"type":"tick"')).length>=2,3500);
  daemon.kill('SIGTERM');
  const result=await Promise.race([exited,delay(2200).then(()=>({code:'TIMEOUT'}))]);
  assert.equal(result.code,0,errors);
  store=new SQLiteRelayStore(f.db);
  const j=await store.loadJob('91');
  assert.equal(j.updatedAt,t0,'idle ticks must not rewrite snapshots');
  assert.equal(j.tasks.length,0);
 }finally{daemon?.kill('SIGKILL');store?.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('single-node lock excludes concurrent dependency ticks',async()=>{
 const f=fixture('sleep 0.5; '+script);let store;
 try{
  store=new SQLiteRelayStore(f.db);
  const completed=task('101','91');completed.state='SUCCEEDED';
  await save(store,f.dir,'91',[completed,task('102','91',['101'],'DRAFT')]);
  store.close();store=null;
  const attempts=await Promise.all([runAsync(f),runAsync(f)]);
  assert.equal(attempts.filter(result=>result.code===0).length,1);
  assert.match(attempts.find(result=>result.code!==0).err,/single-node daemon already active/);
  store=new SQLiteRelayStore(f.db);
  const tasks=(await store.loadJob('91')).tasks;
  assert.equal(tasks[1].state,'SUCCEEDED');
  assert.equal(tasks[1].attempt,1);
  const sql=new DatabaseSync(f.db);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM workflow_action_trace').get().n,1);
  sql.close();
 }finally{store?.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('single-node daemon lock persists across idle ticks and recovers after physical SIGKILL',async()=>{
 const f=fixture();let daemon,store;
 try{
  store=new SQLiteRelayStore(f.db);
  await save(store,f.dir,'91',[]);store.close();store=null;
  daemon=spawn(binary,['--loop',...f.args.filter(value=>value!=='--once'),'--interval-ms','150'],
   {env:yes,stdio:['ignore','pipe','pipe']});
  let output='';daemon.stdout.on('data',chunk=>output+=chunk);
  await until(()=>output.split('\n').filter(line=>line.includes('"type":"tick"')).length>=2,5000);
  const denied=spawnSync(binary,f.args,{encoding:'utf8',env:yes,timeout:2200});
  assert.notEqual(denied.status,0,'idle lock is not released between ticks');
  assert.match(denied.stderr,/single-node daemon already active/);
  daemon.kill('SIGKILL');
  await until(()=>daemon.exitCode!==null||daemon.signalCode!==null,4000);
  const resumed=once(f);
  assert.equal(resumed.tasksClaimed,0);
  store=new SQLiteRelayStore(f.db);
  assert.equal((await store.loadJob('91')).updatedAt,t0,'reacquire after SIGKILL is read-only');
 }finally{daemon?.kill('SIGKILL');store?.close();rmSync(f.dir,{recursive:true,force:true});}
});
});
