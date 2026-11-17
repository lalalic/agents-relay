import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { managedWorkerInput } from '../dist/managed-worker-input.js';
import { resolveExecutionContext } from '../dist/execution-context.js';
import { ChatGptAdapter } from '../dist/adapters.js';
import { zBootstrap,zTaskBrief } from '../dist/z-adapter.js';
import { localGitProject } from './local-git-project.js';
const exec=promisify(execFile);
const digest=x=>createHash('sha256').update(x).digest('hex');
const executionId='123e4567-e89b-12d3-a456-426614174000';

for(const adapter of ['codex','chatgpt','z'])test(`Graph Action and prompt CLI are identical for ${adapter} Task 476`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-prompt-action-parity-'));
  try{
    const project=localGitProject(root,'repo');
    await writeFile(join(project,'AGENTS.md'),'# Independent test project\n');
    const task={id:'476',jobId:'537',title:'Work',state:'QUEUED',agentName:'implementation',kind:'work',adapter,
      executionId,input:'SECRET_LONG_TASK_DESCRIPTION',output:{kind:'file',path:'runs/expected.txt'},attempt:1,maxAttempts:3,dependencies:[]};
    const job={id:'537',repository:'repo',title:'Example',objective:'PRIVATE JOB OBJECTIVE',state:'ACTIVE',tasks:[task],plans:[],prNumber:0,projectRoot:project};
    const file=join(root,'job.json');await writeFile(file,JSON.stringify(job));
    const cx=await resolveExecutionContext(project,'worker');
    const actual=await managedWorkerInput(job,task,cx);
    const {stdout}=await exec(process.execPath,['dist/cli.js','prompt','--file',file,'--id','537','--task-id','476','--adapter',adapter],{cwd:resolve('.'),timeout:20_000});
    assert.equal(stdout.trimEnd(),actual);
    assert.match(actual,/^# Role/);assert.match(actual,/## Contracts\n/);
    assert.match(actual,/## Contexts\n/);assert.match(actual,/## Task\n/);
    assert.match(actual,/Job: 537\nTask: 476\nExecution: 123e4567/);
    for(const secret of [task.input,job.objective])assert.ok(!actual.includes(secret));
    const agentRef=/with responsibility at (\/[^\n ]+\.md)\./.exec(actual);
    assert.ok(agentRef);
    assert.equal(digest(await readFile(agentRef[1],'utf8')),basename(agentRef[1],'.md'));
    const listed=[...actual.matchAll(/^\d+\. (?:\[[^\]]+\] )?(\/\S+\.md)$/gm)];
    assert.ok(listed.length>=2);
    for(const [,path]of listed)await readFile(path);
    assert.doesNotMatch(actual,/\(sha256:/);
    assert.match(actual,/Use the agents-relay skill to read/);
    assert.doesNotMatch(actual,/Use the agents-relay skill at \//);
    if(adapter==='chatgpt'){
      const requests=[];
      const browser=new ChatGptAdapter({agentRunner:(_definition,request)=>{
        requests.push(request);return {promise:Promise.resolve(JSON.stringify({status:'submitted',mode:'new-thread',temporary:false,verified:true,thread_id:'abcdefgh1234',thread_url:'https://chatgpt.com/c/abcdefgh1234'})),cancel(){}};
      }});
      await browser.launch({...task,input:actual,routing:{provider:'openai',model:'gpt-6'}},new AbortController().signal,{waitForTerminal:Promise.resolve()}).promise;
      assert.equal(requests[0].prompt,actual);
    }
    if(adapter==='z'){
      const runtime=zBootstrap('RUNTIME_SECRET_PLACEHOLDER',actual);
      assert.match(runtime,/^# Role\n/);
      assert.match(runtime,/## Bootstrap\nOAuth access token: RUNTIME_SECRET_PLACEHOLDER/);
      assert.equal(runtime.replace('OAuth access token: RUNTIME_SECRET_PLACEHOLDER\n',''),actual);
      assert.doesNotMatch(runtime,/Z\.ai Full-Stack worker|FIRST ACTION:|\(sha256:/);
    }

  }finally{await rm(root,{recursive:true,force:true});}
});

test('Planner context CLI accepts only the active persisted Plan execution',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'relay-plan-context-'));
  try{
    const project=localGitProject(dir,'repo');
    await writeFile(join(project,'AGENTS.md'),'# Independent planner project\n');
    const plan={id:'plan-2',jobId:'537',status:'PLANNING',executionId,round:2,source:'model-planner',previousPlanId:'plan-1',trigger:{source:'manual'},assessment:'Pending',generatedTaskIds:[],createdAt:'2026-10-31T17:00:00Z',updatedAt:'2026-10-31T17:00:00Z'};
    const job={id:'537',repository:'repo',title:'Objective',objective:'Plan the tasks',state:'ACTIVE',projectRoot:project,tasks:[],plans:[plan],prNumber:0};
    const file=join(dir,'job.json');await writeFile(file,JSON.stringify(job));
    const args=['dist/cli.js','plan','context','--file',file,'--repo','repo','--id','537','--plan-id','plan-2','--execution-id',executionId];
    const result=await exec(process.execPath,args,{cwd:resolve('.'),timeout:20_000});
    const content=JSON.parse(result.stdout);
    assert.equal(content.plan_execution.planId,'plan-2');
    assert.match(content.apply_cli,/--id 537 --plan-id plan-2 --execution-id/);
    await assert.rejects(exec(process.execPath,args.map((arg,index)=>args[index-1]==='--execution-id'?'stale-identity':arg),{cwd:resolve('.'),timeout:20_000}),/Stale Plan execution/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
