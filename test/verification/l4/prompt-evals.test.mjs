import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { resolveExecutionContext } from '../../../dist/execution-context.js';
import { managedWorkerInput } from '../../../dist/managed-worker-input.js';
import { buildPlannerExecutionPrompt } from '../../../dist/planner.js';
import { zBootstrap, zTaskBrief, zExecutionSource } from '../../../dist/z-adapter.js';
import { SQLiteRelayStore } from '../../../dist/relay-store.js';
const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const vlog = process.env.RELAY_L4_VLOG_PROJECT ?? '/Users/chengli/Workspace/neo/vlog';
const sha = data => createHash('sha256').update(data).digest('hex');
const adapters = ['codex','chatgpt','z'];
const roles = ['planner','implementation','reviewer','troubleshooter','vlog-producer','vlog-final-qa'];
// Generating a prompt does NOT mean the Router can launch every role/adapter.
function deliveryGate(role,adapter){
 if(role==='planner' && adapter!=='codex')return 'PREVIEW_ONLY_PLANNER_CODEX';
 if(role==='troubleshooter' && adapter!=='codex')return 'UNSUPPORTED_AGENT_RUNTIME';
 if(role==='vlog-producer' && adapter!=='chatgpt')return 'UNSUPPORTED_INTERACTIVE_PREVIEW';
 if(role==='vlog-final-qa' && adapter!=='chatgpt')return 'NEEDS_MEDIA_PLAYBACK_PROOF';
 return 'BOOTSTRAP_CAPABLE_NOT_TERMINAL_E2E';
}
const evaluated=[];

const execution = '123e4567-e89b-12d3-a456-426614174000';
const jobId = 'L4-JOB';

function parsePrompt(prompt) {
  const role=/^# Role\nYou are ([\w-]+) with responsibility at (\/[^\s]+\.md) \(sha256:([a-f0-9]{64})\)\./m.exec(prompt);
  assert.ok(role, 'Role must identify ONE immutable Agent snapshot');
  const segments = {};
  for(const name of ['Bootstrap','Contracts','Contexts','Task']) {
    const match=new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`,'m').exec(prompt);
    assert.ok(match, `Missing ${name}`);
    segments[name]=match[1].trim();
  }
  return {role:{name:role[1],path:role[2],sha256:role[3]},...segments};
}
function parsedAgentPath(prompt) {
  const match=/^You are [^\n]+ at (\/[^\s]+\.md) \(sha256:[a-f0-9]{64}\)\./m.exec(prompt);
  assert.ok(match,'Role reference missing');
  return match[1];
}
async function validateReferences(prompt) {
  const {role}=parsePrompt(prompt);
  const agent=await readFile(role.path);
  assert.equal(sha(agent),role.sha256,'Agent snapshot content is immutable');
  const refs=[...prompt.matchAll(/(?:\d+\. (?:\[\w+\] )?|the agents-relay skill at )(\/[^\s]+) \(sha256:([a-f0-9]{64})\)/g)];
  assert.ok(refs.length>=2,'At least one domain contract and agents-relay skill');
  for(const [,path,digest] of refs)assert.equal(sha(await readFile(path)),digest,`Reference is readable and pinned: ${path}`);
  return {agent:agent.toString(),refs:refs.map(r=>r[1])};
}

let contextPromise;
const context=()=>contextPromise??=resolveExecutionContext(vlog,'worker');

for(const adapter of adapters)for(const role of roles) {
  test(`L4 generated prompt: ${role} × ${adapter}`,async()=>{
    const cx=await context();
    const job={id:jobId,repository:'local/l4',title:'Vlog L4 evaluation',objective:'Use actual Vlog project policies',state:'ACTIVE',plans:[],tasks:[],prNumber:0};
    const gate=deliveryGate(role,adapter);
    let prompt;
    if(role==='planner'){
      prompt=await buildPlannerExecutionPrompt({job,tasks:[],objective:job.objective,previousPlannerTaskId:null,
        planExecution:{planId:'plan-1',executionId:execution},executionContext:cx},undefined,adapter);
    }else{
      const task={id:'L4-TASK',jobId,kind:'work',state:'QUEUED',adapter,agentName:role,input:'PRIVATE L4 BUSINESS TASK CONTENT',
        output:{kind:'file',path:'runs/l4-output.md'},executionId:execution,attempt:1,maxAttempts:1,dependencies:[],
        ...(role==='vlog-producer'?{workerRequirements:{capabilities:['chatgpt','webhelm'],runtime:'chatgpt'}}:{})};
      job.tasks=[task];
      if(gate.startsWith('UNSUPPORTED')){
        await assert.rejects(managedWorkerInput(job,task,cx),/requires .* runtime/,
          'A mismatched Agent/Task runtime must fail closed before any Prompt is built');
        evaluated.push({role,adapter,gate,promptSha256:null,promptChars:0,dispatchRejected:true});
        return;
      }
      prompt=await managedWorkerInput(job,task,cx);
    }
    // Exact Graph Action / read-only CLI parity, for EVERY role/adapter pair.
    const cliRoot=await mkdtemp(join(tmpdir(),'relay-l4-cli-'));
    try {
      const plan=role==='planner' ? [{jobId,id:'plan-1',round:1,status:'PLANNING',source:'model-planner',previousPlanId:null,
        trigger:{source:'manual'},executionId:execution,createdAt:'2026-11-01T12:00:00Z',updatedAt:'2026-11-01T12:00:00Z',generatedTaskIds:[]}] : [];
      const fixture=join(cliRoot,'job.json');
      await writeFile(fixture,JSON.stringify({...job,plans:plan,projectPath:vlog}));
      const arg=role==='planner'?['--plan-id','plan-1']:['--task-id','L4-TASK'];
      const result=await exec(process.execPath,['dist/cli.js','prompt','--file',fixture,'--id',jobId,'--project-path',vlog,'--adapter',adapter,...arg],{cwd:repo,timeout:20000});
      assert.equal(result.stdout.trimEnd(),prompt,'CLI and actual Graph Action must use identical builder output');
    }finally{await rm(cliRoot,{recursive:true,force:true});}
    const parsed=parsePrompt(prompt);
    const refs=await validateReferences(prompt);
    // External Role/Contract/Skill instructions must not expose Relay internals.
    // They may describe the CLI and the separately owned Task event protocol.
    const publicRefs=[parsedAgentPath(prompt),...refs.refs.filter(path=>
      path.includes('/contracts/')||path.endsWith('/SKILL.md'))];
    for(const path of publicRefs) {
      const content=await readFile(path,'utf8');
      assert.doesNotMatch(content,/sqlite|relaystore|reconciler|projection outbox|\/api\/events|127\.0\.0\.1:8787/i,
        `Private Relay implementation leaked into externally consumed instruction: ${path}`);
    }

    assert.match(gate,/^(?:BOOTSTRAP_CAPABLE|UNSUPPORTED|PREVIEW_ONLY|NEEDS_)/);
    if(role==='troubleshooter' && adapter!=='codex')assert.equal(cx.agents.find(item=>item.name===role)?.runtime,'codex');
    if(role==='vlog-producer' && adapter!=='chatgpt')assert.match(refs.agent,/ChatGPT|interactive preview/i);
    if(role==='implementation')assert.doesNotMatch(refs.agent,/Task input retrieved from GitHub|^runtime: codex$/m);
    evaluated.push({role,adapter,gate,promptSha256:sha(prompt),promptChars:prompt.length});
    // Optional human review: save the actual unwrapped Action prompt for each
    // supported role/adapter pair. Never persist a dynamic OAuth credential.
    if(process.env.RELAY_L4_OUTPUT_DIR){
      const {mkdir}=await import('node:fs/promises');
      const target=process.env.RELAY_L4_OUTPUT_DIR;
      await mkdir(target,{recursive:true,mode:0o700});
      await writeFile(join(target,`${role}-${adapter}.txt`),prompt+'\n',{mode:0o600});
    }
    assert.equal(parsed.role.name,role);
    assert.ok(!prompt.includes('PRIVATE L4 BUSINESS TASK CONTENT'),'Task details must come from SQLite only');
    assert.match(parsed.Task,new RegExp(`Job: ${jobId}\\nTask: ${role==='planner'?'plan-1':'L4-TASK'}\\nExecution: ${execution}`));
    assert.match(parsed.Task,/agents-relay skill.*Relay CLI/);
    assert.match(parsed.Task,/All Relay state reads and operations use that version-matched CLI/);
    const skillPath=/Use the agents-relay skill at (\/\S+\/SKILL\.md)/.exec(parsed.Task)?.[1];
    assert.ok(skillPath,'Work bootstrap must specify an exact installed Skill');
    const packageCli=resolve(dirname(skillPath),'../../dist/cli.js');
    await readFile(packageCli);
    assert.match((await readFile(skillPath,'utf8')),/matching-absolute-dist\/cli\.js/,
      'Skill must direct the Worker to the same-version CLI, not an old globally installed binary');
    assert.doesNotMatch(parsed.Contexts,/README\.md|\/\.agents\/AGENTS\.md/,'README and global instructions are not Task context');
    assert.doesNotMatch(parsed.Contexts,/\[neo\]/,'Parent Neo context is loaded by harness or project policy on demand, not repeated');
    if(role!=='planner' && adapter==='codex')assert.match(parsed.Contexts,/None required at startup/);
    if(role!=='planner' && adapter!=='codex')assert.match(parsed.Contexts,/\[project\].*\/AGENTS\.md/);
    assert.doesNotMatch(prompt,/inline immutable local reference snapshots|Job URL: null|Task URL: null/);
    if(role==='planner'){
      assert.match(refs.agent,/Vlog Graph-first Episode planning/);
      assert.match(refs.agent,/read `graph\.mmd` from the resolved Vlog project root/);
      assert.doesNotMatch(refs.agent,/`vlog\/graph\.mmd`/);
      await readFile(join(vlog,'graph.mmd'));
      assert.match(refs.agent,/graph\.mmd/);
      assert.match(parsed.Contracts,/task-job-contract\.md/);
      assert.doesNotMatch(parsed.Contracts,/event-contract\.md|events-bus\/references\/protocol/);
       assert.doesNotMatch(parsed.Contracts,/task\.started|task\.completed|task\.failed|Events contract/i);
      assert.match(parsed.Contracts,/plan context|plan apply|PLAN_APPLIED/);
      assert.match(parsed.Contexts,/None required at startup/);
      assert.doesNotMatch(prompt,/task\.started|task\.completed|task\.progress/);
      assert.ok(!refs.refs.some(x=>x.endsWith('event-contract.md')));
    }else{
      assert.match(parsed.Contracts,/task-job-contract\.md/);
      assert.match(parsed.Contracts,/event-contract\.md/);
      assert.match(parsed.Contracts,/events-bus\/references\/protocol\.md/);
      assert.match(parsed.Contracts,new RegExp(`EVENT SOURCE \\(exact\\): job/${jobId}/task/L4-TASK/execution/${execution}`));
      for(const word of ['task.started','task.progress','task.completed','task.failed'])assert.ok(parsed.Contracts.includes(word),word);
      assert.match(parsed.Contracts,/exactly ONE/);
      if(role==='reviewer')assert.match(refs.agent,/verdict|head_sha|review target/i);
      if(role==='troubleshooter')assert.match(refs.agent,/diagnos|recovery|failed task/i);
      if(role==='implementation')assert.match(refs.agent,/implement|task/i);
      if(role==='vlog-producer')assert.match(refs.agent,/episode stage contract|episode-stage-contract/);
      if(role==='vlog-final-qa')assert.match(refs.agent,/QA|review|evidence/i);
    }
    if(adapter==='codex'){
      assert.match(parsed.Bootstrap,/project cwd/);
      assert.match(parsed.Bootstrap,/AGENTS\.md/);
      assert.match(parsed.Bootstrap,/local shell/);
    }else if(adapter==='chatgpt'){
      assert.match(parsed.Bootstrap,/Default Instructions/);
      assert.match(parsed.Bootstrap,/Neo MCP fs\/shell/);
      assert.doesNotMatch(parsed.Bootstrap,/NEO_ACCESS_TOKEN=|Bearer [A-Za-z0-9_-]{20}/i);
    }else{
      assert.match(parsed.Bootstrap,/neoy\.qili2\.com\/files\/z-chat\/bootstrap\.md/);
      assert.match(parsed.Bootstrap,/OAuth/);
      assert.doesNotMatch(parsed.Bootstrap,/NEO_ACCESS_TOKEN=|Bearer [A-Za-z0-9_-]{20}/,'No credentials in printable Action Prompt');
      if(role!=='planner'){
        assert.equal(zTaskBrief(prompt),prompt,'Z cannot rewrite Task Prompt');
        const runtime=zBootstrap('L4_NON_SECRET_TEST_TOKEN',prompt);
        assert.match(runtime,/task.started/);
        assert.equal(zExecutionSource(prompt),`job/${jobId}/task/L4-TASK/execution/${execution}`);
        assert.match(runtime,/Graph Action Task Prompt/);
        assert.equal(runtime+'\n'+zTaskBrief(prompt),runtime+'\n'+prompt);
      }
    }
  });
}

test('L4 execution-scoped CLI loads a real isolated SQLite Plan and Task, rejects stale identities',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'relay-prompt-l4-sqlite-'));
  const db=join(dir,'relay.sqlite');const store=new SQLiteRelayStore(db,jobId);
  const at='2026-11-01T15:00:00.000Z';
  const task={id:'L4-TASK',jobId,title:'L4 implementation',kind:'work',state:'RUNNING',agentName:'implementation',adapter:'codex',executionId:execution,
    attempt:1,maxAttempts:1,leaseOwner:'L4',leaseExpiresAt:'2026-12-01T00:00:00Z',input:'PRIVATE INPUT FROM SQLITE',
    output:{kind:'file',path:'l4-output.txt'},dependencies:[],createdAt:at,updatedAt:at};
  const plan={jobId,id:'plan-1',round:1,status:'PLANNING',source:'model-planner',executionId:execution,generatedTaskIds:[],trigger:{source:'manual'},previousPlanId:null,
    assessment:'Planning',attempt:1,maxAttempts:1,createdAt:at,updatedAt:at};
  const job={id:jobId,repository:'local/l4',prNumber:0,title:'L4 isolated Job',objective:'PRIVATE OBJECTIVE FROM SQLITE',state:'ACTIVE',
    createdAt:at,updatedAt:at,tasks:[task],plans:[plan],projectPath:vlog};
  try {
    await store.saveJob(job);
    const env={...process.env,AGENTS_RELAY_STORE_DIR:join(dir,'stores')};
    for(const [kind,args] of [
      ['task',['task','context','--id',jobId,'--task-id','L4-TASK','--execution-id',execution]],
      ['plan',['plan','context','--id',jobId,'--plan-id','plan-1','--execution-id',execution]],
    ]) {
      const result=await exec(process.execPath,['dist/cli.js',...args,'--project-path',vlog],{cwd:repo,env,timeout:20000});
      assert.match(result.stdout,/PRIVATE/,'Domain intent is reachable through real SQLite');
      if(kind==='plan'){
        const data=JSON.parse(result.stdout);
        assert.match(data.apply_cli,/node \"?[^\n]+\/dist\/cli\.js\"? plan apply/);
        assert.doesNotMatch(data.apply_cli,/^agents-relay plan apply/,'Global CLI could be an old version');
      }
      const mismatch=[...args];mismatch[mismatch.indexOf('--execution-id')+1]='00000000-0000-4000-8000-000000000000';
      await assert.rejects(exec(process.execPath,['dist/cli.js',...mismatch,'--project-path',vlog],{cwd:repo,env,timeout:20000}),/Stale (Task|Plan) execution/);
    }
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('L4 evaluation manifest explicitly distinguishes Prompt validity from executable adapter capability',async()=>{
 assert.equal(evaluated.length,18);
 assert.equal(evaluated.filter(item=>item.gate==='BOOTSTRAP_CAPABLE_NOT_TERMINAL_E2E').length,10);
 assert.equal(evaluated.filter(item=>item.dispatchRejected===true).length,4);
 const output=process.env.RELAY_L4_OUTPUT_DIR;
 if(output){
   const {mkdir}=await import('node:fs/promises');
   await mkdir(output,{recursive:true,mode:0o700});
   await writeFile(join(output,'matrix.json'),JSON.stringify({schema:'relay.l4.prompt-evals.v1',rows:evaluated},null,2)+'\n',{mode:0o600});
 }
});
