import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildPlannerExecutionPrompt } from '../dist/planner.js';
import { resolveExecutionContext } from '../dist/execution-context.js';
const exec = promisify(execFile);

test('prompt CLI prints exact production Planner Builder text for all three adapters using durable plan identity', async () => {
  const dir = await mkdtemp(join(tmpdir(),'relay-prompt-cli-'));
  try {
    const project=resolve('.'), now='2026-10-31T18:00:00.000Z', executionId='123e4567-e89b-12d3-a456-426614174000';
    const plan={jobId:'537',id:'plan-2',round:2,source:'model-planner',previousPlanId:'plan-1',trigger:{source:'manual'},status:'SUCCEEDED',assessment:'Completed',generatedTaskIds:['473'],createdAt:now,updatedAt:now,appliedExecutionId:executionId};
    const job={id:'537',repository:'lalalic/neo',prNumber:0,state:'ACTIVE',title:'Vlog',objective:'Build a test Vlog episode',projectPath:'vlog',
      createdAt:'2026-10-31T17:00:00Z',updatedAt:now,continuation:{},plans:[plan],
      tasks:[{id:'473',jobId:'537',kind:'work',createdAt:'2026-10-31T18:05:00.000Z',state:'SUCCEEDED'}]};
    const file=join(dir,'job.json');await writeFile(file,JSON.stringify(job));
    const context=await resolveExecutionContext(project,'planner');
    const history={...job,tasks:[],plans:[{...plan,status:'PLANNING',executionId,appliedExecutionId:undefined,generatedTaskIds:[]}]};
    const planner={job:history,tasks:[],objective:job.objective,previousPlannerTaskId:'plan-1',planExecution:{planId:plan.id,executionId},trigger:plan.trigger,executionContext:context};
    for(const adapter of ['codex','chatgpt','z']){
      const {stdout,stderr}=await exec(process.execPath,['dist/cli.js','prompt','--file',file,'--id','537','--plan-id','plan-2','--project-path',project,'--adapter',adapter],{cwd:project,timeout:20_000});
      assert.equal(stdout.trimEnd(),await buildPlannerExecutionPrompt(planner,undefined,adapter));
      assert.match(stdout,/Job: 537\nTask: plan-2\nExecution: 123e4567/);
      assert.doesNotMatch(stdout,/PROFILE-JOB|PROFILE-PLAN|Job URL: null/);
      assert.match(stdout,/^# Role\nYou are planner/);
      assert.match(stdout,/## Contexts\nNone required at startup/);
      assert.doesNotMatch(stdout,/event-contract\.md|events-bus\/references\/protocol\.md/);
      assert.doesNotMatch(stdout,/\[project\].*AGENTS\.md/);
    }
    const {stderr}=await exec(process.execPath,['dist/cli.js','prompt','--file',file,'--id','537','--plan-id','plan-2','--project-path',project,'--adapter','codex'],{cwd:project,timeout:20_000});
    assert.ok(typeof stderr==='string');
  } finally {await rm(dir,{recursive:true,force:true});}
});
