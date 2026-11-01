import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { managedWorkerInput } from '../dist/managed-worker-input.js';
import { resolveExecutionContext } from '../dist/execution-context.js';
import { ChatGptAdapter } from '../dist/adapters.js';
import { zBootstrap,zTaskBrief } from '../dist/z-adapter.js';
const exec=promisify(execFile);
const digest=x=>createHash('sha256').update(x).digest('hex');
const executionId='123e4567-e89b-12d3-a456-426614174000';

for(const adapter of ['codex','chatgpt','z'])test(`Graph Action and prompt CLI are identical for ${adapter} Task 476`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'relay-prompt-action-parity-'));
  try{
    const project=resolve('.'),task={id:'476',jobId:'537',title:'Work',state:'QUEUED',agentName:'implementation',kind:'work',adapter,
      executionId,input:'SECRET_LONG_TASK_DESCRIPTION',output:{kind:'file',path:'runs/expected.txt'},attempt:1,maxAttempts:3,dependencies:[]};
    const job={id:'537',repository:'lalalic/neo',title:'Example',objective:'PRIVATE JOB OBJECTIVE',state:'ACTIVE',tasks:[task],plans:[],prNumber:0,projectPath:project};
    const file=join(root,'job.json');await writeFile(file,JSON.stringify(job));
    const cx=await resolveExecutionContext(project,'worker');
    const actual=await managedWorkerInput(job,task,cx);
    const {stdout}=await exec(process.execPath,['dist/cli.js','prompt','--file',file,'--id','537','--task-id','476','--adapter',adapter,'--project-path',project],{cwd:project,timeout:20_000});
    assert.equal(stdout.trimEnd(),actual);
    assert.match(actual,/^# Role/);assert.match(actual,/## Contracts\n/);
    assert.match(actual,/## Contexts\n/);assert.match(actual,/## Task\n/);
    assert.match(actual,/Job: 537\nTask: 476\nExecution: 123e4567/);
    for(const secret of [task.input,job.objective])assert.ok(!actual.includes(secret));
    const agentRef=/with responsibility at (\/[^\n ]+\.md) \(sha256:([a-f0-9]{64})\)/.exec(actual);
    assert.ok(agentRef);
    assert.equal(digest(await readFile(agentRef[1],'utf8')),agentRef[2]);
    const listed=[...actual.matchAll(/^\d+\. (?:\[[^\]]+\] )?(\/\S+) \(sha256:([a-f0-9]{64})\)$/gm)];
    assert.ok(listed.length>=3);
    for(const [,path,hash]of listed)assert.equal(digest(await readFile(path)),hash);
    if(adapter==='chatgpt'){
      const requests=[];
      const browser=new ChatGptAdapter({agentRunner:(_definition,request)=>{
        requests.push(request);return {promise:Promise.resolve(JSON.stringify({status:'submitted',mode:'new-thread',temporary:false,verified:true,thread_id:'abcdefgh1234',thread_url:'https://chatgpt.com/c/abcdefgh1234'})),cancel(){}};
      }});
      await browser.launch({...task,input:actual,routing:{provider:'openai',model:'gpt-6'}},new AbortController().signal,{waitForTerminal:Promise.resolve()}).promise;
      assert.equal(requests[0].prompt,actual);
    }
    if(adapter==='z'){
      const bootstrap=zBootstrap('RUNTIME_SECRET_PLACEHOLDER',actual);
      assert.equal(bootstrap+'\n'+zTaskBrief(actual),bootstrap+'\n'+actual);
      assert.ok(bootstrap.includes('https://neoy.qili2.com/files/z-chat/bootstrap.md'));
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('Planner context CLI accepts only the active persisted Plan execution',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'relay-plan-context-'));
  try{
    const project=resolve('.');
    const plan={id:'plan-2',jobId:'537',status:'PLANNING',executionId,round:2,source:'model-planner',previousPlanId:'plan-1',trigger:{source:'manual'},assessment:'Pending',generatedTaskIds:[],createdAt:'2026-10-31T17:00:00Z',updatedAt:'2026-10-31T17:00:00Z'};
    const job={id:'537',repository:'lalalic/neo',title:'Objective',objective:'Plan the tasks',state:'ACTIVE',projectPath:project,tasks:[],plans:[plan],prNumber:0};
    const file=join(dir,'job.json');await writeFile(file,JSON.stringify(job));
    const args=['dist/cli.js','plan','context','--file',file,'--repo','lalalic/neo','--id','537','--plan-id','plan-2','--execution-id',executionId,'--project-path',project];
    const result=await exec(process.execPath,args,{cwd:project,timeout:20_000});
    const content=JSON.parse(result.stdout);
    assert.equal(content.plan_execution.planId,'plan-2');
    assert.match(content.apply_cli,/--id 537 --plan-id plan-2 --execution-id/);
    await assert.rejects(exec(process.execPath,[...args.slice(0,-3),'stale-identity','--project-path',project],{cwd:project,timeout:20_000}),/Stale Plan execution/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
